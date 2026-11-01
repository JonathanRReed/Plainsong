//! Plainsong's built-in text generation helper.
//!
//! The sidecar starts this process on demand for meeting notes, Ask and
//! dictation cleanup, and talks to it with one JSON object per line on stdin
//! and stdout. It runs llama.cpp in its own address space so its ggml build
//! never shares a process with the sidecar's speech runtimes, and so ending
//! the process returns every byte it used.
//!
//! The sidecar verifies the model file and hands it over as an open file
//! descriptor (`--model-fd`), so this process loads exactly the bytes that
//! passed the integrity check. `--model <path>` exists for local measurement.

use std::io::{BufRead, Read, Write};
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use llama_cpp_2::context::params::{KvCacheType, LlamaContextParams};
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::data::LlamaTokenData;
use llama_cpp_2::token::data_array::LlamaTokenDataArray;
use llama_cpp_2::token::LlamaToken;
use serde::{Deserialize, Serialize};

/// Shared with `rust-sidecar/src/llm/text_helper.rs`.
const PROTOCOL_VERSION: u32 = 2;
/// Longest request line accepted. A packed notes chunk is well under 1 MiB.
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// Context sizes are rounded up to this many tokens, which keeps llama.cpp's
/// KV padding inside what the sidecar budgets.
const CONTEXT_GRANULE: u32 = 256;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    /// Load the model. `maxContextTokens` caps every later request.
    Load {
        max_context_tokens: u32,
        batch_tokens: u32,
        kv_type: String,
    },
    Count {
        text: String,
    },
    Generate {
        prompt: String,
        max_tokens: u32,
        #[serde(default)]
        json_schema: Option<serde_json::Value>,
    },
    Stats,
    /// Read by the input thread; never reaches the worker.
    Cancel,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Response {
    Ready {
        protocol_version: u32,
        gpu_offload: bool,
        memory: Memory,
    },
    Loaded {
        train_context_tokens: u32,
        model_bytes: u64,
        elapsed_ms: u64,
        memory: Memory,
    },
    Count {
        tokens: usize,
    },
    Result {
        text: String,
        /// `stop`, `length`, `repetition` (structured output began copying
        /// itself; `text` keeps one copy) or `cancelled`.
        finish: &'static str,
        prompt_tokens: usize,
        generated_tokens: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        repetition: Option<RepetitionDiagnostic>,
        context_tokens: u32,
        elapsed_ms: u64,
        memory: Memory,
    },
    Stats {
        memory: Memory,
    },
    Error {
        /// `invalid`, `context`, `memory`, `load` or `runtime`.
        kind: &'static str,
        message: String,
    },
}

/// Memory this process holds, sampled after each step.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Memory {
    /// Current and lifetime-peak physical footprint (what Activity Monitor
    /// shows), which counts Metal buffers on unified memory.
    footprint_bytes: u64,
    peak_footprint_bytes: u64,
    /// Peak resident set. Unlike the footprint it also counts the
    /// memory-mapped model file, which must stay resident to run at speed
    /// even though macOS can drop and re-read those pages under pressure.
    peak_resident_bytes: u64,
}

fn memory() -> Memory {
    let (footprint_bytes, peak_footprint_bytes) = footprint();
    Memory {
        footprint_bytes,
        peak_footprint_bytes,
        peak_resident_bytes: peak_resident(),
    }
}

fn peak_resident() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // getrusage fills the struct on success.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    // Initialised by the successful call above. macOS reports bytes.
    let max = unsafe { usage.assume_init() }.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        max
    } else {
        max * 1024
    }
}

