//! Real-model notes probe on the fictional meeting fixtures. Ignored: it
//! needs the built text helper, the pinned weights and free memory, so run it
//! only through the build slot. Example:
//!
//! NOTES_PROBE_MODELS=<models root> NOTES_PROBE_MODEL=qwen3-1.7b-q4_k_m \
//! NOTES_PROBE_FIXTURE=planning-30min NOTES_PROBE_OUT=/tmp/probe.json \
//! bun scripts/cargo-sidecar.ts test --lib llm::notes_probe -- --ignored --nocapture
//!
//! It runs the production summary and action-item orchestration on the
//! built-in model and writes every helper request, its token counts and its
//! output (complete or not) next to the final notes.

use super::grounded::{GroundedOrchestrator, GroundedSegment, GroundingContext};
use super::transport::CompletionPurpose;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const GATE_SENTENCE: &str = "Plainsong footprint fixture. We agreed to ship the beta on the fourteenth if the memory gate passes, and Priya will review the notes.";

#[test]
fn public_word_rows_keep_grouping_and_aside_timestamps() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/evals/notes-fidelity-fixtures.json"
    ))
    .unwrap();
    for meeting in fixtures["meetings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|meeting| meeting.get("transcriptSegments").is_some())
    {
        let rows: Vec<crate::models::TranscriptSegment> =
            serde_json::from_value(meeting["transcriptSegments"].clone()).unwrap();
        let grouped = crate::analysis::group_transcript_segments_for_analysis("synthetic", &rows);
        let expected = meeting["segments"].as_array().unwrap();
        assert_eq!(grouped.len(), expected.len());
        for (actual, expected) in grouped.iter().zip(expected) {
            assert_eq!(actual.text, expected["text"].as_str().unwrap());
            assert_eq!(actual.start_time, expected["start"].as_f64().unwrap());
            assert_eq!(actual.end_time, expected["end"].as_f64().unwrap());
        }
        if let Some(ranges) = meeting["asideRanges"].as_array() {
            for range in ranges {
                let start = range["startTime"].as_f64().unwrap();
                let end = range["endTime"].as_f64().unwrap();
                // Edge-crossing ASR rows retain their original times. The
                // Light receipt has one word spanning the second silent aside.
                assert!(rows
                    .iter()
                    .all(|row| !(row.start_time >= start && row.end_time <= end)));
                let next = rows
                    .iter()
                    .find(|row| row.start_time >= end)
                    .expect("public words resume after the aside");
                assert!(grouped.iter().any(|group| {
                    group.start_time <= next.start_time
                        && group.end_time >= next.end_time
                        && group.text.contains(&next.text)
                }));
            }
        }
    }
}

#[test]
fn packaged_fixture_preserves_word_rows_and_expected_grouping() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../docs/evals/notes-fidelity-fixtures.json"
    ))
    .unwrap();
    let meeting = fixtures["meetings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|meeting| meeting["id"] == "packaged-b21-16gb")
        .unwrap();
    let rows: Vec<crate::models::TranscriptSegment> =
        serde_json::from_value(meeting["transcriptSegments"].clone()).unwrap();
    assert_eq!(rows.len(), 322);
    let grouped = crate::analysis::group_transcript_segments_for_analysis("synthetic", &rows);
    let expected = meeting["segments"].as_array().unwrap();
    assert_eq!(grouped.len(), expected.len());
    for (actual, expected) in grouped.iter().zip(expected) {
        assert_eq!(actual.text, expected["text"].as_str().unwrap());
        assert_eq!(actual.start_time, expected["start"].as_f64().unwrap());
        assert_eq!(actual.end_time, expected["end"].as_f64().unwrap());
    }
}

