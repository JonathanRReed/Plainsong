//! Sandboxed Whistle 2.0 adapter for short local dictation on Apple silicon.

use super::{
    AsrProvider, AsrProviderType, DownloadStatus, ModelInfo, TranscriptSegment,
    TranscriptionOptions, TranscriptionResult,
};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};

pub const MODEL_ID: &str = "whistle-2.0.0";
pub const MODEL_FILE: &str = "whistle.cact";
pub const CLI_FILE: &str = "needle";
pub const MODEL_BYTES: u64 = 16_919_407;
pub const CLI_BYTES: u64 = 1_073_160;
pub const MODEL_SHA256: &str = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
pub const CLI_SHA256: &str = "f52c9ce7c05ef44e8d8441584aec9e6ac6054f811866eacd70f33da2462577dc";
const MODEL_URL: &str = "https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact";
const CLI_URL: &str = "https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089/macos-arm64/needle";
pub const MAX_AUDIO_SECONDS: f64 = 30.0;
/// Compiled into Whistle's decoder; the CLI exposes no override.
pub const TRANSCRIPT_TOKEN_CAP: usize = 320;
// 30 seconds at the capture ceiling, 32-bit stereo, plus bounded WAV metadata.
const MAX_AUDIO_BYTES: u64 = 30 * 48_000 * 2 * 4 + 64 * 1024;
const MAX_AUDIO_SAMPLE_RATE: u32 = 48_000;
const MAX_AUDIO_CHANNELS: u16 = 2;
const MAX_STDOUT_BYTES: usize = 2 * 1024 * 1024;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_KEYWORDS: usize = 100;
const MAX_KEYWORD_BYTES: usize = 8 * 1024;
pub const SUPPORTED_LANGUAGES: &[&str] = &["en", "de", "fr", "es", "it", "nl", "pl"];

pub(crate) fn model_dir(root: &Path) -> PathBuf {
    root.join("whistle").join(MODEL_ID)
}
pub(crate) fn model_integrity_artifacts(root: &Path) -> Vec<(PathBuf, String)> {
    let dir = model_dir(root);
    vec![
        (dir.join(MODEL_FILE), MODEL_SHA256.into()),
        (dir.join(CLI_FILE), CLI_SHA256.into()),
    ]
}

fn normalized_language(language: Option<&str>) -> Result<Option<&'static str>> {
    let Some(raw) = language
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case("auto"))
    else {
        return Ok(None);
    };
    let base = raw
        .split(['-', '_'])
        .next()
        .unwrap_or(raw)
        .to_ascii_lowercase();
    SUPPORTED_LANGUAGES
        .iter()
        .copied()
        .find(|v| *v == base)
        .map(Some)
        .ok_or_else(|| anyhow::anyhow!("Whistle does not support the selected language '{raw}'"))
}

pub(crate) fn validate_request(seconds: f64, language: Option<&str>) -> Result<()> {
    if !seconds.is_finite() || seconds < 0.0 {
        bail!("Whistle received an invalid audio duration")
    }
    if seconds > MAX_AUDIO_SECONDS {
        bail!("Whistle accepts dictation up to 30 seconds; audio was not trimmed")
    }
    normalized_language(language)?;
    Ok(())
}

pub(crate) fn command_args(
    model: &Path,
    audio: &Path,
    language: Option<&str>,
    keywords: Option<&Path>,
) -> Result<Vec<String>> {
    let mut args = vec![
        "--model".into(),
        model.display().to_string(),
        "--audio".into(),
        audio.display().to_string(),
    ];
    if let Some(language) = normalized_language(language)? {
        args.extend(["--audio-language".into(), language.into()]);
    }
    if let Some(path) = keywords {
        args.extend(["--audio-keywords".into(), path.display().to_string()]);
    }
    args.push("--audio-word-timestamps".into());
    Ok(args)
}

#[derive(Deserialize)]
struct RawOutput {
    text: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    words: Vec<RawWord>,
}
#[derive(Deserialize)]
struct RawWord {
    word: String,
    start: f64,
    end: f64,
    probability: f64,
}
#[derive(Debug, PartialEq)]
pub(crate) struct ParsedOutput {
    pub text: String,
    pub language: Option<String>,
    pub words: Vec<(String, f64, f64, f64)>,
}