#[cfg(target_os = "macos")]
fn footprint() -> (u64, u64) {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // Writes one rusage_info_v4 into a buffer of exactly that size.
    let status = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as libc::c_int,
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr().cast(),
        )
    };
    if status != 0 {
        return (0, 0);
    }
    // Initialised by the successful call above.
    let info = unsafe { info.assume_init() };
    (info.ri_phys_footprint, info.ri_lifetime_max_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
fn footprint() -> (u64, u64) {
    (0, 0)
}

fn kv_type(name: &str) -> Result<KvCacheType> {
    match name {
        "q8_0" => Ok(KvCacheType::Q8_0),
        "q4_0" => Ok(KvCacheType::Q4_0),
        "f16" => Ok(KvCacheType::F16),
        other => bail!("unsupported KV cache type {other}"),
    }
}

fn round_context(tokens: u32) -> u32 {
    tokens
        .div_ceil(CONTEXT_GRANULE)
        .saturating_mul(CONTEXT_GRANULE)
}

trait TokenConstraint {
    fn apply(&mut self, candidates: &mut LlamaTokenDataArray);
    fn accept(&mut self, token: LlamaToken);
}

impl TokenConstraint for LlamaSampler {
    fn apply(&mut self, candidates: &mut LlamaTokenDataArray) {
        LlamaSampler::apply(self, candidates);
    }
    fn accept(&mut self, token: LlamaToken) {
        LlamaSampler::accept(self, token);
    }
}

fn selected_finite_token(candidates: &LlamaTokenDataArray) -> Result<LlamaToken> {
    candidates
        .selected
        .and_then(|index| candidates.data.get(index))
        .filter(|candidate| candidate.logit().is_finite())
        .map(LlamaTokenData::id)
        .ok_or_else(|| {
            refuse(
                "runtime",
                "No valid token after applying output constraints",
            )
        })
}

fn generated_text(bytes: Vec<u8>, complete: bool) -> Result<String> {
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        // Unfinished output keeps its valid prefix: the sidecar may still use
        // the items it completed.
        Err(error) if !complete => {
            let valid = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid);
            Ok(String::from_utf8(bytes).unwrap_or_default())
        }
        Err(_) => Err(refuse("runtime", "The model generated invalid UTF-8 text")),
    }
}

/// Shortest run of generated tokens that, seen a second time, means a
/// structured answer is copying itself. Longer than any field a JSON item
/// legitimately shares with the one before it (keys, a shared owner and
/// deadline, the start of a line ID), far shorter than one looped item.
const REPEAT_WINDOW: usize = 64;

/// No generated words or token IDs cross the logging boundary. The keyed
/// fingerprint identifies the repeated n-gram only within this helper process.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepetitionDiagnostic {
    window_tokens: usize,
    period_tokens: usize,
    observed_tokens: usize,
    kept_tokens: usize,
    ngram_fingerprint: String,
}

/// Finds where structured output started repeating itself verbatim, so the
/// helper can stop instead of filling the output budget with copies.
#[derive(Default)]
struct RepeatGuard {
    windows: std::collections::HashMap<u64, Vec<usize>>,
    fingerprint_key: std::collections::hash_map::RandomState,
}

impl RepeatGuard {
    /// Called after each generated token. Returns the length to keep when the
    /// newest [`REPEAT_WINDOW`] tokens already occurred earlier: one copy of
    /// the repeated run stays, the copies after it go.
    fn check(&mut self, tokens: &[LlamaToken]) -> Option<RepetitionDiagnostic> {
        use std::hash::{Hash, Hasher};
        let end = tokens.len();
        if end < REPEAT_WINDOW {
            return None;
        }
        let window = &tokens[end - REPEAT_WINDOW..];
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        window.iter().for_each(|token| token.0.hash(&mut hasher));
        let earlier = self.windows.entry(hasher.finish()).or_default();
        let found = earlier
            .iter()
            .copied()
            .find(|&previous| tokens[previous - REPEAT_WINDOW..previous] == *window);
        earlier.push(end);
        let previous = found?;
        let period = end - previous;
        let mut start = end - REPEAT_WINDOW;
        while start > period && tokens[start - 1] == tokens[start - 1 - period] {
            start -= 1;
        }
        use std::hash::BuildHasher;
        let mut fingerprint = self.fingerprint_key.build_hasher();
        window
            .iter()
            .for_each(|token| token.0.hash(&mut fingerprint));
        Some(RepetitionDiagnostic {
            window_tokens: REPEAT_WINDOW,
            period_tokens: period,
            observed_tokens: end,
            kept_tokens: start,
            ngram_fingerprint: format!("{:016x}", fingerprint.finish()),
        })
    }
}

