//! Opt-in measurements on caller-owned QA models. No app, capture or provider
//! is initialized. Run alone through the shared build slot and native admission.

use super::*;
use crate::hardware_tier::HardwareTier;
use crate::memory_pressure::MemoryPressure;
use crate::model_residency::Policy;
use serde_json::{json, Value};

pub(super) fn memory(pid: u32) -> Option<Value> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: the kernel writes the requested version into matching storage.
    if unsafe { libc::proc_pid_rusage(pid as i32, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast()) }
        != 0
    {
        return None;
    }
    // SAFETY: proc_pid_rusage initialized the structure.
    let info = unsafe { info.assume_init() };
    Some(json!({ "pid": pid, "residentBytes": info.ri_resident_size,
        "footprintBytes": info.ri_phys_footprint, "peakFootprintBytes": info.ri_lifetime_max_phys_footprint }))
}

#[test]
#[ignore = "requires the exact text helper, QA model root and native headroom; run alone in a build slot"]
fn measure_text_pressure_release() {
    use crate::llm::{bundled_local, native_text};
    let root = PathBuf::from(std::env::var("PLAINSONG_PRESSURE_PROBE_MODELS").unwrap());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let mut models: Vec<_> = [
        native_text::NotesSize::Light,
        native_text::NotesSize::Balanced,
        native_text::NotesSize::Best,
    ]
    .into_iter()
    .map(|size| {
        let spec = native_text::spec(size);
        (
            spec.model_id,
            native_text::helper_model(&root, spec),
            native_text::build_prompt(spec, "Answer with OK.", "Reply.").unwrap(),
            16,
        )
    })
    .collect();
    models.push((
        bundled_local::MODEL_ID,
        bundled_local::helper_model(&root.join(bundled_local::MODEL_DIR_NAME)),
        bundled_local::build_prompt(
            bundled_local::StyleControl::DEFAULT,
            "we can review the release notes tomorrow if the memory check passes",
        ),
        64,
    ));
    if let Ok(selected) = std::env::var("PLAINSONG_PRESSURE_PROBE_MODEL") {
        models.retain(|(name, _, _, _)| *name == selected);
        assert!(!models.is_empty(), "choose a known probe model");
    }
    let mut rows = Vec::new();
    for (name, model, prompt, output_budget) in models {
        assert!(runtime
            .block_on(crate::download::verify_existing_model_in_process(
                &model.path,
                model.sha256
            ))
            .unwrap());
        let slot = WarmSlot::new();
        let mut first = None;
        for pass in 0..2 {
            eprintln!("pressure probe model={name} pass={pass}");
            let started = Instant::now();
            let mut load_ms = 0.0;
            let (pid, output, footprint) = slot
                .with(
                    name,
                    || {
                        let process = HelperProcess::start(
                            &model,
                            name,
                            &CancelFlag::new(),
                            Instant::now() + Duration::from_secs(180),
                        )?;
                        load_ms = started.elapsed().as_secs_f64() * 1000.0;
                        Ok(process)
                    },
                    |helper| {
                        let generated = helper.generate(
                            &prompt,
                            output_budget,
                            None,
                            &CancelFlag::new(),
                            Instant::now() + Duration::from_secs(60),
                        )?;
                        assert!(!generated.text.trim().is_empty());
                        Ok((
                            helper.child.id(),
                            generated.text,
                            memory(helper.child.id()).unwrap(),
                        ))
                    },
                )
                .unwrap();
            let request_ms = started.elapsed().as_secs_f64() * 1000.0;
            if let Some(expected) = &first {
                assert_eq!(&output, expected);
            } else {
                first = Some(output);
            }
            let release = Instant::now();
            slot.release_idle(
                Policy {
                    tier: HardwareTier::Light,
                    pressure: MemoryPressure::Warning,
                },
                Duration::from_secs(300),
            );
            let release_ms = release.elapsed().as_secs_f64() * 1000.0;
            assert!(!slot.is_loaded());
            assert!(
                memory(pid).is_none(),
                "the helper must exit before its claim returns"
            );
            rows.push(json!({ "model": name, "pass": pass, "loadMs": load_ms, "requestMs": request_ms,
                "releaseMs": release_ms, "before": footprint, "afterHelperBytes": 0, "outputMatched": true }));
        }
    }
    std::fs::write(
        std::env::var("PLAINSONG_PRESSURE_PROBE_OUT").unwrap(),
        serde_json::to_vec_pretty(&rows).unwrap(),
    )
    .unwrap();
}