pub(crate) fn parse_output(json: &[u8], seconds: f64) -> Result<ParsedOutput> {
    if json.len() > MAX_STDOUT_BYTES {
        bail!("Whistle output exceeded the 2 MiB safety limit")
    }
    let raw: RawOutput = serde_json::from_slice(json).context("Whistle returned invalid JSON")?;
    let language = match raw.language.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => normalized_language(Some(value))?.map(str::to_string),
    };
    let mut previous_end = 0.0;
    let mut words = Vec::with_capacity(raw.words.len());
    for word in raw.words {
        if word.word.trim().is_empty()
            || !word.start.is_finite()
            || !word.end.is_finite()
            || !word.probability.is_finite()
            || word.start < 0.0
            || word.start < previous_end
            || word.end < word.start
            || word.end > seconds
            || !(0.0..=1.0).contains(&word.probability)
        {
            bail!("Whistle returned invalid word timestamps")
        }
        previous_end = word.end;
        words.push((
            word.word.trim().into(),
            word.start,
            word.end,
            word.probability,
        ));
    }
    Ok(ParsedOutput {
        text: raw.text.trim().into(),
        language,
        words,
    })
}

struct TemporaryFile {
    path: PathBuf,
    term_count: usize,
}
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn write_keywords(terms: &[String]) -> Result<Option<TemporaryFile>> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut clean = Vec::new();
    let mut bytes = 0;
    for term in terms.iter().take(MAX_KEYWORDS).map(|v| v.trim()) {
        if term.is_empty() || term.contains(['\n', '\r', '\0']) {
            continue;
        }
        if bytes + term.len() + usize::from(!clean.is_empty()) > MAX_KEYWORD_BYTES {
            break;
        }
        bytes += term.len() + usize::from(!clean.is_empty());
        clean.push(term);
    }
    if clean.is_empty() {
        return Ok(None);
    }
    let path = std::env::temp_dir().join(format!(
        "plainsong-whistle-keywords-{}.txt",
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .context("Failed to create Whistle keyword file")?;
    let temporary_file = TemporaryFile {
        path,
        term_count: clean.len(),
    };
    file.write_all(clean.join("\n").as_bytes())?;
    file.sync_all()?;
    Ok(Some(temporary_file))
}

struct AudioSnapshot {
    path: PathBuf,
    directory: PathBuf,
}
impl Drop for AudioSnapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn copy_audio_snapshot(
    source: &mut impl std::io::Read,
    directory: PathBuf,
) -> Result<(AudioSnapshot, f64)> {
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(&directory)
        .context("Failed to create private Whistle audio directory")?;
    // Own the directory immediately so partial copies and validation failures clean up.
    let snapshot = AudioSnapshot {
        path: directory.join("audio.wav"),
        directory,
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(&snapshot.path)
        .context("Failed to create Whistle audio snapshot")?;
    let copied = std::io::copy(
        &mut std::io::Read::take(source, MAX_AUDIO_BYTES + 1),
        &mut output,
    )
    .context("Failed to copy Whistle audio snapshot")?;
    if copied > MAX_AUDIO_BYTES {
        bail!("Whistle requires a WAV file no larger than {MAX_AUDIO_BYTES} bytes; audio was not trimmed")
    }
    output
        .sync_all()
        .context("Failed to finish Whistle audio snapshot")?;
    drop(output);
    let seconds = WhistleProvider::audio_duration(&snapshot.path)?;
    validate_request(seconds, None)?;
    Ok((snapshot, seconds))
}

fn snapshot_audio(path: &Path) -> Result<(AudioSnapshot, f64)> {
    let mut source = std::fs::File::open(path).context("Whistle requires a readable WAV file")?;
    let metadata = source
        .metadata()
        .context("Failed to inspect Whistle audio")?;
    if !metadata.is_file() || metadata.len() > MAX_AUDIO_BYTES {
        bail!("Whistle requires a WAV file no larger than {MAX_AUDIO_BYTES} bytes; audio was not trimmed")
    }
    let directory =
        std::env::temp_dir().join(format!("plainsong-whistle-audio-{}", uuid::Uuid::new_v4()));
    copy_audio_snapshot(&mut source, directory)
}

// The admission includes the shared runtime gate. Keep it until wait confirms
// exit, including when the caller drops its transcription future.
struct WhistleChild<T: Send + 'static> {
    child: Option<tokio::process::Child>,
    admission: Option<T>,
}

fn finish_child_admission<T>(admission: Option<T>, exit: std::io::Result<()>) {
    if let Err(error) = exit {
        tracing::error!(%error, "Could not confirm Whistle exit; retaining local runtime admission");
        std::mem::forget(admission);
    }
}

impl<T: Send + 'static> Drop for WhistleChild<T> {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let admission = self.admission.take();
        match child.try_wait() {
            Ok(Some(_)) => return,
            _ => {
                let _ = child.start_kill();
            }
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            // This task must not release admission if shutdown drops it before
            // the wait completes. Explicitly release only after confirmed exit.
            let admission = std::mem::ManuallyDrop::new(admission);
            runtime.spawn(async move {
                let exit = child.wait().await.map(|_| ());
                finish_child_admission(std::mem::ManuallyDrop::into_inner(admission), exit);
            });
        } else {
            std::mem::forget(admission);
        }
    }
}