fn fixture_rows(id: &str) -> Vec<(f64, f64, Option<String>, String)> {
    if id == "gate-loop" {
        // The packaged memory gate plays one sentence on a loop for about two
        // minutes, transcribed without speaker names.
        return (0..15)
            .map(|index| {
                let start = index as f64 * 8.0;
                (start, start + 7.5, None, GATE_SENTENCE.to_string())
            })
            .collect();
    }
    let fixtures: serde_json::Value = match std::env::var("NOTES_PROBE_FIXTURES") {
        Ok(path) => serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap(),
        Err(_) => serde_json::from_str(include_str!(
            "../../../docs/evals/meeting-notes-fixtures.json"
        ))
        .unwrap(),
    };
    let meeting = fixtures["meetings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|meeting| meeting["id"] == id)
        .unwrap_or_else(|| panic!("unknown fixture {id}"));
    meeting["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["start"].as_f64().unwrap(),
                row["end"].as_f64().unwrap(),
                row["speaker"].as_str().map(str::to_string),
                row["text"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

// Use the Light queue's interval without resetting the simulated baseline.
async fn retry_memory_wait<T, F, Fut>(
    mut work: F,
    log: &Mutex<Vec<serde_json::Value>>,
) -> Result<T, super::transport::LlmError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, super::transport::LlmError>>,
{
    for attempt in 0..6 {
        let outcome = work().await;
        let Err(error) = &outcome else {
            return outcome;
        };
        if !super::native_text::is_memory_wait(error) {
            return outcome;
        }
        if let Some(conditions) = super::notes_window::PROBE_CONDITIONS
            .lock()
            .unwrap()
            .as_mut()
        {
            if conditions.idle_seconds == Some(0) {
                log.lock()
                    .unwrap()
                    .push(serde_json::json!({"stage": "Returned", "error": error.to_string()}));
                conditions.idle_seconds = Some(300);
            }
        }
        if attempt == 5 {
            return outcome;
        }
        log.lock()
            .unwrap()
            .push(serde_json::json!({"stage": "MemoryRetry", "attempt": attempt + 1}));
        super::native_text::end_job();
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    unreachable!()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the built helper, the pinned model and free memory"]
async fn native_notes_probe() {
    if std::env::var("NOTES_PROBE_AWAY").as_deref() == Ok("1") {
        super::speech_priority::as_background_text(native_notes_probe_inner()).await;
    } else {
        native_notes_probe_inner().await;
    }
}

async fn native_notes_probe_inner() {
    crate::memory_pressure::start_monitor();
    let away = std::env::var("NOTES_PROBE_AWAY").as_deref() == Ok("1");
    let simulate_return = std::env::var("NOTES_PROBE_RETURN").as_deref() == Ok("1");
    if away {
        *super::notes_window::PROBE_CONDITIONS.lock().unwrap() =
            Some(super::notes_window::Conditions {
                idle_seconds: Some(300),
                power: Some(super::notes_window::Power::Ac),
            });
    }
    let returned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let checkpoints = Arc::new(super::grounded::NotesCheckpoints::default());
    let root = PathBuf::from(std::env::var("NOTES_PROBE_MODELS").unwrap());
    let model = std::env::var("NOTES_PROBE_MODEL").unwrap();
    let fixture = std::env::var("NOTES_PROBE_FIXTURE").unwrap();
    let out = PathBuf::from(std::env::var("NOTES_PROBE_OUT").unwrap());
    let spec = super::native_text::spec_for_model(&model).unwrap();
    for entry in spec.artifacts {
        let path = root.join(spec.dir).join(entry.local_name);
        assert!(
            crate::download::verify_existing_model_in_process(&path, entry.sha256)
                .await
                .unwrap(),
            "{} does not match its pinned digest",
            path.display()
        );
    }

    let recording_id = fixture.clone();
    let rows = fixture_rows(&fixture);
    let mut transcript_rows: Vec<crate::models::TranscriptSegment> = rows
        .iter()
        .enumerate()
        .map(
            |(index, (start, end, speaker, text))| crate::models::TranscriptSegment {
                id: format!("s{index}"),
                start_time: *start,
                end_time: *end,
                text: text.clone(),
                speaker_id: speaker.as_ref().map(|name| format!("voice_{name}")),
                confidence: 1.0,
            },
        )
        .collect();
    if let Ok(path) = std::env::var("NOTES_PROBE_FIXTURES") {
        let fixtures: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let meeting = fixtures["meetings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|meeting| meeting["id"] == fixture)
            .unwrap();
        if let Some(segments) = meeting.get("transcriptSegments") {
            transcript_rows = serde_json::from_value(segments.clone()).unwrap();
        }
    }
    // An optional file lets qualification replay its fictional, word-level
    // rows without copying captured text into repository fixtures.
    if let Ok(path) = std::env::var("NOTES_PROBE_SEGMENTS") {
        transcript_rows = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    }
    let names: HashMap<String, String> = rows
        .iter()
        .filter_map(|(_, _, speaker, _)| speaker.clone())
        .map(|name| (format!("voice_{name}"), name))
        .collect();
    let segment_names: HashMap<(String, String), String> = transcript_rows
        .iter()
        .filter_map(|segment| {
            let name = names.get(segment.speaker_id.as_ref()?)?;
            Some(((recording_id.clone(), segment.id.clone()), name.clone()))
        })
        .collect();
    let segment_ids: HashMap<(String, String), String> = transcript_rows
        .iter()
        .filter_map(|segment| {
            Some((
                (recording_id.clone(), segment.id.clone()),
                segment.speaker_id.clone()?,
            ))
        })
        .collect();
    let segments: Vec<GroundedSegment> =
        crate::analysis::group_transcript_segments_for_analysis(&recording_id, &transcript_rows);
    let progress_log = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let started = Instant::now();
    let progress = {
        let log = Arc::clone(&progress_log);
        let returned = returned.clone();
        Arc::new(move |update: super::grounded::OrchestrationProgress| {
            if simulate_return
                && update.stage == super::grounded::OrchestrationStage::Mapping
                && update.completed >= 1
                && !returned.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    super::notes_window::PROBE_CONDITIONS
                        .lock()
                        .unwrap()
                        .as_mut()
                        .unwrap()
                        .idle_seconds = Some(0);
                });
            }
            log.lock().unwrap().push(serde_json::json!({
                "ms": started.elapsed().as_millis() as u64,
                "stage": format!("{:?}", update.stage),
                "completed": update.completed,
                "total": update.total,
                "pass": update.pass,
            }));
        })
    };
    let transport = super::native_text::NativeTextClient::new(root.clone());
    let instruction = crate::analysis::resolve_meeting_template_summary_instruction(None, &[]);

    let summary_context = GroundingContext::new(segments.clone())
        .unwrap()
        .with_segment_speakers(segment_names.clone())
        .with_segment_speaker_ids(segment_ids);
    let summary_started = Instant::now();
    let actions_only = std::env::var("NOTES_PROBE_ACTIONS_ONLY").as_deref() == Ok("1");
    let summary = if actions_only {
        Err(super::transport::LlmError::new(
            super::Provider::NativeText,
            super::transport::ErrorKind::Policy,
            "Summary not requested in actions-only probe",
        ))
    } else {
        let run = || async {
            GroundedOrchestrator::new(
                &transport,
                model.clone(),
                summary_context.clone(),
                crate::analysis::ANALYSIS_LOCAL_REQUEST_TIMEOUT,
                crate::analysis::ANALYSIS_LOCAL_JOB_TIMEOUT,
                super::grounded::OrchestrationOptions::default(),
            )
            .with_meeting_summary_coverage()
            .with_shared_meeting_facts()
            .with_progress_callback(progress.clone())
            .run_response(CompletionPurpose::Summary, &instruction, None)
            .await
        };
        if away {
            super::grounded::with_notes_checkpoints(
                checkpoints.clone(),
                super::speech_priority::as_background_text(retry_memory_wait(run, &progress_log)),
            )
            .await
        } else {
            run().await
        }
    };
    let summary_ms = summary_started.elapsed().as_millis() as u64;
    let summary_calls = super::native_text::PROBE_TRACE.lock().unwrap().len();

    let actions_started = Instant::now();
    let actions_work = || async {
        GroundedOrchestrator::new(
            &transport,
            model.clone(),
            GroundingContext::new(segments.clone()).unwrap(),
            crate::analysis::ANALYSIS_LOCAL_REQUEST_TIMEOUT,
            crate::analysis::ANALYSIS_LOCAL_JOB_TIMEOUT,
            super::grounded::OrchestrationOptions::default(),
        )
        .with_segment_speakers(segment_names.clone())
        .with_shared_meeting_facts()
        .with_progress_callback(progress.clone())
        .run_action_items(crate::analysis::ACTION_ITEMS_INSTRUCTION, None)
        .await
    };
    let actions = if away {
        super::grounded::with_notes_checkpoints(
            checkpoints.clone(),
            super::speech_priority::as_background_text(retry_memory_wait(
                actions_work,
                &progress_log,
            )),
        )
        .await
    } else {
        actions_work().await
    };
    let actions_ms = actions_started.elapsed().as_millis() as u64;
    super::native_text::end_job();

    let trace = std::mem::take(&mut *super::native_text::PROBE_TRACE.lock().unwrap());
    let report = serde_json::json!({
        "model": model,
        "fixture": fixture,
        "simulatedGb": std::env::var("PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB").ok(),
        "simulatedAvailableGb": std::env::var(crate::hardware_tier::SIMULATED_AVAILABLE_MEMORY_ENV).ok(),
        "awayWindow": away,
        "simulatedReturn": simulate_return,
        "summaryMs": summary_ms,
        "summarySkipped": actions_only,
        "actionsMs": actions_ms,
        "summaryCalls": summary_calls,
        "sourcePassages": crate::analysis::group_transcript_segments_for_analysis(&recording_id, &transcript_rows)
            .iter().map(|line| serde_json::json!({"text": line.text, "start": line.start_time, "end": line.end_time})).collect::<Vec<_>>(),
        "calls": trace.len(),
        "summary": match &summary {
            Ok(output) => serde_json::json!({
                "response": output.response,
                "verification": output.summary_verification,
                "diagnostics": output.summary_diagnostics,
                "grounded": output.grounded,
                "unverified": output.unverified_statements.len(),
                "unverifiedStatements": output.unverified_statements,
                "citations": output.citations,
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
        "actions": match &actions {
            Ok(output) => serde_json::json!({
                "grounded": output.grounded,
                "items": output.items.iter().map(|item| serde_json::json!({
                    "task": item.task, "assignee": item.assignee, "deadline": item.deadline,
                    "grounded": item.grounded, "citations": item.citations,
                })).collect::<Vec<_>>(),
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
        "progress": *progress_log.lock().unwrap(),
        "trace": trace,
    });
    std::fs::write(&out, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!(
        "probe fixture={} model={} summary={} ({} ms) actions={} ({} ms) calls={}",
        report["fixture"],
        report["model"],
        if summary.is_ok() { "ok" } else { "failed" },
        summary_ms,
        if actions.is_ok() { "ok" } else { "failed" },
        actions_ms,
        report["calls"],
    );
    *super::notes_window::PROBE_CONDITIONS.lock().unwrap() = None;
    crate::shutdown_for_sidecar().await;
}

/// Retry a stage refused by native memory admission. The reserve is never
/// lowered; the probe only waits for the host to free memory.
async fn admitted<T, F, Fut>(
    mut work: F,
    retries: &mut u32,
) -> Result<T, super::transport::LlmError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, super::transport::LlmError>>,
{
    loop {
        let outcome = work().await;
        match &outcome {
            Err(error) if super::native_text::is_memory_wait(error) && *retries < 60 => {
                *retries += 1;
                super::native_text::end_job();
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
            _ => return outcome,
        }
    }
}

/// One variant through the production summary and action orchestration, as
/// `native_notes_probe` runs a fixture. Returns the receipt without a trace.
async fn run_variant(
    transport: &dyn super::transport::CompletionTransport,
    model: &str,
    variant: &serde_json::Value,
) -> serde_json::Value {
    let id = variant["id"].as_str().unwrap();
    let recording_id = variant["fixture"].as_str().unwrap().to_string();
    let rows: Vec<crate::models::TranscriptSegment> =
        serde_json::from_value(variant["transcriptSegments"].clone()).unwrap();
    let names: HashMap<String, String> =
        serde_json::from_value(variant["speakerNames"].clone()).unwrap();
    let segment_names: HashMap<(String, String), String> = rows
        .iter()
        .filter_map(|row| {
            let name = names.get(row.speaker_id.as_ref()?)?;
            Some(((recording_id.clone(), row.id.clone()), name.clone()))
        })
        .collect();
    let segment_ids: HashMap<(String, String), String> = rows
        .iter()
        .filter_map(|row| {
            Some((
                (recording_id.clone(), row.id.clone()),
                row.speaker_id.clone()?,
            ))
        })
        .collect();
    let segments: Vec<GroundedSegment> =
        crate::analysis::group_transcript_segments_for_analysis(&recording_id, &rows);
    let instruction = crate::analysis::resolve_meeting_template_summary_instruction(None, &[]);
    let mut retries = 0;
    let summary_context = GroundingContext::new(segments.clone())
        .unwrap()
        .with_segment_speakers(segment_names.clone())
        .with_segment_speaker_ids(segment_ids);
    let summary_started = Instant::now();
    // The same routing as `analysis::summarize_recording_grounded_typed` and
    // `run_grounded_action_items_for_segments`.
    let prose = crate::analysis::PROSE_RECAP_ENABLED;
    let summary = admitted(
        || async {
            let orchestrator = GroundedOrchestrator::new(
                transport,
                model.to_string(),
                summary_context.clone(),
                crate::analysis::ANALYSIS_LOCAL_REQUEST_TIMEOUT,
                crate::analysis::ANALYSIS_LOCAL_JOB_TIMEOUT,
                super::grounded::OrchestrationOptions::default(),
            );
            if prose {
                orchestrator
                    .with_meeting_summary_coverage()
                    .with_shared_meeting_facts()
                    .run_response(CompletionPurpose::Summary, &instruction, None)
                    .await
            } else {
                orchestrator
                    .run_extractive_recap(crate::analysis::extractive_recap_focus(&instruction))
                    .await
            }
        },
        &mut retries,
    )
    .await;
    let summary_ms = summary_started.elapsed().as_millis() as u64;
    let summary_calls = super::native_text::PROBE_TRACE.lock().unwrap().len();
    let actions_started = Instant::now();
    let actions = if prose {
        admitted(
            || async {
                GroundedOrchestrator::new(
                    transport,
                    model.to_string(),
                    GroundingContext::new(segments.clone()).unwrap(),
                    crate::analysis::ANALYSIS_LOCAL_REQUEST_TIMEOUT,
                    crate::analysis::ANALYSIS_LOCAL_JOB_TIMEOUT,
                    super::grounded::OrchestrationOptions::default(),
                )
                .with_segment_speakers(segment_names.clone())
                .with_shared_meeting_facts()
                .run_action_items(crate::analysis::ACTION_ITEMS_INSTRUCTION, None)
                .await
            },
            &mut retries,
        )
        .await
    } else {
        Ok(super::grounded::extractive_action_items(&summary_context))
    };
    let actions_ms = actions_started.elapsed().as_millis() as u64;
    serde_json::json!({
        "model": model,
        "fixture": recording_id,
        "variant": id,
        "transforms": variant["transforms"],
        "simulatedGb": std::env::var("PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB").ok(),
        "admissionRetries": retries,
        "summaryMs": summary_ms,
        "actionsMs": actions_ms,
        "summaryCalls": summary_calls,
        "sourcePassages": segments.iter().map(|line| serde_json::json!({"text": line.text, "start": line.start_time, "end": line.end_time})).collect::<Vec<_>>(),
        "summary": match &summary {
            Ok(output) => serde_json::json!({
                "response": output.response,
                "verification": output.summary_verification,
                "diagnostics": output.summary_diagnostics,
                "grounded": output.grounded,
                "citations": output.citations,
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
        "actions": match &actions {
            Ok(output) => serde_json::json!({
                "grounded": output.grounded,
                "items": output.items.iter().map(|item| serde_json::json!({
                    "task": item.task, "assignee": item.assignee, "deadline": item.deadline,
                    "evidence": item.evidence, "unclear": item.unclear,
                    "grounded": item.grounded, "citations": item.citations,
                })).collect::<Vec<_>>(),
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
    })
}

fn write_receipt(out: &std::path::Path, report: &serde_json::Value) {
    let partial = out.with_extension("partial");
    std::fs::write(&partial, serde_json::to_vec_pretty(report).unwrap()).unwrap();
    std::fs::rename(&partial, out).unwrap();
}

/// Batch probe for `scripts/evaluate-notes-variants.py`. Each variant runs in
/// this one process and writes one receipt. Existing receipts are kept.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the built helper, the pinned model and free memory"]
async fn native_notes_variant_probe() {
    crate::memory_pressure::start_monitor();
    let root = PathBuf::from(std::env::var("NOTES_PROBE_MODELS").unwrap());
    let model = std::env::var("NOTES_PROBE_MODEL").unwrap();
    let out_dir = PathBuf::from(std::env::var("NOTES_PROBE_OUT_DIR").unwrap());
    let variants: serde_json::Value = serde_json::from_slice(
        &std::fs::read(std::env::var("NOTES_PROBE_VARIANTS").unwrap()).unwrap(),
    )
    .unwrap();
    let spec = super::native_text::spec_for_model(&model).unwrap();
    for entry in spec.artifacts {
        let path = root.join(spec.dir).join(entry.local_name);
        assert!(
            crate::download::verify_existing_model_in_process(&path, entry.sha256)
                .await
                .unwrap(),
            "{} does not match its pinned digest",
            path.display()
        );
    }
    let transport = super::native_text::NativeTextClient::new(root.clone());
    for variant in variants["variants"].as_array().unwrap() {
        let id = variant["id"].as_str().unwrap();
        let out = out_dir.join(format!("{model}--{id}.json"));
        if out.exists() {
            continue;
        }
        super::native_text::PROBE_TRACE.lock().unwrap().clear();
        let mut report = run_variant(&transport, &model, variant).await;
        report["trace"] = serde_json::Value::Array(std::mem::take(
            &mut *super::native_text::PROBE_TRACE.lock().unwrap(),
        ));
        write_receipt(&out, &report);
        println!(
            "variant={id} model={model} summary={} ({} ms) actions={} ({} ms) retries={}",
            if report["summary"].get("error").is_none() {
                "ok"
            } else {
                "failed"
            },
            report["summaryMs"],
            if report["actions"].get("error").is_none() {
                "ok"
            } else {
                "failed"
            },
            report["actionsMs"],
            report["admissionRetries"],
        );
    }
    super::native_text::end_job();
    crate::shutdown_for_sidecar().await;
}

/// Returns recorded native responses for identical prompts, in order.
struct ReplayTransport {
    responses: Mutex<HashMap<String, std::collections::VecDeque<String>>>,
    misses: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl super::transport::CompletionTransport for ReplayTransport {
    fn provider(&self) -> super::Provider {
        super::Provider::NativeText
    }

    async fn complete(
        &self,
        request: &super::transport::CompletionRequest,
    ) -> Result<super::transport::CompletionResponse, super::transport::LlmError> {
        let text = self
            .responses
            .lock()
            .unwrap()
            .get_mut(&request.prompt)
            .and_then(std::collections::VecDeque::pop_front);
        match text {
            Some(text) => Ok(super::transport::CompletionResponse {
                text,
                model: request.model.clone(),
            }),
            None => {
                self.misses
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(super::transport::LlmError::new(
                    super::Provider::NativeText,
                    super::transport::ErrorKind::Transport,
                    "replay has no recorded response for this prompt",
                ))
            }
        }
    }
}

/// Deterministic replay of native variant receipts through the current
/// verifier: identical prompts get their recorded model output. A prompt the
/// native run never made counts as a miss, so that receipt needs a native run.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs native variant receipts"]
async fn native_notes_variant_replay() {
    let receipts = PathBuf::from(std::env::var("NOTES_REPLAY_RECEIPTS").unwrap());
    let out_dir = PathBuf::from(std::env::var("NOTES_REPLAY_OUT").unwrap());
    let variants: serde_json::Value =
        serde_json::from_slice(&std::fs::read(receipts.join("variants.json")).unwrap()).unwrap();
    std::fs::create_dir_all(&out_dir).unwrap();
    for variant in variants["variants"].as_array().unwrap() {
        let id = variant["id"].as_str().unwrap();
        for model in ["qwen3-1.7b-q4_k_m", "qwen3-4b-instruct-2507-q4_k_m"] {
            let path = receipts.join(format!("{model}--{id}.json"));
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let recorded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let mut responses = HashMap::<String, std::collections::VecDeque<String>>::new();
            for call in recorded["trace"].as_array().into_iter().flatten() {
                responses
                    .entry(call["user"].as_str().unwrap().to_string())
                    .or_default()
                    .push_back(call["text"].as_str().unwrap_or_default().to_string());
            }
            let transport = ReplayTransport {
                responses: Mutex::new(responses),
                misses: Default::default(),
            };
            let mut report = run_variant(&transport, model, variant).await;
            report["replayOf"] = serde_json::json!(path.file_name().unwrap().to_string_lossy());
            report["replayMisses"] =
                serde_json::json!(transport.misses.load(std::sync::atomic::Ordering::SeqCst));
            write_receipt(&out_dir.join(format!("{model}--{id}.json")), &report);
        }
    }
}

/// Source-side coverage without a model: every variant's parsed commitments,
/// the recap sentences and actions coverage would state from them alone.
#[test]
#[ignore = "needs a generated variants file"]
fn variant_frames_dump() {
    let variants: serde_json::Value =
        serde_json::from_slice(&std::fs::read(std::env::var("NOTES_VARIANTS").unwrap()).unwrap())
            .unwrap();
    let mut out = Vec::new();
    for variant in variants["variants"].as_array().unwrap() {
        let recording_id = variant["fixture"].as_str().unwrap().to_string();
        let rows: Vec<crate::models::TranscriptSegment> =
            serde_json::from_value(variant["transcriptSegments"].clone()).unwrap();
        let names: HashMap<String, String> =
            serde_json::from_value(variant["speakerNames"].clone()).unwrap();
        let segment_names: HashMap<(String, String), String> = rows
            .iter()
            .filter_map(|row| {
                let name = names.get(row.speaker_id.as_ref()?)?;
                Some(((recording_id.clone(), row.id.clone()), name.clone()))
            })
            .collect();
        let segments =
            crate::analysis::group_transcript_segments_for_analysis(&recording_id, &rows);
        let context = GroundingContext::new(segments)
            .unwrap()
            .with_segment_speakers(segment_names);
        let frames = super::commitment_frames::source_frames(context.lines());
        out.push(serde_json::json!({
            "variant": variant["id"],
            "fixture": recording_id,
            "frames": super::commitment_frames::debug_frames(&frames),
            "prose": frames.iter().filter(|f| super::commitment_frames::key_decision(f)).filter_map(super::commitment_frames::prose).collect::<Vec<_>>(),
            "actions": frames.iter().filter(|f| super::commitment_frames::templatable(f)).filter_map(|f| super::commitment_frames::action(f).map(|(task, deadline)| serde_json::json!({"task": task, "assignee": f.owner, "deadline": deadline}))).collect::<Vec<_>>(),
        }));
    }
    std::fs::write(
        std::env::var("NOTES_DUMP_OUT").unwrap(),
        serde_json::to_vec_pretty(&out).unwrap(),
    )
    .unwrap();
}

fn variant_context(variant: &serde_json::Value) -> GroundingContext {
    let recording_id = variant["fixture"].as_str().unwrap().to_string();
    let rows: Vec<crate::models::TranscriptSegment> =
        serde_json::from_value(variant["transcriptSegments"].clone()).unwrap();
    let names: HashMap<String, String> =
        serde_json::from_value(variant["speakerNames"].clone()).unwrap();
    let segment_names: HashMap<(String, String), String> = rows
        .iter()
        .filter_map(|row| {
            let name = names.get(row.speaker_id.as_ref()?)?;
            Some(((recording_id.clone(), row.id.clone()), name.clone()))
        })
        .collect();
    let segment_ids: HashMap<(String, String), String> = rows
        .iter()
        .filter_map(|row| {
            Some((
                (recording_id.clone(), row.id.clone()),
                row.speaker_id.clone()?,
            ))
        })
        .collect();
    let segments = crate::analysis::group_transcript_segments_for_analysis(&recording_id, &rows);
    // The same context `run_variant` gives the recap: names and speaker IDs.
    GroundingContext::new(segments)
        .unwrap()
        .with_segment_speakers(segment_names)
        .with_segment_speaker_ids(segment_ids)
}

/// What an extractive recap shows before any model pick, for every variant,
/// written as scorer receipts (model `source-only`). Every shown string is
/// checked against the transcript; only counts are printed, so a blind set
/// can be checked without reading it.
#[test]
#[ignore = "needs a generated variants file"]
fn variant_extractive_dump() {
    let variants: serde_json::Value =
        serde_json::from_slice(&std::fs::read(std::env::var("NOTES_VARIANTS").unwrap()).unwrap())
            .unwrap();
    let out_dir = PathBuf::from(std::env::var("NOTES_DUMP_DIR").unwrap());
    std::fs::create_dir_all(&out_dir).unwrap();
    let (mut quotes, mut actions, mut problems) = (0usize, 0usize, 0usize);
    for variant in variants["variants"].as_array().unwrap() {
        let context = variant_context(variant);
        let source = super::extractive_recap::parse(context.lines());
        let recap = super::extractive_recap::render(&source, &Default::default());
        let items = super::extractive_recap::action_items(&source);
        let mut found = super::extractive_recap::recap_problems(context.lines(), &source, &recap);
        for item in &items {
            found.extend(super::extractive_recap::action_problems(
                context.lines(),
                item,
            ));
        }
        quotes += recap.quoted.len();
        actions += items.len();
        problems += found.len();
        if std::env::var("NOTES_PROOF_VERBOSE").is_ok() && !found.is_empty() {
            println!("{}: {found:#?}", variant["id"]);
        }
        let id = variant["id"].as_str().unwrap();
        write_receipt(
            &out_dir.join(format!("source-only--{id}.json")),
            &serde_json::json!({
                "model": "source-only",
                "fixture": variant["fixture"],
                "variant": id,
                "summary": {"response": recap.markdown},
                "actions": {"items": items.iter().map(|item| serde_json::json!({
                    "task": item.task, "assignee": item.assignee, "deadline": item.deadline,
                    "evidence": item.evidence, "unclear": item.unclear,
                })).collect::<Vec<_>>()},
                "proofProblems": found.len(),
            }),
        );
    }
    println!(
        "variants={} quotes={quotes} actions={actions} proofProblems={problems}",
        variants["variants"].as_array().unwrap().len()
    );
    assert_eq!(problems, 0);
}

/// Parsed frames, units and the source-only recap for lines given as
/// "Speaker|text" in NOTES_DEBUG_LINES, one per line. For diagnosis.
#[test]
#[ignore = "diagnostic"]
fn extractive_debug_lines() {
    // NOTES_DEBUG_VARIANT=<id> with NOTES_VARIANTS reads one generated
    // variant through the same context the dumps use.
    if let Ok(id) = std::env::var("NOTES_DEBUG_VARIANT") {
        let variants: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var("NOTES_VARIANTS").unwrap()).unwrap(),
        )
        .unwrap();
        let variant = variants["variants"]
            .as_array()
            .unwrap()
            .iter()
            .find(|variant| variant["id"] == id.as_str())
            .unwrap();
        let context = variant_context(variant);
        let source = super::extractive_recap::parse(context.lines());
        for line in super::extractive_recap::debug_source(&source) {
            println!("{line}");
        }
        println!(
            "{}",
            super::extractive_recap::render(&source, &Default::default()).markdown
        );
        return;
    }
    let text = std::fs::read_to_string(std::env::var("NOTES_DEBUG_LINES").unwrap()).unwrap();
    let lines: Vec<super::grounded::TrustedLine> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, row)| {
            let (speaker, body) = row.split_once('|').unwrap_or(("", row));
            super::grounded::TrustedLine {
                written_note: false,
                speaker_name: (!speaker.is_empty()).then(|| speaker.to_string()),
                speaker_id: (!speaker.is_empty()).then(|| format!("voice_{speaker}")),
                line_id: format!("L{}", index + 1),
                recording_id: "debug".into(),
                segment_id: format!("s{index}"),
                text: body.to_string(),
                start_time: index as f64 * 10.0,
                end_time: index as f64 * 10.0 + 8.0,
            }
        })
        .collect();
    let (frames, units) = super::commitment_frames::source_frames_and_units(&lines);
    for (frame, debug) in frames
        .iter()
        .zip(super::commitment_frames::debug_frames(&frames))
    {
        let mut keys: Vec<_> = debug.into_iter().collect();
        keys.sort();
        println!(
            "FRAME unit={} extra={:?} retracted={} templatable={} {keys:?}",
            frame.unit,
            frame.extra_units,
            frame.retracted,
            super::commitment_frames::templatable(frame)
        );
    }
    for (at, unit) in units.iter().enumerate() {
        println!(
            "UNIT {at} {:?} revises={} {}",
            unit.speaker, unit.revises, unit.text
        );
    }
    let source = super::extractive_recap::parse(&lines);
    println!(
        "{}",
        super::extractive_recap::render(&source, &Default::default()).markdown
    );
    for item in super::extractive_recap::action_items(&source) {
        println!(
            "ACTION {:?} | {:?} | {:?}",
            item.task, item.assignee, item.deadline
        );
    }
}

/// The same proof over delivered native receipts. Each receipt's recorded
/// model picks are rendered again from the variant's source; the delivered
/// recap and action items must match that rendering exactly, and the
/// rendering must pass the source proof. Prints counts and receipt names
/// only, so a blind set can be checked without reading it.
#[test]
#[ignore = "needs native variant receipts"]
fn native_receipts_proof() {
    let receipts = PathBuf::from(std::env::var("NOTES_RECEIPTS").unwrap());
    let variants: serde_json::Value =
        serde_json::from_slice(&std::fs::read(receipts.join("variants.json")).unwrap()).unwrap();
    let (mut checked, mut quotes, mut problems) = (0usize, 0usize, 0usize);
    let mut mismatched: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for variant in variants["variants"].as_array().unwrap() {
        let id = variant["id"].as_str().unwrap();
        let context = variant_context(variant);
        let source = super::extractive_recap::parse(context.lines());
        for model in ["qwen3-1.7b-q4_k_m", "qwen3-4b-instruct-2507-q4_k_m"] {
            let Ok(bytes) = std::fs::read(receipts.join(format!("{model}--{id}.json"))) else {
                continue;
            };
            let receipt: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            checked += 1;
            let mut selection = super::extractive_recap::Selection::default();
            for call in receipt["trace"].as_array().into_iter().flatten() {
                // The sentences this call offered, from its own prompt rows.
                let chunk: Vec<usize> = call["user"]
                    .as_str()
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|row| {
                        row.strip_prefix('S')?
                            .split('\t')
                            .next()?
                            .parse::<usize>()
                            .ok()
                    })
                    .filter_map(|number| number.checked_sub(1))
                    .collect();
                if let Some(part) = super::extractive_recap::parse_selection(
                    call["text"].as_str().unwrap_or_default(),
                    &chunk,
                ) {
                    selection.extend(part);
                }
            }
            let recap = super::extractive_recap::render(&source, &selection);
            let items = super::extractive_recap::action_items(&source);
            type Shown<'a> = (
                Option<&'a str>,
                Option<&'a str>,
                Option<&'a str>,
                Option<&'a str>,
                bool,
            );
            let delivered_items: Vec<Shown> = receipt["actions"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    (
                        item["task"].as_str(),
                        item["assignee"].as_str(),
                        item["deadline"].as_str(),
                        item["evidence"].as_str(),
                        item["unclear"].as_bool().unwrap_or(false),
                    )
                })
                .collect();
            let rendered_items: Vec<Shown> = items
                .iter()
                .map(|item| {
                    (
                        Some(item.task.as_str()),
                        item.assignee.as_deref(),
                        item.deadline.as_deref(),
                        Some(item.evidence.as_str()),
                        item.unclear,
                    )
                })
                .collect();
            if receipt["summary"]["response"].as_str() != Some(recap.markdown.as_str())
                || delivered_items != rendered_items
            {
                mismatched.push(format!("{model}--{id}"));
                if std::env::var("NOTES_PROOF_VERBOSE").is_ok() {
                    println!(
                        "MISMATCH {model}--{id}\n--- delivered\n{}\n--- rendered\n{}\n--- items\n{delivered_items:?}\n{rendered_items:?}",
                        receipt["summary"]["response"].as_str().unwrap_or_default(),
                        recap.markdown
                    );
                }
                continue;
            }
            let mut found =
                super::extractive_recap::recap_problems(context.lines(), &source, &recap);
            for item in &items {
                found.extend(super::extractive_recap::action_problems(
                    context.lines(),
                    item,
                ));
            }
            quotes += recap.quoted.len();
            problems += found.len();
            if !found.is_empty() {
                failed.push(format!("{model}--{id}"));
                if std::env::var("NOTES_PROOF_VERBOSE").is_ok() {
                    println!("{model}--{id}: {found:#?}");
                }
            }
        }
    }
    println!(
        "receipts={checked} quotes={quotes} mismatched={} proofProblems={problems} mismatchedReceipts={mismatched:?} failingReceipts={failed:?}",
        mismatched.len()
    );
    assert!(mismatched.is_empty() && problems == 0);
}

/// Deterministic claim checks without a model: every claim in a corpus file
/// ({"cases": [{variant, claims}]} plus the variants file) is run through the
/// commitment, qualifier and source-structure checks.
#[test]
#[ignore = "needs a claim corpus"]
fn claim_corpus_check() {
    let variants: serde_json::Value =
        serde_json::from_slice(&std::fs::read(std::env::var("NOTES_VARIANTS").unwrap()).unwrap())
            .unwrap();
    let corpus: serde_json::Value =
        serde_json::from_slice(&std::fs::read(std::env::var("NOTES_CLAIMS_IN").unwrap()).unwrap())
            .unwrap();
    let by_id: HashMap<&str, &serde_json::Value> = variants["variants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|variant| (variant["id"].as_str().unwrap(), variant))
        .collect();
    let mut out = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        let variant = by_id[case["variant"].as_str().unwrap()];
        let recording_id = variant["fixture"].as_str().unwrap().to_string();
        let rows: Vec<crate::models::TranscriptSegment> =
            serde_json::from_value(variant["transcriptSegments"].clone()).unwrap();
        let names: HashMap<String, String> =
            serde_json::from_value(variant["speakerNames"].clone()).unwrap();
        let segment_names: HashMap<(String, String), String> = rows
            .iter()
            .filter_map(|row| {
                let name = names.get(row.speaker_id.as_ref()?)?;
                Some(((recording_id.clone(), row.id.clone()), name.clone()))
            })
            .collect();
        let segments =
            crate::analysis::group_transcript_segments_for_analysis(&recording_id, &rows);
        let context = GroundingContext::new(segments)
            .unwrap()
            .with_segment_speakers(segment_names);
        let frames = super::commitment_frames::source_frames(context.lines());
        let names = super::commitment_frames::frame_names(&frames, context.lines());
        let claims = super::source_claims::SourceClaims::new(context.lines(), &frames, &names);
        let results: Vec<serde_json::Value> = case["claims"]
            .as_array()
            .unwrap()
            .iter()
            .map(|claim| {
                // An action item is checked as the claim it makes.
                let text = match claim.as_str() {
                    Some(text) => text.to_string(),
                    None => super::commitment_frames::action_claim(
                        &super::grounded::GroundedActionItemOutput {
                            task: claim["task"].as_str().unwrap_or_default().to_string(),
                            assignee: claim["assignee"].as_str().map(str::to_string),
                            deadline: claim["deadline"].as_str().map(str::to_string),
                            citations: Vec::new(),
                            grounded: true,
                            evidence: None,
                            unclear: false,
                        },
                    ),
                };
                let text = text.as_str();
                serde_json::json!({
                    "text": text,
                    "frames": super::commitment_frames::claim_violation(text, &frames, &names),
                    "qualifier": super::commitment_frames::qualifier_violation(text, context.lines()),
                    "source": claims.violation(text),
                })
            })
            .collect();
        let mut entry = serde_json::json!({"variant": case["variant"], "results": results});
        if std::env::var("NOTES_CLAIMS_DEBUG").is_ok() {
            entry["frames"] = serde_json::json!(super::commitment_frames::debug_frames(&frames));
            entry["source"] = claims.debug();
            entry["lines"] = serde_json::json!(context
                .lines()
                .iter()
                .map(|line| format!("{:?}: {}", line.speaker_name, line.text))
                .collect::<Vec<_>>());
        }
        out.push(entry);
    }
    std::fs::write(
        std::env::var("NOTES_CLAIMS_OUT").unwrap(),
        serde_json::to_vec_pretty(&out).unwrap(),
    )
    .unwrap();
}
