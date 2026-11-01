use plainsong_lib::admission::AdmissionController;
use serde_json::json;

#[tokio::test]
async fn responsiveness_dictation_start_is_admitted_while_slow_requests_fill_capacity() {
    let admission = AdmissionController::default();
    let jobs: Vec<_> = (0..32)
        .map(|_| admission.admit("search_transcripts", &json!({})).unwrap())
        .collect();
    assert!(admission.admit("search_transcripts", &json!({})).is_err());
    let start = tokio::time::timeout(std::time::Duration::from_millis(100), async {
        admission.admit("start_dictation", &json!({}))
    })
    .await
    .expect("dictation admission must not wait for background work");
    assert!(start.is_ok(), "start rejected: {:?}", start.err());
    assert!(admission.admit("stop_dictation", &json!({})).is_ok());
    drop(jobs);
}

#[test]
fn responsiveness_all_model_downloads_share_capacity() {
    for command in [
        "download_embedding_model",
        "download_native_text_model",
        "download_bundled_cleanup_model",
        "download_live_preview_engine_model",
        "install_ollama_model",
    ] {
        let admission = AdmissionController::default();
        let _first = admission
            .admit("download_asr_models", &json!({"modelId": "first"}))
            .unwrap();
        let _second = admission
            .admit("download_asr_models", &json!({"modelId": "second"}))
            .unwrap();
        assert!(
            admission
                .admit(command, &json!({"modelId": "third"}))
                .is_err(),
            "{command} bypassed the download limit"
        );
    }
}