async fn read_whistle_child(child: &mut tokio::process::Child) -> Result<Vec<u8>> {
    let stdout = child
        .stdout
        .take()
        .context("Whistle stdout was unavailable")?;
    let read = async move {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_STDOUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_STDOUT_BYTES {
            bail!("Whistle output exceeded the 2 MiB safety limit")
        }
        Ok::<_, anyhow::Error>(bytes)
    };
    let wait = async {
        child
            .wait()
            .await
            .context("Failed to wait for Whistle exit")
    };
    let (status, bytes) = tokio::try_join!(wait, read)?;
    if !status.success() {
        bail!("Whistle exited with status {status}")
    }
    Ok(bytes)
}

async fn run_whistle_child<T: Send + 'static>(
    mut owner: WhistleChild<T>,
    seconds: f64,
    timeout: Duration,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Result<ParsedOutput> {
    let outcome = tokio::select! {
        result = tokio::time::timeout(timeout, read_whistle_child(owner.child.as_mut().expect("owned Whistle child"))) => {
            result.unwrap_or_else(|_| Err(anyhow::anyhow!("Whistle timed out while transcribing")))
        }
        _ = &mut cancelled => Err(anyhow::anyhow!("Whistle transcription was cancelled")),
    };
    match outcome {
        Ok(bytes) => {
            // read_whistle_child confirmed exit, but retain admission through parsing.
            owner.child = None;
            parse_output(&bytes, seconds)
        }
        Err(error) => {
            let child = owner.child.as_mut().expect("owned Whistle child");
            let _ = child.start_kill();
            let exit = child.wait().await;
            owner.child = None;
            if let Err(exit_error) = exit {
                finish_child_admission(owner.admission.take(), Err(exit_error));
                bail!("{error}. Could not confirm Whistle stopped; local processing remains paused")
            }
            Err(error)
        }
    }
}