/// The schema grammar with its optional whitespace cut to one space. The
/// default also allows line breaks and indentation, which small models fill
/// in: about a quarter of every structured answer was layout.
fn compact_json_grammar(grammar: &str) -> String {
    grammar
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("space ::=") {
                "space ::= | \" \""
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn generation_sampler(structured_output: bool) -> LlamaSampler {
    if structured_output {
        // Qwen's pinned non-thinking recipe. A fixed seed makes replay possible.
        LlamaSampler::chain_simple([
            LlamaSampler::top_k(20),
            LlamaSampler::top_p(0.8, 1),
            LlamaSampler::temp(0.7),
            LlamaSampler::dist(42),
        ])
    } else {
        LlamaSampler::greedy()
    }
}

fn reset_candidates(logits: &[f32], candidates: &mut LlamaTokenDataArray) {
    candidates.data.clear();
    candidates.data.extend(
        (0_i32..)
            .zip(logits)
            .map(|(id, &logit)| LlamaTokenData::new(LlamaToken(id), logit, 0.0)),
    );
    candidates.selected = None;
    candidates.sorted = false;
}

fn constrained_sample(
    logits: &[f32],
    candidates: &mut LlamaTokenDataArray,
    sampler: &mut LlamaSampler,
    constraint: &mut impl TokenConstraint,
) -> Result<LlamaToken> {
    reset_candidates(logits, candidates);
    // Match llama.cpp's common sampler: test the sampled winner first.
    sampler.apply(candidates);
    let winner = selected_finite_token(candidates)?;
    let index = candidates.selected.expect("selected token was checked");
    let mut probe = LlamaTokenDataArray::from_iter([candidates.data[index]], false);
    constraint.apply(&mut probe);
    if probe
        .data
        .first()
        .is_some_and(|candidate| candidate.logit().is_finite())
    {
        constraint.accept(winner);
        sampler.accept(winner);
        return Ok(winner);
    }
    reset_candidates(logits, candidates);
    constraint.apply(candidates);
    sampler.apply(candidates);
    let token = selected_finite_token(candidates)?;
    constraint.accept(token);
    sampler.accept(token);
    Ok(token)
}

struct Loaded {
    model: LlamaModel,
    max_context_tokens: u32,
    batch_tokens: u32,
    kv: KvCacheType,
}

struct Worker {
    backend: LlamaBackend,
    model_path: String,
    loaded: Option<Loaded>,
    cancel: Arc<AtomicBool>,
}

/// A request the worker refused, with the kind the sidecar maps to its own
/// error classes.
#[derive(Debug)]
struct Refusal(&'static str, String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.1)
    }
}

impl std::error::Error for Refusal {}

fn refuse(kind: &'static str, message: impl Into<String>) -> anyhow::Error {
    Refusal(kind, message.into()).into()
}

impl Worker {
    fn handle(&mut self, request: Request) -> Result<Response> {
        match request {
            Request::Load {
                max_context_tokens,
                batch_tokens,
                kv_type: kv,
            } => self.load(max_context_tokens, batch_tokens, &kv),
            Request::Count { text } => {
                let loaded = self.loaded()?;
                Ok(Response::Count {
                    tokens: loaded
                        .model
                        .vocab()
                        .tokenize(text.as_bytes(), false, true)
                        .len(),
                })
            }
            Request::Generate {
                prompt,
                max_tokens,
                json_schema,
            } => self.generate(&prompt, max_tokens, json_schema.as_ref()),
            Request::Stats => Ok(Response::Stats { memory: memory() }),
            Request::Cancel => unreachable!("the input thread consumes cancel requests"),
        }
    }

    fn loaded(&self) -> Result<&Loaded> {
        self.loaded
            .as_ref()
            .ok_or_else(|| refuse("invalid", "The model is not loaded."))
    }

    fn load(&mut self, max_context_tokens: u32, batch_tokens: u32, kv: &str) -> Result<Response> {
        if self.loaded.is_some() {
            return Err(refuse("invalid", "The model is already loaded."));
        }
        if max_context_tokens == 0 || batch_tokens == 0 || batch_tokens > 4096 {
            return Err(refuse("invalid", "Invalid context or batch size."));
        }
        let kv = kv_type(kv).map_err(|error| refuse("invalid", error.to_string()))?;
        let started = Instant::now();
        // Every layer on the GPU: on Apple silicon that is the same unified
        // memory, and the quantized weights stay quantized (including the
        // token embedding, which Candle used to expand to F32).
        let params = LlamaModelParams::default()
            .with_n_gpu_layers(u32::MAX)
            .with_use_mmap(true);
        let model = LlamaModel::load_from_file(&self.backend, &self.model_path, &params)
            .map_err(|error| refuse("load", format!("Cannot load the model: {error}")))?;
        let model_bytes = model.size();
        let train = model.n_ctx_train();
        self.loaded = Some(Loaded {
            model,
            max_context_tokens: max_context_tokens.min(train.max(1)),
            batch_tokens,
            kv,
        });
        Ok(Response::Loaded {
            train_context_tokens: train,
            model_bytes,
            elapsed_ms: started.elapsed().as_millis() as u64,
            memory: memory(),
        })
    }

    fn generate(
        &mut self,
        prompt: &str,
        max_tokens: u32,
        json_schema: Option<&serde_json::Value>,
    ) -> Result<Response> {
        let started = Instant::now();
        let loaded = self.loaded()?;
        if max_tokens == 0 {
            return Err(refuse("invalid", "The output budget is empty."));
        }
        // Control tokens in the prompt are the sidecar's chat template; the
        // sidecar refuses user text that carries them before it gets here.
        let tokens = loaded
            .model
            .vocab()
            .tokenize(prompt.as_bytes(), false, true);
        if tokens.is_empty() {
            return Err(refuse("invalid", "The prompt is empty."));
        }
        let needed = u32::try_from(tokens.len())
            .ok()
            .and_then(|count| count.checked_add(max_tokens))
            .ok_or_else(|| refuse("context", "The request is too long."))?;
        if needed > loaded.max_context_tokens {
            return Err(refuse(
                "context",
                format!(
                    "The request needs {needed} tokens and this model was started for {}; input was not truncated.",
                    loaded.max_context_tokens
                ),
            ));
        }
        // The cache is sized to this request and freed when it returns.
        let context_tokens = round_context(needed).min(loaded.max_context_tokens);
        let threads =
            std::thread::available_parallelism().map_or(4, |count| count.get().min(4)) as i32;
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(context_tokens))
            .with_n_batch(loaded.batch_tokens)
            .with_n_ubatch(loaded.batch_tokens)
            .with_n_seq_max(1)
            .with_type_k(loaded.kv)
            .with_type_v(loaded.kv)
            // A quantized V cache needs flash attention in llama.cpp.
            .with_flash_attention_policy(llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_ENABLED)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut context = loaded
            .model
            .new_context(&self.backend, params)
            .map_err(|error| {
                refuse(
                    "memory",
                    format!("Cannot allocate the model context: {error}"),
                )
            })?;

        let mut grammar = match json_schema {
            Some(schema) => {
                let grammar = compact_json_grammar(
                    &llama_cpp_2::json_schema_to_grammar(&schema.to_string()).map_err(|error| {
                        refuse("invalid", format!("Unusable output schema: {error}"))
                    })?,
                );
                let grammar =
                    LlamaSampler::grammar(&loaded.model, &grammar, "root").map_err(|error| {
                        refuse("invalid", format!("Unusable output grammar: {error}"))
                    })?;
                Some(grammar)
            }
            None => None,
        };
        let mut sampler = generation_sampler(grammar.is_some());
        let mut candidates = LlamaTokenDataArray::new(Vec::new(), false);

        let batch_size = loaded.batch_tokens as usize;
        let mut batch = LlamaBatch::new(batch_size, 1);
        let last_index = tokens.len() - 1;
        for (chunk_index, chunk) in tokens.chunks(batch_size).enumerate() {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(cancelled(tokens.len(), 0, context_tokens, started));
            }
            batch.clear();
            for (offset, token) in chunk.iter().enumerate() {
                let position = chunk_index * batch_size + offset;
                batch.add(*token, position as i32, &[0], position == last_index)?;
            }
            context
                .decode(&mut batch)
                .map_err(|error| refuse("runtime", format!("Prompt processing failed: {error}")))?;
        }

        let vocab = loaded.model.vocab();
        let mut generated: Vec<LlamaToken> = Vec::new();
        let mut position = tokens.len() as i32;
        let mut finish = "length";
        let mut repeats = grammar.as_ref().map(|_| RepeatGuard::default());
        let mut repetition = None;
        while generated.len() < max_tokens as usize {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(cancelled(
                    tokens.len(),
                    generated.len(),
                    context_tokens,
                    started,
                ));
            }
            let token = if let Some(constraint) = grammar.as_mut() {
                constrained_sample(
                    context.get_logits_ith(batch.n_tokens() - 1),
                    &mut candidates,
                    &mut sampler,
                    constraint,
                )?
            } else {
                sampler.sample(&context, batch.n_tokens() - 1)
            };
            // Both selection paths accept each chosen token exactly once.
            if vocab.is_eog(token) {
                finish = "stop";
                break;
            }
            generated.push(token);
            if let Some(diagnostic) = repeats.as_mut().and_then(|guard| guard.check(&generated)) {
                generated.truncate(diagnostic.kept_tokens);
                repetition = Some(diagnostic);
                finish = "repetition";
                break;
            }
            batch.clear();
            batch.add(token, position, &[0], true)?;
            position += 1;
            context
                .decode(&mut batch)
                .map_err(|error| refuse("runtime", format!("Generation failed: {error}")))?;
        }
        let text = generated_text(vocab.detokenize(&generated, true, false), finish == "stop")?;
        drop(context);
        Ok(Response::Result {
            text,
            finish,
            prompt_tokens: tokens.len(),
            generated_tokens: repetition
                .as_ref()
                .map_or(generated.len(), |value| value.observed_tokens),
            repetition,
            context_tokens,
            elapsed_ms: started.elapsed().as_millis() as u64,
            memory: memory(),
        })
    }
}

