//! Opt-in CPU helper measurements, never part of the default test run.
//! Run alone in a build slot with PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8,
//! PLAINSONG_RESIDENCY_PROBE_OUT=<jsonl>, and PLAINSONG_RESIDENCY_PROBE_MODE
//! set to `micro` or `idle`. Idle also requires PLAINSONG_RESIDENCY_PROBE_ARM
//! set to `before` or `after`; run those arms separately so retained models
//! cannot warm the released arm's shared caches. The old Light auto policy
//! is replayed as explicit 2m. Each deadline has a separate helper, with loads
//! and decodes serialized through native admission. Model files are verified
//! and opened read-only. No recording or insertion.

use super::*;
use crate::asr::speech_residency::{self, ReleasePolicy};
use serde_json::{json, Value};
use std::fs::File;

fn memory(pid: u32) -> Value {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: the kernel writes the requested version into a matching buffer.
    assert_eq!(
        unsafe {
            libc::proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V4,
                info.as_mut_ptr().cast(),
            )
        },
        0
    );
    // SAFETY: proc_pid_rusage succeeded.
    let info = unsafe { info.assume_init() };
    json!({"pid": pid, "resident_bytes": info.ri_resident_size, "footprint_bytes": info.ri_phys_footprint,
        "wired_bytes": info.ri_wired_size, "peak_footprint_bytes": info.ri_lifetime_max_phys_footprint,
        "cpu_ticks": info.ri_user_time + info.ri_system_time})
}

fn emit(out: &mut File, row: Value) {
    writeln!(out, "{row}").unwrap();
    out.flush().unwrap();
    eprintln!("{row}");
}

fn decode(slot: &mut Option<HelperProcess>, root: &Path, samples: &[f32]) -> Value {
    // The same load/decode allowances and native admission as production.
    let _admission = crate::llm::local_model_load::admit_neural_engine_decode(
        if slot.is_some() {
            RESIDENT_DECODE_ALLOWANCE
        } else {
            CPU_ONLY_COLD_LOAD_ALLOWANCE
        } + samples.len() as u64 * 16,
        slot.is_some(),
    )
    .expect("native admission must verify current headroom");
    let started = Instant::now();
    let mut load_ms = None;
    if slot.is_none() {
        let mut helper = spawn_helper().unwrap();
        let response = request(
            &mut helper,
            &load_request(
                &PARAKEET_V3_COREML.dir(root),
                &PARAKEET_V3_COREML,
                ComputeUnits::CpuOnly,
            ),
            &[],
            LOAD_TIMEOUT,
        )
        .unwrap();
        load_ms = Some(response["loadMs"].as_u64().expect("helper load time"));
        helper.loaded = Some(LoadedModel {
            dir: PARAKEET_V3_COREML.dir(root),
            units: ComputeUnits::CpuOnly,
        });
        *slot = Some(helper);
    }
    let helper = slot.as_mut().unwrap();
    let payload: Vec<u8> = samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    let decode_started = Instant::now();
    let response = request(
        helper,
        &json!({"op":"transcribe", "sampleCount":samples.len()}),
        &payload,
        Duration::from_secs(30),
    )
    .unwrap();
    let decode_ms = decode_started.elapsed().as_secs_f64() * 1000.0;
    let transcript = parse_transcript(&response).unwrap();
    assert!(
        !transcript.text.trim().is_empty(),
        "real speech must produce text"
    );
    helper.last_used = Instant::now();
    json!({"load_ms": load_ms, "decode_ms": decode_ms, "total_ms":started.elapsed().as_secs_f64()*1000.0,
        "transcript":transcript.text, "memory":memory(helper.child.id())})
}