fn sandbox_literal(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

pub struct WhistleProvider {
    model_dir: PathBuf,
}
impl WhistleProvider {
    pub fn new(_: Option<&str>) -> Self {
        let root = crate::paths::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Plainsong/models");
        Self {
            model_dir: model_dir(&root),
        }
    }
    fn model_path(&self) -> PathBuf {
        self.model_dir.join(MODEL_FILE)
    }
    fn cli_path(&self) -> PathBuf {
        self.model_dir.join(CLI_FILE)
    }
    fn ready(&self) -> bool {
        cfg!(all(target_os = "macos", target_arch = "aarch64"))
            && crate::download::is_model_artifact_installed(&self.model_path(), Some(MODEL_SHA256))
            && crate::download::is_model_artifact_installed(&self.cli_path(), Some(CLI_SHA256))
    }
    fn audio_duration(path: &Path) -> Result<f64> {
        // Check length before parsing even the WAV header or allocating CLI buffers.
        let file = std::fs::File::open(path).context("Whistle requires a readable WAV file")?;
        let metadata = file.metadata().context("Failed to inspect Whistle audio")?;
        if !metadata.is_file() || metadata.len() > MAX_AUDIO_BYTES {
            bail!("Whistle requires a WAV file no larger than {MAX_AUDIO_BYTES} bytes; audio was not trimmed")
        }
        let reader = hound::WavReader::new(std::io::BufReader::new(file))
            .context("Whistle requires a readable WAV file")?;
        let spec = reader.spec();
        if !(1..=MAX_AUDIO_CHANNELS).contains(&spec.channels)
            || !(1..=MAX_AUDIO_SAMPLE_RATE).contains(&spec.sample_rate)
        {
            bail!(
                "Whistle requires mono or stereo WAV audio at up to 48 kHz; audio was not trimmed"
            )
        }
        let supported_encoding = match spec.sample_format {
            hound::SampleFormat::Int => matches!(spec.bits_per_sample, 8 | 16 | 24 | 32),
            hound::SampleFormat::Float => spec.bits_per_sample == 32,
        };
        if !supported_encoding {
            bail!("Whistle requires 8/16/24/32-bit PCM or 32-bit float WAV audio")
        }
        // `duration()` is frames per channel. The native CLI performs its own
        // channel mixdown and resampling, including Plainsong's usual 48 kHz
        // mono capture, so admission must use the source rate without
        // rewriting or rejecting it.
        Ok(reader.duration() as f64 / f64::from(spec.sample_rate))
    }
    async fn run(
        &self,
        audio: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            bail!("Whistle is available only on Apple silicon Macs")
        }
        if !self.ready() {
            bail!("Whistle is not downloaded or failed integrity verification. Download it from Settings.")
        }
        let (snapshot, seconds) = snapshot_audio(audio)?;
        validate_request(seconds, options.language.as_deref())?;
        let terms = options
            .vocabulary_hint
            .as_ref()
            .map(|v| v.terms())
            .unwrap_or(&[]);
        let keywords = write_keywords(terms)?;
        let cli_path = std::fs::canonicalize(self.cli_path())
            .context("Failed to resolve the Whistle CLI path")?;
        let model_path = std::fs::canonicalize(self.model_path())
            .context("Failed to resolve the Whistle model path")?;
        let audio_path = std::fs::canonicalize(&snapshot.path)
            .context("Failed to resolve the Whistle audio path")?;
        let keyword_path = keywords
            .as_ref()
            .map(|file| std::fs::canonicalize(&file.path))
            .transpose()
            .context("Failed to resolve the Whistle keyword path")?;
        let args = command_args(
            &model_path,
            &audio_path,
            options.language.as_deref(),
            keyword_path.as_deref(),
        )?;
        let keyword_rule = keyword_path
            .as_ref()
            .map(|path| format!(" (literal \"{}\")", sandbox_literal(path)))
            .unwrap_or_default();
        let cli_literal = sandbox_literal(&cli_path);
        // The macOS loader needs its Cryptex library rules before main runs.
        // This does not grant network or arbitrary Mach-service access.
        let profile = format!("(version 1)(deny default)(import \"dyld-support.sb\")(deny network*)(allow process-exec (literal \"{cli_literal}\"))(allow file-read* (subpath \"/usr/lib\") (subpath \"/System/Library\") (literal \"{cli_literal}\") (literal \"{}\") (literal \"{}\"){keyword_rule})(allow sysctl-read)", sandbox_literal(&model_path), sandbox_literal(&audio_path));
        let started = Instant::now();
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-p", &profile])
            .arg(&cli_path)
            .args(args)
            .env_clear()
            .env("NEEDLE_TELEMETRY", "0")
            .env("DO_NOT_TRACK", "1")
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let model_load = crate::llm::local_model_load::admit_asr(
            &[&model_path],
            AsrProviderType::Whistle,
            MODEL_ID,
            crate::llm::local_model_load::NativeAllocation::Constructor,
        )?;
        let child = command
            .spawn()
            .context("Failed to start the Whistle sandbox")?;
        let terms_applied = keywords.as_ref().map_or(0, |file| file.term_count);
        let owner = WhistleChild {
            child: Some(child),
            admission: Some((model_load, keywords, snapshot)),
        };
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_whistle_child(
            owner,
            seconds,
            PROCESS_TIMEOUT,
            cancelled,
        ));
        let parsed = task.await.context("Whistle process owner failed")??;
        drop(cancel);
        let segments: Vec<_> = parsed
            .words
            .iter()
            .map(|(word, start, end, p)| TranscriptSegment {
                start_time: *start,
                end_time: *end,
                text: word.clone(),
                confidence: *p,
            })
            .collect();
        let confidence = if segments.is_empty() {
            0.0
        } else {
            segments.iter().map(|s| s.confidence).sum::<f64>() / segments.len() as f64
        };
        Ok(TranscriptionResult {
            text: parsed.text,
            segments,
            measured_word_timestamps: false,
            speaker_turns: Vec::new(),
            language: parsed.language.unwrap_or_default(),
            confidence,
            processing_time_ms: started.elapsed().as_millis() as u64,
            model_name: "Whistle 2.0".into(),
            model_id: MODEL_ID.into(),
            requested_provider: AsrProviderType::Whistle,
            actual_provider: AsrProviderType::Whistle,
            requested_engine: None,
            actual_engine: Some("needle-macos-arm64".into()),
            optimization_applied: false,
            fallback_reason: None,
            vocabulary_hint_terms_applied: terms_applied,
            vocabulary_candidates: Vec::new(),
        })
    }
}