fn cancelled(prompt: usize, generated: usize, context_tokens: u32, started: Instant) -> Response {
    Response::Result {
        text: String::new(),
        finish: "cancelled",
        prompt_tokens: prompt,
        generated_tokens: generated,
        repetition: None,
        context_tokens,
        elapsed_ms: started.elapsed().as_millis() as u64,
        memory: memory(),
    }
}

fn write_response(out: &mut impl Write, response: &Response) -> Result<()> {
    serde_json::to_writer(&mut *out, response)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

fn model_path(args: &[String]) -> Result<String> {
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    if let Some(fd) = value("--model-fd") {
        let fd: u32 = fd
            .parse()
            .context("--model-fd takes a file descriptor number")?;
        return Ok(format!("/dev/fd/{fd}"));
    }
    value("--model")
        .ok_or_else(|| anyhow!("usage: plainsong-text-helper --model-fd <fd> | --model <path>"))
}

struct QueuedRequest {
    request: std::result::Result<Request, String>,
    cancel: Arc<AtomicBool>,
}

fn read_requests(mut reader: impl BufRead, sender: mpsc::SyncSender<QueuedRequest>) {
    let mut cancel = Arc::new(AtomicBool::new(false));
    let mut pending = vec![Arc::downgrade(&cancel)];
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader
            .by_ref()
            .take(MAX_REQUEST_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_REQUEST_BYTES => break,
            Ok(_) => {}
        }
        let request = serde_json::from_slice::<Request>(&line)
            .map_err(|error| format!("Malformed request: {error}"));
        if matches!(request, Ok(Request::Cancel)) {
            cancel.store(true, Ordering::Relaxed);
            continue;
        }
        if matches!(request, Ok(Request::Generate { .. })) {
            // Cancellation belongs to this queued generation. A worker must
            // never clear a cancel that arrived before it started work.
            cancel = Arc::new(AtomicBool::new(false));
            pending.retain(|flag| flag.strong_count() > 0);
            pending.push(Arc::downgrade(&cancel));
        }
        if sender
            .send(QueuedRequest {
                request,
                cancel: cancel.clone(),
            })
            .is_err()
        {
            break;
        }
    }
    // Closing stdin also cancels work waiting behind a slow model load.
    for flag in pending.into_iter().filter_map(|flag| flag.upgrade()) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model_path = match model_path(&args) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let mut backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(error) => {
            eprintln!("Cannot start the text runtime: {error}");
            std::process::exit(1);
        }
    };
    if std::env::var_os("PLAINSONG_TEXT_HELPER_LOGS").is_none() {
        backend.void_logs();
    }
    let gpu_offload = backend.supports_gpu_offload();

    let (sender, requests) = mpsc::sync_channel(1);
    std::thread::spawn(move || read_requests(std::io::stdin().lock(), sender));

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if write_response(
        &mut out,
        &Response::Ready {
            protocol_version: PROTOCOL_VERSION,
            gpu_offload,
            memory: memory(),
        },
    )
    .is_err()
    {
        std::process::exit(1);
    }
    let mut worker = Worker {
        backend,
        model_path,
        loaded: None,
        cancel: Arc::new(AtomicBool::new(false)),
    };
    while let Ok(QueuedRequest { request, cancel }) = requests.recv() {
        worker.cancel = cancel;
        let response =
            match request {
                Ok(request) => worker.handle(request).unwrap_or_else(|error| {
                    match error.downcast::<Refusal>() {
                        Ok(Refusal(kind, message)) => Response::Error { kind, message },
                        Err(error) => Response::Error {
                            kind: "runtime",
                            message: error.to_string(),
                        },
                    }
                }),
                Err(message) => Response::Error {
                    kind: "invalid",
                    message,
                },
            };
        if write_response(&mut out, &response).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_answers_cannot_spend_tokens_on_layout() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "evidence": {"type": "array", "maxItems": 40, "items": {
                    "type": "object",
                    "properties": {"fact": {"type": "string"}, "lineIds": {"type": "array", "items": {"type": "string"}}},
                    "required": ["fact", "lineIds"],
                    "additionalProperties": false
                }}
            },
            "required": ["evidence"],
            "additionalProperties": false
        });
        let original = llama_cpp_2::json_schema_to_grammar(&schema.to_string()).unwrap();
        assert!(
            original.contains("\\n"),
            "the default grammar allows line breaks"
        );
        let compact = compact_json_grammar(&original);
        let space: Vec<_> = compact
            .lines()
            .filter(|line| line.trim_start().starts_with("space ::="))
            .collect();
        assert_eq!(space, ["space ::= | \" \""]);
        assert!(!compact.contains("[ \\t]"));
        assert_eq!(
            compact.lines().count(),
            original.lines().count(),
            "only the whitespace rule changes"
        );
    }

    struct Mask {
        allowed: Vec<i32>,
        sizes: Vec<usize>,
        accepted: Vec<LlamaToken>,
    }

    impl TokenConstraint for Mask {
        fn apply(&mut self, candidates: &mut LlamaTokenDataArray) {
            self.sizes.push(candidates.data.len());
            for candidate in &mut candidates.data {
                if !self.allowed.contains(&candidate.id().0) {
                    candidate.set_logit(f32::NEG_INFINITY);
                }
            }
        }
        fn accept(&mut self, token: LlamaToken) {
            self.accepted.push(token);
        }
    }

    #[test]
    fn malformed_generated_bytes_are_refused_without_changing_names() {
        assert_eq!(
            generated_text("Zoë Núñez".as_bytes().to_vec(), true).unwrap(),
            "Zoë Núñez"
        );
        let error = generated_text(b"private name \xff".to_vec(), true).unwrap_err();
        assert!(error.to_string().contains("UTF-8"));
        assert!(!error.to_string().contains("private name"));
    }

    #[test]
    fn a_partial_character_at_the_output_limit_keeps_the_length_result() {
        assert_eq!(
            generated_text(b"partial \xe2\x82".to_vec(), false).unwrap(),
            "partial "
        );
        assert_eq!(
            generated_text(b"complete text".to_vec(), false).unwrap(),
            "complete text"
        );
        assert!(generated_text(b"partial \xe2\x82".to_vec(), true).is_err());
    }

    /// Feeds `tokens` one at a time and returns where the guard cut, if it did.
    fn first_cut(tokens: &[i32]) -> Option<(usize, usize)> {
        let tokens: Vec<_> = tokens.iter().copied().map(LlamaToken).collect();
        let mut guard = RepeatGuard::default();
        (1..=tokens.len()).find_map(|end| {
            guard
                .check(&tokens[..end])
                .map(|diagnostic| (end, diagnostic.kept_tokens))
        })
    }

    #[test]
    fn a_looping_item_is_cut_back_to_one_copy() {
        // A 30-token prefix, then one 40-token item repeated, as in a map
        // answer that kept writing the same fact.
        let prefix: Vec<i32> = (1000..1030).collect();
        let item: Vec<i32> = (2000..2040).collect();
        let mut tokens = prefix.clone();
        for _ in 0..6 {
            tokens.extend(&item);
        }
        let (seen, keep) = first_cut(&tokens).unwrap();
        assert!(
            seen < prefix.len() + 4 * item.len(),
            "stopped within four copies"
        );
        assert_eq!(keep, prefix.len() + item.len());
    }

    #[test]
    fn a_repeated_cycle_of_items_keeps_the_first_cycle() {
        let cycle: Vec<i32> = (0..150).map(|index| 3000 + index).collect();
        let mut tokens: Vec<i32> = (0..10).collect();
        tokens.extend(&cycle);
        tokens.extend(&cycle);
        tokens.extend(&cycle[..80]);
        let (_, keep) = first_cut(&tokens).unwrap();
        assert_eq!(keep, 10 + cycle.len());
    }

    #[test]
    fn a_runaway_list_of_one_short_value_is_cut() {
        let mut tokens: Vec<i32> = (0..20).collect();
        for _ in 0..40 {
            tokens.extend([7, 8, 9]);
        }
        let (_, keep) = first_cut(&tokens).unwrap();
        assert_eq!(keep, 23);
    }

    #[test]
    fn repetition_diagnostics_keep_counts_without_words_or_token_ids() {
        let tokens: Vec<_> = (1000..1064).chain(1000..1064).map(LlamaToken).collect();
        let diagnostic = RepeatGuard::default().check(&tokens[..64]);
        assert!(diagnostic.is_none());
        let mut guard = RepeatGuard::default();
        guard.check(&tokens[..64]);
        let diagnostic = guard.check(&tokens).unwrap();
        assert_eq!(diagnostic.window_tokens, 64);
        assert_eq!(diagnostic.period_tokens, 64);
        assert_eq!(diagnostic.observed_tokens, 128);
        assert_eq!(diagnostic.kept_tokens, 64);
        let value = serde_json::to_value(diagnostic).unwrap();
        assert_eq!(value["ngramFingerprint"].as_str().unwrap().len(), 16);
        assert_eq!(value.as_object().unwrap().len(), 5);
    }

    #[test]
    fn shared_fields_and_distinct_items_are_not_repetition() {
        // Each item repeats the same 40 tokens of keys, owner and deadline,
        // then says something new.
        let shared: Vec<i32> = (5000..5040).collect();
        let mut tokens = Vec::new();
        for item in 0..20 {
            tokens.extend(&shared);
            tokens.extend((0..12).map(|index| 6000 + item * 100 + index));
        }
        assert_eq!(first_cut(&tokens), None);
    }

    fn sampled_tokens(structured_output: bool) -> Vec<LlamaToken> {
        let mut sampler = generation_sampler(structured_output);
        (0..64)
            .map(|_| {
                let mut candidates = LlamaTokenDataArray::from_iter(
                    [(0, 2.0), (1, 1.9), (2, 1.8), (3, 1.7)]
                        .into_iter()
                        .map(|(id, logit)| LlamaTokenData::new(LlamaToken(id), logit, 0.0)),
                    false,
                );
                sampler.apply(&mut candidates);
                let token = selected_finite_token(&candidates).unwrap();
                sampler.accept(token);
                token
            })
            .collect()
    }

    #[test]
    fn structured_sampling_can_leave_the_greedy_token_and_is_repeatable() {
        let tokens = sampled_tokens(true);
        assert!(tokens.iter().any(|token| token.0 != 0));
        assert_eq!(tokens, sampled_tokens(true));
    }

    #[test]
    fn unstructured_cleanup_keeps_greedy_decoding() {
        assert!(sampled_tokens(false).iter().all(|token| token.0 == 0));
    }

    #[test]
    fn sampled_rejection_restores_candidates_before_masking() {
        let mut mask = Mask {
            allowed: vec![0],
            sizes: Vec::new(),
            accepted: Vec::new(),
        };
        let mut sampler =
            LlamaSampler::chain_simple([LlamaSampler::top_k(1), LlamaSampler::dist(42)]);
        let token = constrained_sample(
            &[1.0, 2.0, 3.0, 4.0],
            &mut LlamaTokenDataArray::new(Vec::new(), false),
            &mut sampler,
            &mut mask,
        )
        .unwrap();
        assert_eq!(token, LlamaToken(0));
        assert_eq!(mask.sizes, [1, 4]);
        assert_eq!(mask.accepted, [LlamaToken(0)]);
    }

    #[test]
    fn a_legal_greedy_choice_only_checks_one_constraint_candidate() {
        let mut mask = Mask {
            allowed: vec![0, 2],
            sizes: Vec::new(),
            accepted: Vec::new(),
        };
        let mut scratch = LlamaTokenDataArray::new(Vec::new(), false);
        let token = constrained_sample(
            &[5.0, 4.0, 3.0],
            &mut scratch,
            &mut LlamaSampler::greedy(),
            &mut mask,
        )
        .unwrap();
        assert_eq!(token, LlamaToken(0));
        assert_eq!(
            mask.sizes,
            vec![1],
            "full-vocabulary grammar filtering is unnecessary for a legal winner"
        );
        assert_eq!(mask.accepted, vec![token]);
    }

    #[test]
    fn rejecting_the_raw_winner_resamples_and_accepts_only_the_valid_token() {
        let mut mask = Mask {
            allowed: vec![2],
            sizes: Vec::new(),
            accepted: Vec::new(),
        };
        let mut scratch = LlamaTokenDataArray::new(Vec::new(), false);
        let token = constrained_sample(
            &[5.0, 4.0, 3.0],
            &mut scratch,
            &mut LlamaSampler::greedy(),
            &mut mask,
        )
        .unwrap();
        assert_eq!(token, LlamaToken(2));
        assert_eq!(mask.accepted, vec![LlamaToken(2)]);
    }

    #[test]
    fn constrained_sample_matches_full_masking_including_ties_and_empty_masks() {
        for length in 1..=32 {
            for offset in 0..=4 {
                let logits: Vec<_> = (0..length).map(|id| ((id * 7) % 11) as f32 - 5.0).collect();
                let allowed: Vec<_> = (0..length).filter(|id| (id + offset) % 3 == 0).collect();
                let mut full = Mask {
                    allowed: allowed.clone(),
                    sizes: Vec::new(),
                    accepted: Vec::new(),
                };
                let mut reference = LlamaTokenDataArray::from_iter(
                    (0_i32..)
                        .zip(&logits)
                        .map(|(id, &logit)| LlamaTokenData::new(LlamaToken(id), logit, 0.0)),
                    false,
                );
                full.apply(&mut reference);
                LlamaSampler::greedy().apply(&mut reference);
                let expected = selected_finite_token(&reference).ok();
                let mut mask = Mask {
                    allowed,
                    sizes: Vec::new(),
                    accepted: Vec::new(),
                };
                let actual = constrained_sample(
                    &logits,
                    &mut LlamaTokenDataArray::new(Vec::new(), false),
                    &mut LlamaSampler::greedy(),
                    &mut mask,
                )
                .ok();
                assert_eq!(actual, expected, "length={length} offset={offset}");
                assert_eq!(mask.accepted, actual.into_iter().collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn queued_cancellation_and_parent_exit_are_not_reset_by_the_worker() {
        let (sender, requests) = mpsc::sync_channel(2);
        read_requests(
            std::io::Cursor::new(
                b"{\"op\":\"generate\",\"prompt\":\"p\",\"maxTokens\":1}\n{\"op\":\"cancel\"}\n",
            ),
            sender,
        );
        let pending = requests.recv().unwrap();
        assert!(matches!(pending.request.unwrap(), Request::Generate { .. }));
        assert!(pending.cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn contexts_round_up_to_the_granule() {
        assert_eq!(round_context(1), 256);
        assert_eq!(round_context(256), 256);
        assert_eq!(round_context(257), 512);
        assert_eq!(round_context(5_048), 5_120);
    }

    #[test]
    fn only_known_cache_types_are_accepted() {
        assert!(matches!(kv_type("q8_0"), Ok(KvCacheType::Q8_0)));
        assert!(kv_type("f32").is_err());
    }

    #[test]
    fn requests_parse_from_the_sidecar_wire_format() {
        let request: Request = serde_json::from_str(
            r#"{"op":"generate","prompt":"p","maxTokens":8,"jsonSchema":{"type":"object"}}"#,
        )
        .unwrap();
        assert!(matches!(request, Request::Generate { max_tokens: 8, .. }));
        let request: Request = serde_json::from_str(
            r#"{"op":"load","maxContextTokens":4096,"batchTokens":256,"kvType":"q8_0"}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            Request::Load {
                max_context_tokens: 4096,
                ..
            }
        ));
        assert!(serde_json::from_str::<Request>(r#"{"op":"shell"}"#).is_err());
    }

    #[test]
    fn model_path_prefers_the_verified_descriptor() {
        let args = |text: &str| text.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(model_path(&args("h --model-fd 3")).unwrap(), "/dev/fd/3");
        assert_eq!(model_path(&args("h --model /m.gguf")).unwrap(), "/m.gguf");
        assert!(model_path(&args("h")).is_err());
        assert!(model_path(&args("h --model-fd x")).is_err());
    }
}