#[test]
#[ignore = "loads real models and waits up to 30 minutes; run alone through native admission in a build slot"]
fn cpu_residency_probe() {
    assert_eq!(
        crate::hardware_tier::current(),
        crate::hardware_tier::HardwareTier::Light
    );
    assert!(crate::memory_pressure::start_monitor());
    assert_eq!(
        crate::memory_pressure::events().current(),
        crate::memory_pressure::MemoryPressure::Normal
    );
    let out_path =
        std::env::var("PLAINSONG_RESIDENCY_PROBE_OUT").expect("explicit output path required");
    let mode = std::env::var("PLAINSONG_RESIDENCY_PROBE_MODE").expect("micro or idle required");
    let only_arm = std::env::var("PLAINSONG_RESIDENCY_PROBE_ARM").ok();
    let mut out = File::create(out_path).unwrap();
    let root = Path::new(&std::env::var("HOME").unwrap()).join("Library/Caches/PlainsongQA/models");
    let verified = verify_spec_files(&root, &PARAKEET_V3_COREML).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("scripts/fixtures/real-speech-44s.wav");
    let mut wav = hound::WavReader::open(&fixture).unwrap();
    assert_eq!(wav.spec().sample_rate, 16_000);
    assert_eq!(wav.spec().channels, 1);
    let samples: Vec<f32> = wav
        .samples::<i16>()
        .take(160_000)
        .map(|s| s.unwrap() as f32 / 32768.0)
        .collect();
    emit(
        &mut out,
        json!({"phase":"identity", "mode":mode, "arm":only_arm, "fixture":fixture, "helper":resolve_helper().unwrap(),
        "route":"coreml_cpu", "simulated_gb":8, "scope":"native helper load and decode, no app capture/format/insertion",
        "host":String::from_utf8(Command::new("uptime").output().unwrap().stdout).unwrap()}),
    );
    if mode == "micro" {
        let mut slot = None;
        for seconds in [2, 10] {
            let audio = &samples[..seconds * 16_000];
            let seed = decode(&mut slot, &root, audio);
            let expected = seed["transcript"].clone();
            emit(
                &mut out,
                json!({"phase":"seed", "seconds":seconds, "result":seed}),
            );
            for run in 0..5 {
                let order = if run % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                };
                for released in order {
                    if released {
                        slot.take();
                    }
                    let result = decode(&mut slot, &root, audio);
                    assert_eq!(
                        result["transcript"], expected,
                        "reload must preserve the exact transcript"
                    );
                    emit(
                        &mut out,
                        json!({"phase":"micro", "seconds":seconds, "run":run+1, "released":released, "result":result}),
                    );
                }
            }
            for sample in 0..5 {
                std::thread::sleep(Duration::from_secs(2));
                emit(
                    &mut out,
                    json!({"phase":"idle_loaded", "seconds":seconds, "sample":sample, "memory":memory(slot.as_ref().unwrap().child.id())}),
                );
            }
        }
    } else if mode == "idle" {
        let only_arm = only_arm
            .as_deref()
            .expect("run before and after arms separately");
        assert!(matches!(only_arm, "before" | "after"));
        struct Window {
            arm: &'static str,
            seconds: u64,
            slot: Option<HelperProcess>,
            last: Instant,
            policy: ReleasePolicy,
            done: bool,
        }
        let mut windows = Vec::new();
        for seconds in [300, 600, 1800] {
            for (arm, setting) in [("before", "2m"), ("after", "auto")] {
                if arm != only_arm {
                    continue;
                }
                speech_residency::set_keep_ready(setting);
                let policy = ReleasePolicy::current(crate::memory_pressure::MemoryPressure::Normal);
                let mut slot = None;
                let result = decode(&mut slot, &root, &samples);
                let last = slot.as_ref().unwrap().last_used;
                emit(
                    &mut out,
                    json!({"phase":"idle_seed", "arm":arm, "idle_seconds":seconds, "result":result}),
                );
                windows.push(Window {
                    arm,
                    seconds,
                    slot,
                    last,
                    policy,
                    done: false,
                });
            }
        }
        speech_residency::set_keep_ready("auto");
        let mut sampled_at = Instant::now();
        while windows.iter().any(|w| !w.done) {
            let pressure = crate::memory_pressure::events().current();
            assert_eq!(
                pressure,
                crate::memory_pressure::MemoryPressure::Normal,
                "pressure changed; abort rather than mislabel the idle comparison"
            );
            for window in &mut windows {
                if window.done {
                    continue;
                }
                let idle = window.last.elapsed();
                if release_idle_helper(&mut window.slot, window.policy) {
                    emit(
                        &mut out,
                        json!({"phase":"timer_release", "arm":window.arm, "idle_seconds":window.seconds, "elapsed_seconds":idle.as_secs_f64()}),
                    );
                }
                if idle >= Duration::from_secs(window.seconds) {
                    let resident = window.slot.is_some();
                    let result = decode(&mut window.slot, &root, &samples);
                    emit(
                        &mut out,
                        json!({"phase":"first_after_idle", "arm":window.arm, "idle_seconds":window.seconds,
                        "elapsed_seconds":idle.as_secs_f64(), "was_resident":resident, "result":result}),
                    );
                    window.slot.take();
                    window.done = true;
                } else if sampled_at.elapsed() >= Duration::from_secs(60) {
                    if let Some(helper) = &window.slot {
                        emit(
                            &mut out,
                            json!({"phase":"idle_loaded", "arm":window.arm, "idle_seconds":window.seconds,
                            "elapsed_seconds":idle.as_secs_f64(), "memory":memory(helper.child.id())}),
                        );
                    }
                }
            }
            if sampled_at.elapsed() >= Duration::from_secs(60) {
                sampled_at = Instant::now();
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    } else {
        panic!("unknown probe mode");
    }
    confirm_spec_files(&verified).unwrap();
    emit(&mut out, json!({"phase":"complete", "errors":0}));
}

#[test]
#[ignore = "loads a real CPU speech model and measures ten minutes; run through native admission in a build slot"]
fn warm_idle_ten_minute_probe() {
    assert_eq!(
        crate::hardware_tier::current(),
        crate::hardware_tier::HardwareTier::Light
    );
    assert!(crate::memory_pressure::start_monitor());
    assert_eq!(
        crate::memory_pressure::events().current(),
        crate::memory_pressure::MemoryPressure::Normal
    );
    let out_path = std::env::var("PLAINSONG_RESIDENCY_PROBE_OUT").unwrap();
    let root = Path::new(&std::env::var("HOME").unwrap()).join("Library/Caches/PlainsongQA/models");
    let _verified = verify_spec_files(&root, &PARAKEET_V3_COREML).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("scripts/fixtures/real-speech-44s.wav");
    let mut wav = hound::WavReader::open(fixture).unwrap();
    assert_eq!(wav.spec().sample_rate, 16_000);
    assert_eq!(wav.spec().channels, 1);
    let samples: Vec<f32> = wav
        .samples::<i16>()
        .take(160_000)
        .map(|sample| sample.unwrap() as f32 / 32768.0)
        .collect();
    let mut slot = None;
    let seed = decode(&mut slot, &root, &samples);
    let helper_pid = slot.as_ref().unwrap().child.id();
    let started = Instant::now();
    let mut out = File::create(out_path).unwrap();
    emit(
        &mut out,
        json!({"phase":"loaded", "helperPid":helper_pid,
        "helper":resolve_helper().unwrap(), "route":"coreml_cpu", "simulatedGb":8}),
    );
    for _ in 0..120 {
        std::thread::sleep(Duration::from_secs(5));
        assert!(slot.as_mut().unwrap().child.try_wait().unwrap().is_none());
        emit(
            &mut out,
            json!({"phase":"idle", "elapsedSeconds":started.elapsed().as_secs_f64(),
            "helper":memory(helper_pid), "harness":memory(std::process::id())}),
        );
    }
    let returned = decode(&mut slot, &root, &samples);
    assert_eq!(seed["transcript"], returned["transcript"]);
    assert!(
        returned["load_ms"].is_null(),
        "the resident helper must not reload"
    );
    emit(
        &mut out,
        json!({"phase":"returned", "helperPid":helper_pid,
        "exactTranscriptPreserved":true, "loadMs":returned["load_ms"]}),
    );
}