#[async_trait]
impl AsrProvider for WhistleProvider {
    fn name(&self) -> &str {
        "Whistle 2.0"
    }
    fn description(&self) -> &str {
        "Experimental local short dictation for Apple silicon Macs. Seven languages and a 30-second maximum."
    }
    fn is_available(&self) -> bool {
        self.ready()
    }
    fn model_info(&self) -> ModelInfo {
        ModelInfo {
            name: "Whistle 2.0".into(),
            version: MODEL_ID.into(),
            size_mb: (MODEL_BYTES + CLI_BYTES) as f64 / 1_048_576.0,
            parameters: "runtime bundle".into(),
            languages: SUPPORTED_LANGUAGES.iter().map(|v| (*v).into()).collect(),
            word_error_rate: None,
            real_time_factor: None,
            license: "Apache-2.0".into(),
            source_url: "https://huggingface.co/Cactus-Compute/whistle".into(),
        }
    }
    async fn transcribe(&self, path: &Path) -> Result<TranscriptionResult> {
        self.run(path, &TranscriptionOptions::default()).await
    }
    async fn transcribe_path_with_options(
        &self,
        path: &Path,
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        self.run(path, options).await
    }
    async fn transcribe_bytes(&self, data: &[u8]) -> Result<TranscriptionResult> {
        self.transcribe_bytes_with_options(data, &TranscriptionOptions::default())
            .await
    }
    async fn transcribe_bytes_with_options(
        &self,
        data: &[u8],
        options: &TranscriptionOptions,
    ) -> Result<TranscriptionResult> {
        if data.len() as u64 > MAX_AUDIO_BYTES {
            bail!("Whistle requires a WAV file no larger than {MAX_AUDIO_BYTES} bytes; audio was not trimmed")
        }
        let path =
            std::env::temp_dir().join(format!("plainsong-whistle-{}.wav", uuid::Uuid::new_v4()));
        let temp = crate::recording_audio::write_secure_temporary_audio(&path, data)?;
        self.run(temp.path(), options).await
    }
    fn download_status(&self) -> DownloadStatus {
        if self.ready() {
            DownloadStatus::Downloaded
        } else {
            DownloadStatus::NotDownloaded
        }
    }
    async fn download_models(&self, progress: Box<dyn Fn(f32) + Send + Sync>) -> Result<()> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            bail!("Whistle downloads are available only on Apple silicon Macs")
        }
        std::fs::create_dir_all(&self.model_dir)?;
        let manager = crate::download::DownloadManager::new()?;
        let progress = Arc::new(progress);
        let cb = progress.clone();
        manager
            .download_verified_model_asset(
                MODEL_URL,
                &self.model_path(),
                Some(MODEL_SHA256),
                MODEL_BYTES,
                move |p| cb((p.percentage * 0.9) as f32),
            )
            .await?;
        let staged = self.model_dir.join("needle.installing");
        let cb = progress.clone();
        manager
            .download_verified_model_asset(
                CLI_URL,
                &staged,
                Some(CLI_SHA256),
                CLI_BYTES,
                move |p| cb((90.0 + p.percentage * 0.1) as f32),
            )
            .await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut mode = std::fs::metadata(&staged)?.permissions();
            mode.set_mode(0o700);
            std::fs::set_permissions(&staged, mode)?;
        }
        tokio::fs::rename(&staged, self.cli_path()).await?;
        // Re-verify the final path after staging.
        if !crate::download::verify_or_record_model_integrity(&self.cli_path(), Some(CLI_SHA256))
            .await?
        {
            bail!("Whistle CLI failed final integrity verification")
        }
        progress(100.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_wav(path: &Path, channels: u16, sample_rate: u32, frames: usize) {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create WAV fixture");
        for _ in 0..frames * usize::from(channels) {
            writer.write_sample(0_i16).expect("write WAV sample");
        }
        writer.finalize().expect("finish WAV fixture");
    }

    struct TestDirectory(PathBuf);
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn admission_and_language_normalization() {
        assert!(validate_request(30.0, Some("EN_us")).is_ok());
        assert!(validate_request(30.0, Some("auto")).is_ok());
        assert!(validate_request(30.001, Some("en"))
            .unwrap_err()
            .to_string()
            .contains("not trimmed"));
        assert!(validate_request(1.0, Some("zh")).is_err());
        for language in ["EN_us", "en-US"] {
            let args =
                command_args(Path::new("/m"), Path::new("/a"), Some(language), None).unwrap();
            assert!(args.windows(2).any(|v| v == ["--audio-language", "en"]));
        }
    }
    #[test]
    fn parser_rejects_invalid_rows_and_languages_without_inventing_words() {
        assert!(
            parse_output(br#"{"text":"hello","language":"en","words":[]}"#, 1.0)
                .unwrap()
                .words
                .is_empty()
        );
        assert!(parse_output(
            br#"{"text":"x","words":[{"word":"x","start":-0.1,"end":0.2,"probability":0.9}]}"#,
            1.0
        )
        .is_err());
        assert!(parse_output(
            br#"{"text":"x","words":[{"word":"x","start":0.0,"end":0.2,"probability":1.1}]}"#,
            1.0
        )
        .is_err());
        assert!(parse_output(br#"{"text":"x","language":"zh"}"#, 1.0).is_err());
    }

    #[test]
    fn duration_accepts_normal_48khz_mono_and_stereo_capture() {
        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "plainsong-whistle-wav-test-{}",
            uuid::Uuid::new_v4()
        )));
        std::fs::create_dir_all(&directory.0).expect("create fixture directory");
        for channels in [1, 2] {
            let path = directory.0.join(format!("{channels}-channel.wav"));
            write_wav(&path, channels, 48_000, 48_000);
            let duration = WhistleProvider::audio_duration(&path).expect("supported WAV");
            assert!((duration - 1.0).abs() < f64::EPSILON, "{duration}");
            assert!(validate_request(duration, None).is_ok());
        }
    }

    #[test]
    fn audio_bounds_reject_oversized_files_before_wav_parsing() {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("plainsong-whistle-bounds-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0).unwrap();
        let path = directory.0.join("oversized.wav");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_AUDIO_BYTES + 1).unwrap();
        assert!(WhistleProvider::audio_duration(&path)
            .unwrap_err()
            .to_string()
            .contains("no larger"));
        std::fs::write(&path, b"not a WAV").unwrap();
        assert!(WhistleProvider::audio_duration(&path)
            .unwrap_err()
            .to_string()
            .contains("readable WAV"));
        for (channels, rate) in [(3, 48_000), (1, 48_001), (2, 192_000)] {
            write_wav(&path, channels, rate, 1);
            assert!(WhistleProvider::audio_duration(&path)
                .unwrap_err()
                .to_string()
                .contains("not trimmed"));
        }
        write_wav(&path, 1, 16_000, 16_000);
        assert_eq!(WhistleProvider::audio_duration(&path).unwrap(), 1.0);
        write_wav(&path, 1, 16_000, 30 * 16_000 + 1);
        let seconds = WhistleProvider::audio_duration(&path).unwrap();
        assert!(validate_request(seconds, None)
            .unwrap_err()
            .to_string()
            .contains("not trimmed"));
    }

    #[test]
    fn snapshot_survives_original_replacement_and_growth() {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("plainsong-whistle-source-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0).unwrap();
        let source = directory.0.join("source.wav");
        write_wav(&source, 1, 16_000, 16_000);
        let (snapshot, seconds) = snapshot_audio(&source).unwrap();
        let copied = std::fs::read(&snapshot.path).unwrap();
        std::fs::remove_file(&source).unwrap();
        let replacement = std::fs::File::create(&source).unwrap();
        replacement.set_len(MAX_AUDIO_BYTES + 1).unwrap();
        assert_eq!(std::fs::read(&snapshot.path).unwrap(), copied);
        assert_eq!(
            WhistleProvider::audio_duration(&snapshot.path).unwrap(),
            seconds
        );
        let path = snapshot.directory.clone();
        drop(snapshot);
        assert!(!path.exists());
    }

    #[test]
    fn snapshot_copy_overflow_and_invalid_audio_remove_partial_files() {
        let path =
            std::env::temp_dir().join(format!("plainsong-whistle-copy-{}", uuid::Uuid::new_v4()));
        let mut oversized = std::io::Read::take(std::io::repeat(0), MAX_AUDIO_BYTES + 1);
        assert!(copy_audio_snapshot(&mut oversized, path.clone())
            .err()
            .unwrap()
            .to_string()
            .contains("no larger"));
        assert!(!path.exists());
        let mut malformed = &b"not a WAV"[..];
        assert!(copy_audio_snapshot(&mut malformed, path.clone()).is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn byte_input_rejects_oversize_before_writing_audio() {
        let provider = WhistleProvider {
            model_dir: PathBuf::from("/unused"),
        };
        let data = vec![0; MAX_AUDIO_BYTES as usize + 1];
        assert!(provider
            .transcribe_bytes(&data)
            .await
            .unwrap_err()
            .to_string()
            .contains("no larger"));
    }

    #[cfg(unix)]
    struct ReapReceipt {
        pid: u32,
        released: Option<tokio::sync::oneshot::Sender<bool>>,
    }
    #[cfg(unix)]
    impl Drop for ReapReceipt {
        fn drop(&mut self) {
            // A reaped direct child must no longer have a PID. This observes
            // admission release itself, rather than checking sometime later.
            let absent = unsafe { libc::kill(self.pid as libc::pid_t, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if let Some(released) = self.released.take() {
                let _ = released.send(absent);
            }
        }
    }

    #[cfg(unix)]
    fn child_fixture(
        program: &str,
        args: &[&str],
    ) -> (
        WhistleChild<ReapReceipt>,
        tokio::sync::oneshot::Receiver<bool>,
    ) {
        let child = Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (released, receipt) = tokio::sync::oneshot::channel();
        let admission = ReapReceipt {
            pid: child.id().unwrap(),
            released: Some(released),
        };
        (
            WhistleChild {
                child: Some(child),
                admission: Some(admission),
            },
            receipt,
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_reaps_child_before_releasing_admission() {
        let (owner, receipt) = child_fixture("/bin/sleep", &["60"]);
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let error = run_whistle_child(owner, 1.0, Duration::from_millis(20), cancelled)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(receipt.await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_reaps_child_before_releasing_admission() {
        let (owner, receipt) = child_fixture("/bin/sleep", &["60"]);
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_whistle_child(owner, 1.0, PROCESS_TIMEOUT, cancelled));
        drop(cancel);
        assert!(task
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
        assert!(receipt.await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aborted_owner_reaps_child_before_releasing_admission() {
        let (owner, receipt) = child_fixture("/bin/sleep", &["60"]);
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_whistle_child(owner, 1.0, PROCESS_TIMEOUT, cancelled));
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(tokio::time::timeout(Duration::from_secs(2), receipt)
            .await
            .unwrap()
            .unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_limit_kills_and_reaps_the_child() {
        let (owner, receipt) = child_fixture(
            "/bin/sh",
            &["-c", "while :; do printf '0123456789abcdef'; done"],
        );
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let error = run_whistle_child(owner, 1.0, PROCESS_TIMEOUT, cancelled)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("2 MiB"));
        assert!(receipt.await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_or_failed_child_cleans_its_audio_snapshot_after_reaping() {
        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "plainsong-whistle-child-audio-{}",
            uuid::Uuid::new_v4()
        )));
        std::fs::create_dir_all(&directory.0).unwrap();
        let source = directory.0.join("source.wav");
        write_wav(&source, 1, 16_000, 16_000);
        for cancel_request in [true, false] {
            let (snapshot, _) = snapshot_audio(&source).unwrap();
            let path = snapshot.directory.clone();
            let (mut fixture, receipt) = if cancel_request {
                child_fixture("/bin/sleep", &["60"])
            } else {
                child_fixture(
                    "/bin/sh",
                    &["-c", "while :; do printf '0123456789abcdef'; done"],
                )
            };
            let owner = WhistleChild {
                child: fixture.child.take(),
                admission: Some((fixture.admission.take().unwrap(), snapshot)),
            };
            let (cancel, cancelled) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(run_whistle_child(owner, 1.0, PROCESS_TIMEOUT, cancelled));
            assert!(path.exists());
            if cancel_request {
                drop(cancel);
            }
            assert!(task.await.unwrap().is_err());
            assert!(receipt.await.unwrap());
            assert!(!path.exists());
        }
    }

    #[test]
    fn unknown_exit_keeps_admission() {
        struct Receipt(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Receipt {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        finish_child_admission(
            Some(Receipt(released.clone())),
            Err(std::io::Error::other("unknown exit")),
        );
        assert!(!released.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Opt-in production-adapter receipt. It copies the separately verified
    /// pinned artifacts into an isolated model directory, verifies them for
    /// this test process (nothing is written beside them), then invokes the same `run`
    /// method and deny-default sandbox profile used by production. The normal
    /// test suite never executes the native binary.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    #[ignore = "runs the pinned native Whistle CLI; opt in for offline adapter qualification"]
    async fn pinned_artifacts_run_through_the_production_sandbox_adapter() {
        use std::os::unix::fs::PermissionsExt;

        let source_root = Path::new("/tmp/plainsong-whistle-eval-20261002");
        let source_model = source_root.join(MODEL_FILE);
        let source_cli = source_root.join(CLI_FILE);
        assert!(source_model.is_file(), "missing {}", source_model.display());
        assert!(source_cli.is_file(), "missing {}", source_cli.display());

        let directory = TestDirectory(std::env::temp_dir().join(format!(
            "plainsong-whistle-adapter-smoke-{}",
            uuid::Uuid::new_v4()
        )));
        let provider = WhistleProvider {
            model_dir: directory.0.join(MODEL_ID),
        };
        std::fs::create_dir_all(&provider.model_dir).expect("create isolated model directory");
        std::fs::copy(&source_model, provider.model_path()).expect("copy pinned model");
        std::fs::copy(&source_cli, provider.cli_path()).expect("copy pinned CLI");
        let mut permissions = std::fs::metadata(provider.cli_path())
            .expect("inspect copied CLI")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(provider.cli_path(), permissions).expect("mark CLI executable");
        crate::download::verify_and_remember_model(&provider.model_path(), MODEL_SHA256)
            .await
            .expect("verify test model");
        crate::download::verify_and_remember_model(&provider.cli_path(), CLI_SHA256)
            .await
            .expect("verify test CLI");

        let audio = directory.0.join("48khz-mono.wav");
        write_wav(&audio, 1, 48_000, 48_000);
        let result = provider
            .run(&audio, &TranscriptionOptions::default())
            .await
            .expect("production adapter accepts the offline pinned CLI result");
        assert_eq!(result.actual_provider, AsrProviderType::Whistle);
        assert!(
            result.segments.is_empty(),
            "silence must not invent word timing"
        );

        let speech = directory.0.join("budget.wav");
        std::fs::copy("/tmp/plainsong-goal-qa/audio/budget.wav", &speech)
            .expect("copy synthetic speech fixture");
        let spoken = provider
            .run(&speech, &TranscriptionOptions::default())
            .await
            .expect("production adapter parses actual speech under the same sandbox");
        assert_eq!(spoken.actual_provider, AsrProviderType::Whistle);
        assert!(!spoken.text.trim().is_empty(), "speech must produce text");
        assert!(
            !spoken.segments.is_empty(),
            "speech must produce word timing"
        );
    }
    #[test]
    fn integrity_covers_both_artifacts_and_token_cap() {
        assert_eq!(model_integrity_artifacts(Path::new("/models")).len(), 2);
        assert_eq!(TRANSCRIPT_TOKEN_CAP, 320);
    }
}
