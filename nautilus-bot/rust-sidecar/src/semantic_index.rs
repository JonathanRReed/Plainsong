//! What meaning search indexes, and the key the index is stored under.
//!
//! A local meeting transcript stores one row per timed word (Parakeet times
//! every word), so embedding transcript rows one by one turned each word into
//! its own vector and meaning search returned single words. The index unit is
//! instead a window: speaker passages (`index_passages`, this module's own
//! copy of the analysis grouping, so a change there cannot silently change
//! what an index holds), packed in order up to about a hundred words.
//! Measured on 98 hours of AMI reference transcripts with 124 hand-written
//! English questions and project-scoped candidates,
//! hundred-word windows returned a relevant passage in the top five for 77.4%
//! of questions with EmbeddingGemma 300M and 75.0% with EmbeddingGemma 2 (the
//! default), against 53.2% for word search over the same windows and 26.6% for
//! word search over the stored word rows. Receipts:
//! `docs/evals/beta7-evidence.md`.
//!
//! Windows are derived from the stored transcript and nothing else. The ask
//! path checks a cited window against the current transcript with
//! `window_matches_transcript`, which does not depend on the window rule or
//! the model's tokenizer.

use crate::llm::GroundedSegment;
use crate::models::TranscriptSegment;

/// Bumped whenever the window rule or the text sent to a model changes, so an
/// index built under an older rule is never mixed with a newer one.
/// w2: token caps, passage grouping owned here, split long rows, new window
/// after a long gap.
pub(crate) const INDEX_FORMAT: &str = "w2";
pub(crate) const WINDOW_MAX_WORDS: usize = 100;
pub(crate) const WINDOW_MAX_CHARS: usize = 1_000;
/// Token cap per window, well inside every built-in model's 512-token input
/// once its prefix is added. English windows reach the word cap first; text
/// without spaces (Chinese, Japanese) reaches this one.
pub(crate) const WINDOW_MAX_TOKENS: usize = 200;
/// A pause longer than this starts a new window, so a citation's times stay
/// near the words it quotes.
pub(crate) const WINDOW_MAX_GAP_SECONDS: f64 = 30.0;

fn timed(segment: &TranscriptSegment) -> bool {
    segment.start_time.is_finite()
        && segment.end_time.is_finite()
        && segment.end_time >= segment.start_time
}

/// Split a row longer than one window (a long dictation is often a single
/// row) into pieces under the caps. Pieces keep the row's id; their times are
/// interpolated by word position when the row is timed.
fn split_long_row(
    segment: &TranscriptSegment,
    count: &dyn Fn(&str) -> usize,
) -> Vec<TranscriptSegment> {
    let text = segment.text.trim();
    if text.split_whitespace().count() <= WINDOW_MAX_WORDS
        && count(text) <= WINDOW_MAX_TOKENS
        && text.chars().count() <= WINDOW_MAX_CHARS
    {
        return vec![segment.clone()];
    }
    // Units: words, and runs of a word too long for one window (unspaced
    // scripts) cut by characters.
    let mut units: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        if count(word) <= WINDOW_MAX_TOKENS && word.chars().count() <= WINDOW_MAX_CHARS {
            units.push(word.to_string());
            continue;
        }
        let mut run = String::new();
        for c in word.chars() {
            run.push(c);
            if count(&run) >= WINDOW_MAX_TOKENS / 2 || run.chars().count() >= WINDOW_MAX_CHARS / 2 {
                units.push(std::mem::take(&mut run));
            }
        }
        if !run.is_empty() {
            units.push(run);
        }
    }
    let total_units = units.len().max(1) as f64;
    let mut pieces: Vec<TranscriptSegment> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let (mut tokens, mut chars, mut first_unit) = (0usize, 0usize, 0usize);
    let mut flush = |current: &mut Vec<&str>, first_unit: usize, last_unit: usize| {
        if current.is_empty() {
            return;
        }
        let (start_time, end_time) = if timed(segment) {
            let span = segment.end_time - segment.start_time;
            (
                segment.start_time + span * first_unit as f64 / total_units,
                segment.start_time + span * last_unit as f64 / total_units,
            )
        } else {
            (segment.start_time, segment.end_time)
        };
        pieces.push(TranscriptSegment {
            id: segment.id.clone(),
            start_time,
            end_time,
            text: current.join(" "),
            speaker_id: segment.speaker_id.clone(),
            confidence: segment.confidence,
        });
        current.clear();
    };
    for (index, unit) in units.iter().enumerate() {
        let unit_tokens = count(unit);
        let unit_chars = unit.chars().count() + 1;
        if !current.is_empty()
            && (current.len() + 1 > WINDOW_MAX_WORDS
                || tokens + unit_tokens > WINDOW_MAX_TOKENS
                || chars + unit_chars > WINDOW_MAX_CHARS)
        {
            flush(&mut current, first_unit, index);
            tokens = 0;
            chars = 0;
            first_unit = index;
        }
        current.push(unit);
        tokens += unit_tokens;
        chars += unit_chars;
    }
    flush(&mut current, first_unit, units.len());
    pieces
}

/// Speaker passages: consecutive rows from one speaker with short pauses,
/// within 30 seconds and the window caps. This is the index's own rule; the
/// analysis grouping is free to change without touching an index.
fn index_passages(
    recording_id: &str,
    segments: &[TranscriptSegment],
    count: &dyn Fn(&str) -> usize,
) -> Vec<(GroundedSegment, usize, usize)> {
    let mut passages: Vec<(GroundedSegment, usize, usize)> = Vec::new();
    let mut speaker: Option<&Option<String>> = None;
    for segment in segments {
        let tokens = count(&segment.text);
        let words = segment.text.split_whitespace().count();
        let appendable = passages
            .last()
            .is_some_and(|(current, current_tokens, current_words)| {
                current.start_time.is_finite()
                    && current.end_time.is_finite()
                    && current.end_time >= current.start_time
                    && timed(segment)
                    && speaker.is_some_and(|speaker| speaker == &segment.speaker_id)
                    && segment.start_time >= current.end_time
                    && segment.start_time - current.end_time <= 0.5
                    && segment.end_time - current.start_time <= 30.0
                    && current.text.chars().count() + 1 + segment.text.chars().count() <= 800
                    && current_tokens + tokens <= WINDOW_MAX_TOKENS
                    && current_words + words <= WINDOW_MAX_WORDS
            });
        if appendable {
            let (current, current_tokens, current_words) =
                passages.last_mut().expect("an appendable passage exists");
            current.text.push(' ');
            current.text.push_str(&segment.text);
            current.end_time = segment.end_time;
            *current_tokens += tokens;
            *current_words += words;
        } else {
            passages.push((
                GroundedSegment {
                    recording_id: recording_id.to_string(),
                    segment_id: segment.id.clone(),
                    text: segment.text.clone(),
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                },
                tokens,
                words,
            ));
        }
        speaker = Some(&segment.speaker_id);
    }
    passages
}

/// Pack a transcript into the windows meaning search indexes and cites.
/// `count` measures tokens: the model's tokenizer when indexing, an estimate
/// (`builtin_embeddings::estimated_tokens`) for word search.
pub(crate) fn index_windows(
    recording_id: &str,
    segments: &[TranscriptSegment],
    count: &dyn Fn(&str) -> usize,
) -> Vec<GroundedSegment> {
    let rows: Vec<TranscriptSegment> = segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .flat_map(|segment| split_long_row(segment, count))
        .collect();
    let mut windows: Vec<GroundedSegment> = Vec::new();
    let (mut words_in_last, mut tokens_in_last) = (0usize, 0usize);
    for (passage, tokens, words) in index_passages(recording_id, &rows, count) {
        let appendable = windows.last().is_some_and(|current| {
            words_in_last + words <= WINDOW_MAX_WORDS
                && tokens_in_last + tokens <= WINDOW_MAX_TOKENS
                && current.text.chars().count() + 1 + passage.text.chars().count()
                    <= WINDOW_MAX_CHARS
                && passage.start_time.is_finite()
                && passage.end_time.is_finite()
                && current.end_time.is_finite()
                && passage.start_time - current.end_time <= WINDOW_MAX_GAP_SECONDS
        });
        if appendable {
            let current = windows.last_mut().expect("an appendable window exists");
            current.text.push(' ');
            current.text.push_str(&passage.text);
            current.start_time = current.start_time.min(passage.start_time);
            current.end_time = current.end_time.max(passage.end_time);
            words_in_last += words;
            tokens_in_last += tokens;
        } else {
            words_in_last = words;
            tokens_in_last = tokens;
            windows.push(passage);
        }
    }
    windows
}

/// Windows for word search and for recordings no index covers yet.
pub(crate) fn estimated_windows(
    recording_id: &str,
    segments: &[TranscriptSegment],
) -> Vec<GroundedSegment> {
    index_windows(
        recording_id,
        segments,
        &crate::llm::builtin_embeddings::estimated_tokens,
    )
}

/// Whether a window still quotes the current transcript: its words are a
/// contiguous run of the visible rows that starts inside the row it names,
/// and its times lie within those rows. Independent of the window rule and
/// tokenizer, so any index format can be checked.
pub(crate) fn window_matches_transcript(
    window: &GroundedSegment,
    segments: &[TranscriptSegment],
) -> bool {
    if window.start_time.is_nan() || window.end_time.is_nan() {
        return false;
    }
    let wanted: Vec<&str> = window.text.split_whitespace().collect();
    if wanted.is_empty() {
        return false;
    }
    let visible: Vec<&TranscriptSegment> = segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .collect();
    let words: Vec<(usize, &str)> = visible
        .iter()
        .enumerate()
        .flat_map(|(index, segment)| {
            segment
                .text
                .split_whitespace()
                .map(move |word| (index, word))
        })
        .collect();
    'start: for (offset, (row, _)) in words.iter().enumerate() {
        if visible[*row].id != window.segment_id {
            continue;
        }
        if offset + wanted.len() > words.len() {
            break;
        }
        for (index, word) in wanted.iter().enumerate() {
            if words[offset + index].1 != *word {
                continue 'start;
            }
        }
        let first = *row;
        let last = words[offset + wanted.len() - 1].0;
        let rows = &visible[first..=last];
        if rows.iter().all(|row| timed(row)) {
            let start = rows
                .iter()
                .map(|row| row.start_time)
                .fold(f64::INFINITY, f64::min);
            let end = rows
                .iter()
                .map(|row| row.end_time)
                .fold(f64::NEG_INFINITY, f64::max);
            const SLACK: f64 = 1e-6;
            if window.start_time < start - SLACK
                || window.end_time > end + SLACK
                || window.start_time > window.end_time + SLACK
            {
                continue;
            }
        }
        return true;
    }
    false
}

/// The `model` column value an index is stored under. It names the route, the
/// model and the window rule, so changing any of them reads as "not indexed"
/// rather than as vectors from a different space.
pub(crate) fn index_key(route: SemanticRoute<'_>) -> String {
    match route {
        SemanticRoute::BuiltIn(model_id) => format!("builtin:{model_id}:{INDEX_FORMAT}"),
        SemanticRoute::Ollama(model) => format!("ollama:{}:{INDEX_FORMAT}", model.trim()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SemanticRoute<'a> {
    BuiltIn(&'a str),
    Ollama(&'a str),
}

/// How many windows a question brings back as context.
pub(crate) const SEMANTIC_HITS: usize = 12;
/// How many windows each ranking (meaning, words) offers the fusion.
pub(crate) const RANKED_CANDIDATES: usize = 24;
/// Word-search windows always kept in the context, so a question about an
/// exact name or number is never answered from less than word search finds.
pub(crate) const KEPT_WORD_HITS: usize = 4;
/// How long dictation and capture must have been idle before the background
/// indexer runs its next small batch.
const QUIET_BEFORE_BATCH: std::time::Duration = std::time::Duration::from_secs(3);

/// The meaning-search route the settings select, if any.
#[derive(Clone, Debug)]
pub(crate) enum ActiveRoute {
    BuiltIn(&'static crate::llm::builtin_embeddings::BuiltinEmbeddingModel),
    Ollama(String),
}

impl ActiveRoute {
    /// A built-in model whose terms the user has not accepted selects no
    /// route, so search matches words and nothing is indexed until they do.
    pub(crate) fn from_settings(settings: &crate::settings::TranscriptionSettings) -> Option<Self> {
        match settings.memory_search_mode.as_str() {
            MODE_BUILT_IN => {
                let model = crate::llm::builtin_embeddings::model_or_default(
                    &settings.builtin_embedding_model,
                );
                crate::llm::builtin_embeddings::terms_accepted(
                    model,
                    &settings.builtin_embedding_terms_acceptances,
                )
                .then_some(Self::BuiltIn(model))
            }
            MODE_OLLAMA => {
                let model = settings.embedding_model.trim();
                (!model.is_empty()).then(|| Self::Ollama(model.to_string()))
            }
            _ => None,
        }
    }

    pub(crate) fn key(&self) -> String {
        match self {
            Self::BuiltIn(model) => index_key(SemanticRoute::BuiltIn(model.id)),
            Self::Ollama(model) => index_key(SemanticRoute::Ollama(model)),
        }
    }

    /// Ollama indexes built before windows were stored under the bare model
    /// name, one vector per transcript row, with no prefixes. They keep
    /// answering until the index is rebuilt.
    pub(crate) fn legacy_key(&self) -> Option<String> {
        match self {
            Self::BuiltIn(_) => None,
            Self::Ollama(model) => Some(model.clone()),
        }
    }
}

pub(crate) const MODE_WORDS: &str = "fts";
pub(crate) const MODE_BUILT_IN: &str = "builtin";
pub(crate) const MODE_OLLAMA: &str = "ollama_embeddings";

/// Prefixes the common Ollama embedding models were trained with. Unknown
/// models get none.
pub(crate) fn ollama_prefixes(model: &str) -> (&'static str, &'static str) {
    let name = model
        .trim()
        .trim_start_matches("library/")
        .to_ascii_lowercase();
    if name.starts_with("nomic-embed-text") {
        ("search_query: ", "search_document: ")
    } else if name.starts_with("embeddinggemma") {
        ("task: search result | query: ", "title: none | text: ")
    } else if name.starts_with("qwen3-embedding") {
        (
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:",
            "",
        )
    } else if name.starts_with("mxbai-embed-large") {
        (
            "Represent this sentence for searching relevant passages: ",
            "",
        )
    } else if name.starts_with("snowflake-arctic-embed") {
        ("query: ", "")
    } else {
        ("", "")
    }
}

/// Embed texts on the active route. `legacy` sends the raw text, the way the
/// old per-row Ollama index was built.
pub(crate) async fn embed_texts(
    state: &crate::AppState,
    route: &ActiveRoute,
    role: crate::llm::builtin_embeddings::TextRole,
    texts: &[String],
    legacy: bool,
    busy_wait: std::time::Duration,
) -> anyhow::Result<Vec<Vec<f32>>> {
    use crate::llm::builtin_embeddings::{self as builtin, TextRole};
    state
        .operation_coordinator
        .run_post_call("search query embeddings", async {
            let result = async {
                match route {
                    ActiveRoute::Ollama(model) => {
                        let (query, document) = if legacy {
                            ("", "")
                        } else {
                            ollama_prefixes(model)
                        };
                        let prefix = if role == TextRole::Query {
                            query
                        } else {
                            document
                        };
                        let prepared: Vec<String> = texts
                            .iter()
                            .map(|text| format!("{prefix}{}", text.trim()))
                            .collect();
                        state.ollama_embedder.embed_batch(model, &prepared).await
                    }
                    ActiveRoute::BuiltIn(model) => {
                        let root = builtin::models_root()
                            .ok_or_else(|| anyhow::anyhow!("Could not find the models folder"))?;
                        let mut vectors = Vec::with_capacity(texts.len());
                        let run = builtin::EmbeddingRun::new(&root, model);
                        for batch in texts.chunks(builtin::BATCH) {
                            let deadline = std::time::Instant::now() + busy_wait;
                            loop {
                                let run = run.clone();
                                let batch = batch.to_vec();
                                let attempt = tokio::task::spawn_blocking(move || {
                                    run.embed_blocking(role, &batch)
                                })
                                .await
                                .map_err(|error| {
                                    anyhow::anyhow!("The search model task ended: {error}")
                                })?;
                                match attempt {
                                    Ok(batch_vectors) => {
                                        vectors.extend(batch_vectors);
                                        break;
                                    }
                                    Err(error)
                                        if crate::llm::native_runtime_is_busy(
                                            &error.to_string(),
                                        ) && std::time::Instant::now() < deadline =>
                                    {
                                        tokio::time::sleep(std::time::Duration::from_millis(250))
                                            .await;
                                    }
                                    Err(error) => return Err(error),
                                }
                            }
                        }
                        Ok(vectors)
                    }
                }
            }
            .await;
            builtin::release_now().await;
            result
        })
        .await
}

static SEARCHES_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Held while a question scans the index. The indexer waits for it to drop
/// before writing, so a scan is not restarted by its own background work.
pub(crate) struct SearchInFlight(());

impl SearchInFlight {
    pub(crate) fn begin() -> Self {
        SEARCHES_IN_FLIGHT.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self(())
    }
}

impl Drop for SearchInFlight {
    fn drop(&mut self) {
        SEARCHES_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

type RowIds = std::collections::HashMap<String, usize>;

/// Each visible row's id and position; the first row wins a repeated id.
fn row_ids(segments: &[TranscriptSegment]) -> RowIds {
    let mut ids = RowIds::new();
    for (index, segment) in segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .enumerate()
    {
        ids.entry(segment.id.clone()).or_insert(index);
    }
    ids
}

/// The row a window starts in: the first visible row with its id, or, for a
/// row split into pieces, that row. `None` when the id is not in the
/// transcript.
fn row_position(ids: &RowIds, window: &GroundedSegment) -> Option<usize> {
    ids.get(window.segment_id.as_str()).copied()
}

/// Map one word-search hit to the window holding it. Uses row order, not
/// times, so untimed rows and rows timed at zero land in the right window;
/// times are a fallback only when the hit's row id is unknown.
fn window_for_hit(
    hit: &crate::models::SearchHit,
    ids: &RowIds,
    windows: &[(Option<usize>, GroundedSegment)],
) -> Option<usize> {
    if let Some(&row) = ids.get(hit.segment_id.as_str()) {
        // The last window starting at or before the row; among pieces of one
        // split row, the one quoting the hit.
        let last_start = windows
            .iter()
            .filter_map(|(position, _)| position.filter(|position| *position <= row))
            .max()?;
        let candidates: Vec<usize> = windows
            .iter()
            .enumerate()
            .filter(|(_, (position, _))| *position == Some(last_start))
            .map(|(index, _)| index)
            .collect();
        let needle = hit.text.trim();
        return candidates
            .iter()
            .copied()
            .find(|index| !needle.is_empty() && windows[*index].1.text.contains(needle))
            .or_else(|| candidates.first().copied());
    }
    let timed_hit = hit.start_time.is_finite()
        && hit.end_time.is_finite()
        && hit.end_time > 0.0
        && hit.end_time >= hit.start_time;
    if !timed_hit {
        return None;
    }
    let middle = (hit.start_time + hit.end_time) / 2.0;
    windows.iter().position(|(_, window)| {
        window.start_time <= middle && middle <= window.end_time && window.end_time > 0.0
    })
}

/// Turn word-search hits into the windows that contain them, best first.
/// Recordings the index under `index_key` covers use their stored windows,
/// so a word hit and a meaning hit on the same passage are one window; other
/// recordings use estimated windows. A hit whose recording or window cannot
/// be found is dropped.
pub(crate) fn hits_to_windows(
    db: &crate::db::Database,
    hits: &[crate::models::SearchHit],
    limit: usize,
    index_key: Option<&str>,
) -> anyhow::Result<Vec<GroundedSegment>> {
    type Windows = Vec<(Option<usize>, GroundedSegment)>;
    let mut by_recording: std::collections::HashMap<String, (RowIds, Windows)> =
        std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for hit in hits {
        if out.len() >= limit {
            break;
        }
        if !by_recording.contains_key(&hit.recording_id) {
            let segments = match db.get_transcript_with_revision(&hit.recording_id)? {
                Some((transcript, _)) => transcript.segments,
                None => Vec::new(),
            };
            let stored = match index_key {
                Some(key) => db.semantic_index_windows(&hit.recording_id, key)?,
                None => Vec::new(),
            };
            let windows = if stored.is_empty() {
                estimated_windows(&hit.recording_id, &segments)
            } else {
                stored
            };
            let ids = row_ids(&segments);
            let positioned: Windows = windows
                .into_iter()
                .map(|window| (row_position(&ids, &window), window))
                .collect();
            by_recording.insert(hit.recording_id.clone(), (ids, positioned));
        }
        let (ids, windows) = &by_recording[&hit.recording_id];
        if let Some(index) = window_for_hit(hit, ids, windows) {
            if seen.insert((hit.recording_id.clone(), index)) {
                out.push(windows[index].1.clone());
            }
        }
    }
    Ok(out)
}

/// Reciprocal-rank constant: the usual 60, so the top of either list counts
/// for about the same and neither list's raw scores matter.
const FUSION_K: f64 = 60.0;

fn window_key(window: &GroundedSegment) -> (String, String, u64) {
    (
        window.recording_id.clone(),
        window.segment_id.clone(),
        window.start_time.to_bits(),
    )
}

/// Merge meaning-search and word-search windows by reciprocal rank fusion,
/// best first, at most `limit`. The top `keep_words` word-search windows
/// are always kept, so exact names and numbers still surface and a partly
/// indexed library never answers from less than word search would.
pub(crate) fn fuse_rankings(
    semantic: &[GroundedSegment],
    words: &[GroundedSegment],
    limit: usize,
    keep_words: usize,
) -> Vec<GroundedSegment> {
    let mut scores: std::collections::HashMap<
        (String, String, u64),
        (f64, usize, GroundedSegment),
    > = std::collections::HashMap::new();
    let mut order = 0usize;
    for list in [semantic, words] {
        for (rank, window) in list.iter().enumerate() {
            let entry = scores.entry(window_key(window)).or_insert_with(|| {
                order += 1;
                (0.0, order, window.clone())
            });
            entry.0 += 1.0 / (FUSION_K + rank as f64 + 1.0);
        }
    }
    let mut ranked: Vec<(f64, usize, GroundedSegment)> = scores.into_values().collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut out: Vec<GroundedSegment> = ranked.into_iter().map(|(_, _, window)| window).collect();
    out.truncate(limit);
    for must in words.iter().take(keep_words.min(limit)) {
        if out
            .iter()
            .any(|window| window_key(window) == window_key(must))
        {
            continue;
        }
        // Replace the lowest fused window that is not itself a kept word hit.
        let protected: std::collections::HashSet<_> =
            words.iter().take(keep_words).map(window_key).collect();
        if out.len() < limit {
            out.push(must.clone());
        } else if let Some(slot) = out
            .iter()
            .rposition(|window| !protected.contains(&window_key(window)))
        {
            out[slot] = must.clone();
        }
    }
    out
}

// ── Background indexing ─────────────────────────────────────────────────

/// Held by an Ollama rebuild and by removing a model. The background indexer
/// stands aside while either runs.
pub(crate) static EMBEDDING_REBUILD: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FORGET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LAST_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Ask the background indexer to look for recordings to index.
pub(crate) fn request_index() {
    WAKE.notify_one();
}

/// Ask the indexer to start over: forget recordings it gave up on or backed
/// off from, then look for work. Used by Rebuild.
pub(crate) fn request_rebuild() {
    FORGET.store(true, std::sync::atomic::Ordering::Release);
    request_index();
}

pub(crate) fn indexing_active() -> bool {
    ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

pub(crate) fn last_error() -> Option<String> {
    LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_last_error(error: Option<String>) {
    *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = error;
}

type IndexRelease = std::pin::Pin<Box<tokio::sync::futures::OwnedNotified>>;

/// A temporary refusal, retried on release or pressure recovery.
#[derive(Debug)]
struct Paused {
    reason: String,
    release: Option<IndexRelease>,
}

impl std::fmt::Display for Paused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::error::Error for Paused {}

fn paused(reason: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(Paused {
        reason: reason.into(),
        release: None,
    })
}

/// Register before attempting the lease so even a release between refusal
/// and the worker's wait is retained. Do not hold a rebuild permit while queued.
fn index_operation_lease(
    coordinator: &std::sync::Arc<crate::operation_coordinator::OperationCoordinator>,
    pressure: crate::memory_pressure::MemoryPressure,
) -> anyhow::Result<crate::operation_coordinator::OperationLease> {
    let mut release = Box::pin(coordinator.indexing_changes().notified_owned());
    release.as_mut().enable();
    coordinator
        .try_acquire_with_pressure(
            crate::operation_coordinator::OperationKind::SemanticIndex,
            pressure,
        )
        .map_err(|reason| {
            anyhow::Error::new(Paused {
                reason: format!("Paused: {reason}"),
                release: Some(release),
            })
        })
}

async fn wait_for_index_retry(
    wake: &tokio::sync::Notify,
    wait: std::time::Duration,
    release: Option<IndexRelease>,
    pressure: &mut tokio::sync::watch::Receiver<crate::memory_pressure::MemoryPressure>,
) {
    tokio::select! {
        _ = tokio::time::sleep(wait) => {},
        _ = wake.notified() => {},
        _ = pressure.changed() => {},
        _ = async {
            match release {
                Some(release) => release.await,
                None => std::future::pending().await,
            }
        } => {},
    }
}

fn is_pause(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    error.is::<Paused>()
        || message == crate::llm::builtin_embeddings::SEARCH_AWAY_WINDOW_ENDED
        || crate::llm::native_runtime_is_busy(&message)
        || crate::llm::local_model_load::is_headroom_refusal(&message)
}

/// What the worker remembers between passes.
#[derive(Default)]
struct IndexMemory {
    /// Recordings with no text to index, by transcript fingerprint.
    empty: std::collections::HashMap<String, String>,
    /// Recordings whose indexing failed: the fingerprint that failed, when to
    /// try again and the delay after that. Others carry on meanwhile.
    failed: std::collections::HashMap<String, (String, std::time::Instant, std::time::Duration)>,
    /// Vectors already made for the recording in progress, so a pass that
    /// pauses partway through a long meeting resumes where it stopped.
    checkpoint: Option<Checkpoint>,
}

struct Checkpoint {
    recording_id: String,
    fingerprint: String,
    key: String,
    vectors: Vec<Vec<f32>>,
}

const FIRST_FAILURE_RETRY: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const LAST_FAILURE_RETRY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

impl IndexMemory {
    fn record_failure(&mut self, recording_id: &str, fingerprint: &str) {
        let delay = match self.failed.get(recording_id) {
            Some((previous, _, delay)) if previous == fingerprint => {
                (*delay * 2).min(LAST_FAILURE_RETRY)
            }
            _ => FIRST_FAILURE_RETRY,
        };
        self.failed.insert(
            recording_id.to_string(),
            (
                fingerprint.to_string(),
                std::time::Instant::now() + delay,
                delay,
            ),
        );
    }

    fn should_skip(&self, recording_id: &str, fingerprint: &str) -> bool {
        if self.empty.get(recording_id).map(String::as_str) == Some(fingerprint) {
            return true;
        }
        matches!(
            self.failed.get(recording_id),
            Some((failed, retry_at, _))
                if failed == fingerprint && std::time::Instant::now() < *retry_at
        )
    }
}

fn emit_status(handle: &crate::sidecar_handle::SidecarHandle, indexing: bool) {
    use crate::sidecar_handle::AppEmitter;
    handle.emit_event(
        "semantic-index-progress",
        serde_json::json!({ "indexing": indexing, "error": last_error() }),
    );
}

/// Index new and changed recordings with the built-in model in the
/// background. Runs only while the built-in route is selected, its terms are
/// accepted and its model is downloaded. Before every batch of four windows
/// it waits until dictation, capture, meeting processing and any foreground
/// text work (Ask, summaries, cleanup) have been quiet for 3 seconds, and it
/// stops in Low Power Mode or on battery below 20%. It never touches the
/// Ollama route, whose index is rebuilt on request.
pub fn spawn_semantic_index_worker(
    state: std::sync::Arc<crate::AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
) {
    tokio::spawn(async move {
        // Let startup finish before reading the library.
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let mut memory = IndexMemory::default();
        let mut backoff = std::time::Duration::from_secs(60);
        let mut pressure = crate::memory_pressure::events().subscribe();
        loop {
            if state
                .sidecar_shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            if FORGET.swap(false, std::sync::atomic::Ordering::AcqRel) {
                memory = IndexMemory::default();
            }
            // Subscribe before the pass, including native admission, so recovery
            // cannot be lost between a refusal and the retry wait.
            pressure.borrow_and_update();
            let outcome = index_pass(&state, &handle, &mut memory).await;
            crate::llm::builtin_embeddings::release_now().await;
            let mut release = None;
            let wait = match outcome {
                Ok(()) => {
                    set_last_error(None);
                    backoff = std::time::Duration::from_secs(60);
                    std::time::Duration::from_secs(120)
                }
                Err(error) if is_pause(&error) => {
                    let reason = error.to_string();
                    if last_error().as_deref() != Some(reason.as_str()) {
                        tracing::info!("Search indexing deferred: {reason}");
                    }
                    set_last_error(Some(reason));
                    release = error
                        .downcast::<Paused>()
                        .ok()
                        .and_then(|pause| pause.release);
                    // A contention pause never increases the failure backoff.
                    backoff = std::time::Duration::from_secs(60);
                    std::time::Duration::from_secs(30)
                }
                Err(error) => {
                    tracing::info!("Search indexing stopped: {error}");
                    set_last_error(Some(error.to_string()));
                    let wait = backoff;
                    backoff = (backoff * 2).min(std::time::Duration::from_secs(30 * 60));
                    wait
                }
            };
            emit_status(&handle, false);
            wait_for_index_retry(&WAKE, wait, release, &mut pressure).await;
            // New recordings arrive in bursts (transcript, then speakers).
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            crate::llm::builtin_embeddings::release_now().await;
        }
    });
}

struct ActiveFlag;
impl ActiveFlag {
    fn set() -> Self {
        ACTIVE.store(true, std::sync::atomic::Ordering::Release);
        Self
    }
}
impl Drop for ActiveFlag {
    fn drop(&mut self) {
        ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Whether the Mac is in Low Power Mode or running on battery below 20%.
/// Read at most every 30 seconds through native power APIs.
mod power {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[cfg(any(target_os = "macos", test))]
    pub(super) const LOW_BATTERY_PERCENT: u32 = 20;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Hold {
        LowPowerMode,
        LowBattery,
    }

    static CACHE: Mutex<Option<(Instant, Option<Hold>)>> = Mutex::new(None);

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn power_hold(
        low_power_mode: bool,
        power: Option<crate::llm::notes_window::Power>,
    ) -> Option<Hold> {
        use crate::llm::notes_window::Power;
        if low_power_mode {
            Some(Hold::LowPowerMode)
        } else if matches!(power, Some(Power::Battery { percent, .. }) if u32::from(percent) < LOW_BATTERY_PERCENT)
        {
            Some(Hold::LowBattery)
        } else {
            None
        }
    }

    #[cfg(target_os = "macos")]
    fn low_power_mode() -> bool {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        // SAFETY: `+[NSProcessInfo processInfo]` returns the process-wide
        // singleton, which is never deallocated, and
        // `isLowPowerModeEnabled` takes no arguments and returns a BOOL.
        unsafe {
            let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            if info.is_null() {
                return false;
            }
            msg_send![info, isLowPowerModeEnabled]
        }
    }

    #[cfg(target_os = "macos")]
    fn read() -> Option<Hold> {
        power_hold(low_power_mode(), crate::llm::notes_window::power())
    }

    #[cfg(not(target_os = "macos"))]
    fn read() -> Option<Hold> {
        None
    }

    /// Refreshes native power counters when the cached reading is stale.
    pub(super) fn hold() -> Option<Hold> {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((read_at, hold)) = *cache {
            if read_at.elapsed() < Duration::from_secs(30) {
                return hold;
            }
        }
        let hold = read();
        *cache = Some((Instant::now(), hold));
        hold
    }
}

async fn power_hold() -> Option<&'static str> {
    match tokio::task::spawn_blocking(power::hold)
        .await
        .ok()
        .flatten()
    {
        Some(power::Hold::LowPowerMode) => Some("Paused in Low Power Mode."),
        Some(power::Hold::LowBattery) => Some("Paused on battery below 20%."),
        None => None,
    }
}

/// Dictation or meeting capture in progress: the work that must have the
/// Mac's memory to itself, so the indexer drops its model rather than wait
/// with it loaded.
async fn live_work_reason(state: &crate::AppState) -> Option<&'static str> {
    {
        // A dictation stays active from the key press through decode,
        // cleanup and delivery: cleanup with the built-in model takes the
        // same native runtime.
        let tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id.is_some() || tracker.stopping_session_id.is_some() {
            return Some("Paused while you dictate.");
        }
    }
    if *state.dictation_runtime_state.lock().await != crate::DictationSessionState::Idle {
        return Some("Paused while you dictate.");
    }
    if state.active_capture_lease.lock().await.is_some() {
        return Some("Paused while you record.");
    }
    None
}

/// What, if anything, the indexer should wait for right now.
async fn busy_reason(state: &crate::AppState) -> anyhow::Result<Option<&'static str>> {
    if crate::llm::local_model_load::background_should_yield() {
        return Ok(Some("Paused while you dictate, ask or summarize."));
    }
    if let Some(reason) = live_work_reason(state).await {
        return Ok(Some(reason));
    }
    // A meeting's speaker labelling and summary run after its status is
    // already "completed"; their post-processing lease covers them.
    if state
        .operation_coordinator
        .is_active(crate::operation_coordinator::OperationKind::PostProcess)
        || state.db.lock().await.any_recording_processing()?
    {
        return Ok(Some("Paused while a recording is processed."));
    }
    Ok(None)
}

/// How long dictation, capture, processing and foreground text work must
/// have been quiet before a batch, and how long the indexer waits for that
/// before ending the pass.
struct Quiet {
    since: Option<std::time::Instant>,
}

impl Quiet {
    async fn wait(
        &mut self,
        state: &crate::AppState,
        run: &crate::llm::builtin_embeddings::EmbeddingRun,
    ) -> anyhow::Result<()> {
        if let Some(reason) = power_hold().await {
            return Err(paused(reason));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        loop {
            match busy_reason(state).await? {
                Some(reason) => {
                    self.since = None;
                    // Other work needs the Mac; the helper and its loaded
                    // model do not wait beside it. The next batch starts
                    // another helper.
                    let idle = run.clone();
                    let _ = tokio::task::spawn_blocking(move || idle.close()).await;
                    // Waiting out a call or a dictation with the search model
                    // loaded kept it beside the speech model for up to two
                    // minutes. Drop it now; the next batch reloads it.
                    if live_work_reason(state).await.is_some() {
                        crate::llm::builtin_embeddings::release_now().await;
                        return Err(paused(reason));
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(paused(reason));
                    }
                }
                None => {
                    if self
                        .since
                        .get_or_insert_with(std::time::Instant::now)
                        .elapsed()
                        >= QUIET_BEFORE_BATCH
                    {
                        return Ok(());
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
}

async fn selected_built_in(
    state: &crate::AppState,
) -> Option<&'static crate::llm::builtin_embeddings::BuiltinEmbeddingModel> {
    let sm = state.settings_manager.lock().await;
    match ActiveRoute::from_settings(&sm.settings().transcription) {
        Some(ActiveRoute::BuiltIn(model)) => Some(model),
        _ => None,
    }
}

/// Foreground text work, a dictation decode or live speech wants the runtime.
fn batch_should_yield() -> bool {
    crate::llm::local_model_load::background_should_yield()
        || crate::llm::speech_priority::speech_active()
}

/// Embed one batch as background work: give way if foreground work is
/// waiting, and mark the batch so foreground work that finds the runtime
/// busy waits for it instead of failing.
async fn embed_background_batch(
    run: &crate::llm::builtin_embeddings::EmbeddingRun,
    texts: Vec<String>,
) -> anyhow::Result<Vec<Vec<f32>>> {
    use crate::llm::builtin_embeddings as builtin;
    let run = run.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _batch = crate::llm::local_model_load::background_batch();
        if batch_should_yield() {
            return Err(paused("Paused while you dictate, ask or summarize."));
        }
        run.embed_yielding_blocking(&texts, batch_should_yield)
            .map_err(|error| {
                if error.to_string() == builtin::SEARCH_BATCH_YIELDED {
                    paused("Paused while you dictate, ask or summarize.")
                } else {
                    error
                }
            })
    })
    .await
    .map_err(|error| anyhow::anyhow!("The search model task ended: {error}"))?;
    builtin::release_now().await;
    result
}

/// What one batch holds while it runs: the rebuild semaphore, so removing a
/// model or an Ollama rebuild waits at most one batch, and an operation
/// lease, so restore and vault migration do not swap the library under it.
fn batch_leases(
    coordinator: &std::sync::Arc<crate::operation_coordinator::OperationCoordinator>,
) -> anyhow::Result<(
    tokio::sync::SemaphorePermit<'static>,
    crate::operation_coordinator::OperationLease,
)> {
    let rebuild = EMBEDDING_REBUILD
        .try_acquire()
        .map_err(|_| paused("Paused while the search index is rebuilt or a model is removed."))?;
    let lease = index_operation_lease(coordinator, crate::memory_pressure::events().current())?;
    Ok((rebuild, lease))
}

async fn index_pass(
    state: &std::sync::Arc<crate::AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    memory: &mut IndexMemory,
) -> anyhow::Result<()> {
    use crate::llm::builtin_embeddings as builtin;
    use crate::sidecar_handle::AppEmitter;
    let Some(model) = selected_built_in(state).await else {
        return Ok(());
    };
    if !builtin::runtime_compiled() {
        return Ok(());
    }
    let root = builtin::models_root()
        .ok_or_else(|| anyhow::anyhow!("Could not find the models folder"))?;
    if !builtin::artifacts_installed(&root, model) {
        return Ok(());
    }
    let key = ActiveRoute::BuiltIn(model).key();
    // On battery or in Low Power Mode, stop before loading or tokenizing any
    // transcript; the next pass checks again.
    if power_hold().await.is_some() {
        return Ok(());
    }
    let mut quiet = Quiet { since: None };
    let mut announced = false;
    // One helper for the whole pass: the model files are hashed and loaded
    // once, and the helper exits when the pass returns.
    let run = builtin::EmbeddingRun::new(&root, model);
    loop {
        // Every recording the index does not cover, newest first.
        let pending: Vec<String> = {
            let db = state.db.lock().await;
            db.recordings_missing_semantic_index(&key, 1_000_000)?
        };
        let mut progressed = false;
        for recording_id in pending {
            if state
                .sidecar_shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Ok(());
            }
            if selected_built_in(state).await.map(|selected| selected.id) != Some(model.id) {
                return Ok(());
            }
            let (transcript, fingerprint) = {
                let db = state.db.lock().await;
                let Some((transcript, _)) = db.get_transcript_with_revision(&recording_id)? else {
                    continue;
                };
                let Some(fingerprint) = db.transcript_fingerprint(&recording_id)? else {
                    continue;
                };
                (transcript, fingerprint)
            };
            if memory.should_skip(&recording_id, &fingerprint) {
                continue;
            }
            // Counting window tokens loads the model's tokenizer; leave it
            // unloaded while a dictation or a call is running.
            if let Some(reason) = live_work_reason(state).await {
                return Err(paused(reason));
            }
            let windows = {
                let _leases = batch_leases(&state.operation_coordinator)?;
                let run = run.clone();
                let recording_id = recording_id.clone();
                tokio::task::spawn_blocking(move || {
                    run.recording_windows_blocking(&recording_id, &transcript.segments)
                })
                .await
                .map_err(|error| anyhow::anyhow!("Preparing a recording stopped: {error}"))??
            };
            if windows.is_empty() {
                memory.empty.insert(recording_id, fingerprint);
                continue;
            }
            if !announced {
                announced = true;
                emit_status(handle, true);
            }
            let _active = ActiveFlag::set();
            let mut vectors = match memory.checkpoint.take() {
                Some(checkpoint)
                    if checkpoint.recording_id == recording_id
                        && checkpoint.fingerprint == fingerprint
                        && checkpoint.key == key
                        && checkpoint.vectors.len() <= windows.len() =>
                {
                    checkpoint.vectors
                }
                _ => Vec::with_capacity(windows.len()),
            };
            let mut failure = None;
            while vectors.len() < windows.len() {
                quiet.wait(state, &run).await.inspect_err(|_| {
                    memory.checkpoint = Some(Checkpoint {
                        recording_id: recording_id.clone(),
                        fingerprint: fingerprint.clone(),
                        key: key.clone(),
                        vectors: vectors.clone(),
                    });
                })?;
                let end = (vectors.len() + builtin::BATCH).min(windows.len());
                let texts: Vec<String> = windows[vectors.len()..end]
                    .iter()
                    .map(|window| window.text.clone())
                    .collect();
                let result = match batch_leases(&state.operation_coordinator) {
                    Ok(_leases) => embed_background_batch(&run, texts).await,
                    Err(error) => Err(error),
                };
                match result {
                    Ok(batch) if batch.len() == end - vectors.len() => vectors.extend(batch),
                    Ok(_) => {
                        failure = Some(anyhow::anyhow!(
                            "The search model returned too few vectors."
                        ));
                        break;
                    }
                    Err(error) if is_pause(&error) => {
                        memory.checkpoint = Some(Checkpoint {
                            recording_id: recording_id.clone(),
                            fingerprint: fingerprint.clone(),
                            key: key.clone(),
                            vectors,
                        });
                        return Err(error);
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
                tokio::task::yield_now().await;
            }
            if let Some(error) = failure {
                tracing::info!("Search indexing skipped a recording for now: {error}");
                memory.record_failure(&recording_id, &fingerprint);
                continue;
            }
            if selected_built_in(state).await.map(|selected| selected.id) != Some(model.id) {
                return Ok(());
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while SEARCHES_IN_FLIGHT.load(std::sync::atomic::Ordering::Acquire) > 0
                && std::time::Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let _leases = match batch_leases(&state.operation_coordinator) {
                Ok(leases) => leases,
                Err(error) => {
                    memory.checkpoint = Some(Checkpoint {
                        recording_id,
                        fingerprint,
                        key,
                        vectors,
                    });
                    return Err(error);
                }
            };
            let rows: Vec<(GroundedSegment, Vec<f32>)> = windows.into_iter().zip(vectors).collect();
            let written = state.db.lock().await.replace_recording_embeddings(
                &recording_id,
                &fingerprint,
                &key,
                &rows,
            )?;
            memory.failed.remove(&recording_id);
            if !written {
                continue;
            }
            progressed = true;
            let (indexed, total) = state.db.lock().await.semantic_index_coverage(&key)?;
            handle.emit_event(
                "semantic-index-progress",
                serde_json::json!({ "indexing": true, "indexed": indexed, "total": total }),
            );
        }
        if !progressed {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(id: usize, start: f64, text: &str, speaker: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("w{id}"),
            start_time: start,
            end_time: start + 0.3,
            text: text.to_string(),
            speaker_id: Some(speaker.to_string()),
            confidence: 1.0,
        }
    }

    #[test]
    fn index_lease_refusal_names_the_blocking_operation() {
        use crate::operation_coordinator::{OperationCoordinator, OperationKind};
        for (kind, name) in [
            (OperationKind::HeavyPostCall, "meeting processing"),
            (OperationKind::PostProcess, "meeting post-processing"),
            (OperationKind::Backup, "backup"),
            (OperationKind::Restore, "restore"),
            (OperationKind::VaultMigration, "vault migration"),
            (OperationKind::VaultLock, "vault lock"),
        ] {
            let coordinator = OperationCoordinator::new();
            let _owner = coordinator.try_acquire(kind).unwrap();
            let error =
                index_operation_lease(&coordinator, crate::memory_pressure::MemoryPressure::Normal)
                    .err()
                    .expect("must refuse");
            assert!(error.to_string().contains(name), "{name}: {error}");
            assert!(error.to_string().starts_with("Paused"), "{error}");
            assert!(is_pause(&error));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_before_the_retry_wait_is_not_lost() {
        use crate::operation_coordinator::{OperationCoordinator, OperationKind};
        let coordinator = OperationCoordinator::new();
        let conversion = coordinator
            .try_acquire_named(OperationKind::PostProcess, "idle meeting audio conversion")
            .unwrap();
        let pause =
            index_operation_lease(&coordinator, crate::memory_pressure::MemoryPressure::Normal)
                .err()
                .unwrap()
                .downcast::<Paused>()
                .unwrap();
        assert!(pause.reason.contains("idle meeting audio conversion"));
        // Release before polling the wait, the race that plain notify_waiters loses.
        drop(conversion);
        let (_sender, mut pressure) =
            tokio::sync::watch::channel(crate::memory_pressure::MemoryPressure::Normal);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            wait_for_index_retry(
                &tokio::sync::Notify::new(),
                std::time::Duration::from_secs(900),
                pause.release,
                &mut pressure,
            ),
        )
        .await
        .expect("retry must follow release, not the fallback timer");
        assert!(index_operation_lease(
            &coordinator,
            crate::memory_pressure::MemoryPressure::Normal
        )
        .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn pressure_recovery_wakes_a_paused_index_without_failure_backoff() {
        use crate::memory_pressure::MemoryPressure;
        let (sender, mut pressure) = tokio::sync::watch::channel(MemoryPressure::Warning);
        let wake = tokio::sync::Notify::new();
        let wait = wait_for_index_retry(
            &wake,
            std::time::Duration::from_secs(900),
            None,
            &mut pressure,
        );
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut wait)
                .await
                .is_err()
        );
        sender.send_replace(MemoryPressure::Normal);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .expect("normal pressure must wake indexing at once");
        assert!(is_pause(&anyhow::Error::msg(
            "Search helper job did not complete: Native memory admission deferred by memory pressure: normal pressure required; MemorySnapshot { pressure_level: 2 }"
        )));
    }

    /// Cross-module ordering check using the real coordinator, meeting audio
    /// guard and database. Vectors are synthetic; no model admission is bypassed.
    #[tokio::test(start_paused = true)]
    async fn finished_meeting_transcript_recap_conversion_then_index_do_not_starve() {
        use crate::operation_coordinator::{OperationCoordinator, OperationKind};
        let coordinator = OperationCoordinator::new();
        let (mut db, path) = library();
        db.update_recording_status("r1", "recording").unwrap();
        let capture = coordinator.try_acquire(OperationKind::Capture).unwrap();
        assert!(index_operation_lease(
            &coordinator,
            crate::memory_pressure::MemoryPressure::Normal
        )
        .is_err());
        drop(capture);
        let active = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let transcript = crate::MeetingAudioPostprocessingGuard::coordinated(
            active.clone(),
            "r1",
            coordinator.try_acquire(OperationKind::PostProcess).unwrap(),
        );
        let (mut stored, _) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        stored.segments[0].text = "the finished meeting transcript".into();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            coordinator.run_post_call("meeting transcript and recap", async {
                let _transcript = transcript;
                db.save_transcript(&stored).unwrap();
                db.update_recording_status("r1", "completed").unwrap();
                assert!(index_operation_lease(
                    &coordinator,
                    crate::memory_pressure::MemoryPressure::Normal
                )
                .err()
                .unwrap()
                .to_string()
                .contains("meeting transcript and recap"));
                // Real same-task nesting must share the outer lease.
                coordinator
                    .run_post_call("meeting recap", async {
                        db.update_recording_analysis("r1", Some("the recap"), &[])
                            .unwrap();
                    })
                    .await;
            }),
        )
        .await
        .expect("post-call nesting must not deadlock");
        assert!(active.lock().unwrap().is_empty());
        let conversion = coordinator
            .try_acquire_named(OperationKind::PostProcess, "idle meeting audio conversion")
            .unwrap();
        let pause =
            index_operation_lease(&coordinator, crate::memory_pressure::MemoryPressure::Normal)
                .err()
                .unwrap()
                .downcast::<Paused>()
                .unwrap();
        let (_sender, mut pressure) =
            tokio::sync::watch::channel(crate::memory_pressure::MemoryPressure::Normal);
        let wake = tokio::sync::Notify::new();
        let wait = wait_for_index_retry(
            &wake,
            std::time::Duration::from_secs(900),
            pause.release,
            &mut pressure,
        );
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut wait)
                .await
                .is_err()
        );
        // Status commands do not release the post-call owner or wake the retry.
        drop(coordinator.try_acquire(OperationKind::Command).unwrap());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut wait)
                .await
                .is_err()
        );
        drop(conversion);
        tokio::time::timeout(std::time::Duration::from_secs(1), wait)
            .await
            .expect("indexing must run after conversion releases");
        let _index =
            index_operation_lease(&coordinator, crate::memory_pressure::MemoryPressure::Normal)
                .unwrap();
        let key = index_key(SemanticRoute::BuiltIn("ordering-test"));
        let fingerprint = db.transcript_fingerprint("r1").unwrap().unwrap();
        let rows = estimated_windows("r1", &stored.segments)
            .into_iter()
            .map(|window| (window, vec![1.0_f32, 0.0]))
            .collect::<Vec<_>>();
        assert!(db
            .replace_recording_embeddings("r1", &fingerprint, &key, &rows)
            .unwrap());
        assert!(db.recording_has_embeddings_with_model("r1", &key).unwrap());
        assert_eq!(
            db.get_recording("r1").unwrap().unwrap().summary.as_deref(),
            Some("the recap")
        );
        assert!(!db
            .search_transcripts_with_scope("finished meeting", 10, None, None)
            .unwrap()
            .is_empty());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn word_rows_become_windows_that_keep_the_first_identity_and_span() {
        let mut segments = Vec::new();
        for index in 0..250 {
            let speaker = if (index / 10) % 2 == 0 { "s1" } else { "s2" };
            segments.push(word(index, index as f64 * 0.4, "battery", speaker));
        }
        let windows = estimated_windows("r1", &segments);
        assert_eq!(windows.len(), 3);
        assert!(windows
            .iter()
            .all(|window| window.text.split_whitespace().count() <= WINDOW_MAX_WORDS));
        assert_eq!(windows[0].segment_id, "w0");
        assert_eq!(windows[0].start_time, 0.0);
        assert_eq!(windows[1].segment_id, "w100");
        let total: usize = windows
            .iter()
            .map(|window| window.text.split_whitespace().count())
            .sum();
        assert_eq!(total, 250);
        assert!(windows.iter().all(|window| window.recording_id == "r1"));
    }

    fn row(id: &str, start: f64, end: f64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: id.into(),
            start_time: start,
            end_time: end,
            text: text.into(),
            speaker_id: None,
            confidence: 1.0,
        }
    }

    #[test]
    fn blank_rows_are_skipped_and_one_long_row_is_split_with_interpolated_times() {
        let long = (0..250)
            .map(|index| format!("w{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let segments = vec![row("blank", 0.0, 1.0, "  "), row("long", 0.0, 250.0, &long)];
        let windows = estimated_windows("r1", &segments);
        assert_eq!(windows.len(), 3);
        assert!(windows.iter().all(|window| window.segment_id == "long"));
        assert!(windows
            .iter()
            .all(|window| window.text.split_whitespace().count() <= WINDOW_MAX_WORDS));
        assert_eq!(windows[0].start_time, 0.0);
        assert!((windows[1].start_time - 100.0).abs() < 1e-9);
        assert!((windows[2].end_time - 250.0).abs() < 1e-9);
        let rejoined: Vec<String> = windows.iter().map(|window| window.text.clone()).collect();
        assert_eq!(rejoined.join(" "), long);
        for window in &windows {
            assert!(window_matches_transcript(window, &segments));
        }
        assert!(estimated_windows("r1", &[]).is_empty());
    }

    #[test]
    fn unspaced_text_is_capped_by_tokens_not_words() {
        // One "word" of 900 CJK characters: the word cap never trips.
        let text = "会".repeat(900);
        let segments = vec![row("cjk", 0.0, 90.0, &text)];
        let windows = estimated_windows("r1", &segments);
        assert!(windows.len() >= 5);
        for window in &windows {
            assert!(
                crate::llm::builtin_embeddings::estimated_tokens(&window.text) <= WINDOW_MAX_TOKENS
            );
        }
        // A tokenizer that counts more tokens makes smaller windows.
        let doubled = |text: &str| 2 * crate::llm::builtin_embeddings::estimated_tokens(text);
        let small = index_windows("r1", &segments, &doubled);
        assert!(small.len() > windows.len());
        assert!(small
            .iter()
            .all(|window| doubled(&window.text) <= WINDOW_MAX_TOKENS));
    }

    #[test]
    fn a_long_pause_starts_a_new_window() {
        let segments = vec![
            row("a", 0.0, 1.0, "before the break"),
            row("b", 100.0, 101.0, "after the break"),
        ];
        let windows = estimated_windows("r1", &segments);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[1].start_time, 100.0);
        let close = vec![
            row("a", 0.0, 1.0, "before the break"),
            row("b", 20.0, 21.0, "after the break"),
        ];
        assert_eq!(estimated_windows("r1", &close).len(), 1);
    }

    #[test]
    fn windows_are_checked_against_the_transcript_whatever_built_them() {
        let segments = vec![
            row("a", 0.0, 1.0, "We chose"),
            row("b", 1.0, 2.0, "the kinetic"),
            row("c", 2.0, 3.0, "battery today"),
        ];
        let window = |segment_id: &str, text: &str, start: f64, end: f64| GroundedSegment {
            recording_id: "r1".into(),
            segment_id: segment_id.into(),
            text: text.into(),
            start_time: start,
            end_time: end,
        };
        assert!(window_matches_transcript(
            &window("a", "We chose the kinetic battery today", 0.0, 3.0),
            &segments
        ));
        assert!(window_matches_transcript(
            &window("b", "the kinetic", 1.0, 2.0),
            &segments
        ));
        // Wrong start row, changed words, times outside the rows, NaN.
        assert!(!window_matches_transcript(
            &window("a", "the kinetic", 1.0, 2.0),
            &segments
        ));
        assert!(!window_matches_transcript(
            &window("a", "We chose the solar battery", 0.0, 3.0),
            &segments
        ));
        assert!(!window_matches_transcript(
            &window("a", "We chose", 0.0, 9.0),
            &segments
        ));
        assert!(!window_matches_transcript(
            &window("a", "We chose", f64::NAN, 1.0),
            &segments
        ));
    }

    fn library() -> (crate::db::Database, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "plainsong-semantic-index-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut db = crate::db::Database::open_at_path(&path, None).unwrap();
        let now = chrono::Utc::now();
        for (id, status) in [
            ("r1", "completed"),
            ("r2", "completed"),
            ("live", "recording"),
        ] {
            let recording: crate::models::Recording = serde_json::from_value(serde_json::json!({
                "id": id, "title": "Public review", "projectId": "inbox", "duration": 60,
                "createdAt": now, "updatedAt": now, "sourceType": "meeting",
                "audioPath": "", "status": status, "transcriptComplete": true,
            }))
            .unwrap();
            db.create_recording(&recording).unwrap();
            let segments: Vec<TranscriptSegment> = (0..150)
                .map(|index| {
                    word(
                        index,
                        index as f64 * 0.4,
                        if index == 120 { "kinetic" } else { "battery" },
                        "s1",
                    )
                })
                .collect();
            db.save_transcript(&crate::models::Transcript {
                heard_through_speakers: Vec::new(),
                id: format!("t-{id}"),
                recording_id: id.into(),
                segments,
                full_text: String::new(),
                language: "en".into(),
                confidence: 1.0,
                model: "test".into(),
                model_id: None,
                requested_provider: None,
                actual_provider: None,
                measured_word_timestamps: true,
                created_at: now,
            })
            .unwrap();
        }
        (db, path)
    }

    #[test]
    fn recordings_are_indexed_once_and_only_against_the_transcript_they_came_from() {
        let (mut db, path) = library();
        let key = index_key(SemanticRoute::BuiltIn("m"));
        assert_eq!(
            db.recordings_missing_semantic_index(&key, 10)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(db.semantic_index_coverage(&key).unwrap(), (0, 3));
        let (transcript, _) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        let fingerprint = db.transcript_fingerprint("r1").unwrap().unwrap();
        let windows = estimated_windows("r1", &transcript.segments);
        let rows: Vec<_> = windows
            .iter()
            .cloned()
            .map(|window| (window, vec![1.0_f32, 0.0]))
            .collect();
        assert!(!db
            .replace_recording_embeddings("r1", "not-the-fingerprint", &key, &rows)
            .unwrap());
        assert!(db
            .replace_recording_embeddings("r1", &fingerprint, &key, &rows)
            .unwrap());
        assert_eq!(
            db.recordings_missing_semantic_index(&key, 10).unwrap(),
            vec!["r2".to_string()]
        );
        assert_eq!(db.semantic_index_coverage(&key).unwrap(), (1, 3));
        assert!(db.recording_has_embeddings_with_model("r1", &key).unwrap());
        let mut bad = rows.clone();
        bad[1].1 = vec![1.0];
        assert!(db
            .replace_recording_embeddings("r1", &fingerprint, &key, &bad)
            .is_err());
        // An edit invalidates the recording's vectors, so it is picked up again.
        let first = transcript.segments[0].id.clone();
        db.update_transcript_segment("r1", &first, "changed")
            .unwrap();
        assert!(!db.recording_has_embeddings_with_model("r1", &key).unwrap());
        db.delete_embeddings_with_model(&key).unwrap();
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_retranscription_that_resets_the_revision_still_rejects_old_vectors() {
        let (mut db, path) = library();
        let key = index_key(SemanticRoute::BuiltIn("m"));
        let (mut transcript, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        assert_eq!(revision, 0);
        let before = db.transcript_fingerprint("r1").unwrap().unwrap();
        let rows: Vec<_> = estimated_windows("r1", &transcript.segments)
            .into_iter()
            .map(|window| (window, vec![1.0_f32, 0.0]))
            .collect();
        transcript.segments[0].text = "different".into();
        db.save_transcript(&transcript).unwrap();
        let (_, revision) = db.get_transcript_with_revision("r1").unwrap().unwrap();
        assert_eq!(revision, 0, "a new transcript starts again at revision 0");
        assert_ne!(db.transcript_fingerprint("r1").unwrap().unwrap(), before);
        assert!(!db
            .replace_recording_embeddings("r1", &before, &key, &rows)
            .unwrap());
        assert!(db.semantic_index_windows("r1", &key).unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    fn hit(segment_id: &str, start: f64, end: f64, text: &str) -> crate::models::SearchHit {
        crate::models::SearchHit {
            recording_id: "r1".into(),
            recording_title: String::new(),
            project_id: String::new(),
            segment_id: segment_id.into(),
            text: text.into(),
            start_time: start,
            end_time: end,
            score: 1.0,
        }
    }

    #[test]
    fn untimed_and_zero_timed_hits_map_by_row_not_by_time() {
        // Three rows, all timed at zero, far enough apart in words to make
        // three windows.
        let words = |tag: &str| {
            (0..90)
                .map(|index| format!("{tag}{index}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let segments = vec![
            row("a", 0.0, 0.0, &words("a")),
            row("b", 0.0, 0.0, &words("b")),
            row("c", 0.0, 0.0, &words("c")),
        ];
        let windows = estimated_windows("r1", &segments);
        assert_eq!(windows.len(), 3);
        let ids = row_ids(&segments);
        let positioned: Vec<_> = windows
            .iter()
            .cloned()
            .map(|window| (row_position(&ids, &window), window))
            .collect();
        let found = window_for_hit(&hit("c", 0.0, 0.0, "c5"), &ids, &positioned).unwrap();
        assert_eq!(positioned[found].1.segment_id, "c");
        // An unknown row timed at zero matches nothing rather than window one.
        assert!(window_for_hit(&hit("gone", 0.0, 0.0, "x"), &ids, &positioned).is_none());
        // An unknown row with real times falls back to time.
        let timed = vec![row("a", 0.0, 10.0, "first"), row("b", 50.0, 60.0, "second")];
        let timed_windows: Vec<_> = estimated_windows("r1", &timed)
            .into_iter()
            .map(|window| (None, window))
            .collect();
        let found = window_for_hit(
            &hit("gone", 55.0, 56.0, "x"),
            &RowIds::new(),
            &timed_windows,
        )
        .unwrap();
        assert_eq!(timed_windows[found].1.segment_id, "b");
    }

    fn passage(recording: &str, id: &str) -> GroundedSegment {
        GroundedSegment {
            recording_id: recording.into(),
            segment_id: id.into(),
            text: format!("{recording} {id}"),
            start_time: 0.0,
            end_time: 1.0,
        }
    }

    #[test]
    fn fusion_favours_passages_both_rankings_found_and_keeps_top_word_hits() {
        let semantic: Vec<_> = (0..10)
            .map(|index| passage("m", &format!("s{index}")))
            .collect();
        let mut words: Vec<_> = vec![passage("m", "s5"), passage("w", "po-4471")];
        words.extend((0..10).map(|index| passage("w", &format!("x{index}"))));
        let fused = fuse_rankings(&semantic, &words, 6, 2);
        assert_eq!(fused.len(), 6);
        // Found both ways, it rises to the top.
        assert_eq!(fused[0].segment_id, "s5");
        // The exact-number passage word search ranked second is kept.
        assert!(fused.iter().any(|window| window.segment_id == "po-4471"));
        // Without meaning hits, the result is word search's own order.
        let only_words = fuse_rankings(&[], &words, 4, 2);
        assert_eq!(
            only_words
                .iter()
                .map(|window| window.segment_id.as_str())
                .collect::<Vec<_>>(),
            vec!["s5", "po-4471", "x0", "x1"]
        );
    }

    #[test]
    fn indexing_power_thresholds_are_unchanged() {
        use crate::llm::notes_window::Power;
        for percent in 0..=100 {
            let battery = Some(Power::Battery {
                percent,
                low_power: false,
            });
            assert_eq!(
                power::power_hold(false, battery),
                (percent < 20).then_some(power::Hold::LowBattery)
            );
            assert_eq!(
                power::power_hold(true, battery),
                Some(power::Hold::LowPowerMode)
            );
        }
        assert_eq!(power::power_hold(false, Some(Power::Ac)), None);
        assert_eq!(power::power_hold(false, None), None);
        assert_eq!(
            power::power_hold(true, Some(Power::Ac)),
            Some(power::Hold::LowPowerMode)
        );
        assert_eq!(
            power::power_hold(true, None),
            Some(power::Hold::LowPowerMode)
        );
    }

    #[test]
    fn failing_recordings_back_off_without_blocking_others_and_empty_ones_are_remembered() {
        let mut memory = IndexMemory::default();
        memory.record_failure("bad", "f1");
        assert!(memory.should_skip("bad", "f1"));
        // Changed text is tried again at once.
        assert!(!memory.should_skip("bad", "f2"));
        assert!(!memory.should_skip("good", "f1"));
        let first = memory.failed["bad"].2;
        memory.record_failure("bad", "f1");
        assert_eq!(memory.failed["bad"].2, first * 2);
        memory.empty.insert("silent".into(), "f3".into());
        assert!(memory.should_skip("silent", "f3"));
        assert!(!memory.should_skip("silent", "f4"));
    }

    #[test]
    fn pauses_are_told_apart_from_failures() {
        assert!(is_pause(&paused("Paused while you dictate.")));
        assert!(is_pause(&anyhow::anyhow!(
            crate::llm::builtin_embeddings::SEARCH_AWAY_WINDOW_ENDED
        )));
        assert!(is_pause(&anyhow::anyhow!(
            "Another local text operation is running. Try again after it finishes."
        )));
        assert!(!is_pause(&anyhow::anyhow!(
            "The search model returned an unusable vector."
        )));
    }

    #[test]
    fn word_hits_widen_to_their_windows_without_repeats() {
        let (db, path) = library();
        let hits = db
            .search_transcripts_with_scope("kinetic battery", 50, None, None)
            .unwrap();
        assert!(!hits.is_empty());
        let windows = hits_to_windows(&db, &hits, 3, None).unwrap();
        assert!(!windows.is_empty() && windows.len() <= 3);
        let mut seen = std::collections::HashSet::new();
        for window in &windows {
            assert!(window.text.split_whitespace().count() > 1);
            assert!(seen.insert((window.recording_id.clone(), window.segment_id.clone())));
        }
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ollama_models_get_the_prefixes_they_were_trained_with() {
        assert_eq!(
            ollama_prefixes("nomic-embed-text:latest").0,
            "search_query: "
        );
        assert_eq!(ollama_prefixes("embeddinggemma").1, "title: none | text: ");
        assert!(ollama_prefixes("qwen3-embedding:0.6b")
            .0
            .starts_with("Instruct:"));
        assert_eq!(ollama_prefixes("my-own-model"), ("", ""));
    }

    #[test]
    fn routes_follow_the_settings_and_old_ollama_indexes_stay_readable() {
        let mut settings = crate::settings::TranscriptionSettings::default();
        assert_eq!(settings.memory_search_mode, MODE_WORDS);
        assert!(ActiveRoute::from_settings(&settings).is_none());
        settings.memory_search_mode = MODE_BUILT_IN.into();
        settings.builtin_embedding_model = "not-a-model".into();
        let route = ActiveRoute::from_settings(&settings).unwrap();
        assert_eq!(
            route.key(),
            index_key(SemanticRoute::BuiltIn(
                crate::llm::builtin_embeddings::DEFAULT_MODEL_ID
            ))
        );
        assert!(route.legacy_key().is_none());
        // A model whose terms need accepting searches by words until they are.
        settings.builtin_embedding_model = "embeddinggemma-300m".into();
        assert!(ActiveRoute::from_settings(&settings).is_none());
        settings.builtin_embedding_terms_acceptances.push(
            crate::settings::EmbeddingTermsAcceptance {
                model_id: "embeddinggemma-300m".into(),
                terms_url: "https://ai.google.dev/gemma/terms".into(),
                accepted_at: "2026-10-21T00:00:00Z".into(),
            },
        );
        assert_eq!(
            ActiveRoute::from_settings(&settings).unwrap().key(),
            "builtin:embeddinggemma-300m:w2"
        );
        settings.memory_search_mode = MODE_OLLAMA.into();
        settings.embedding_model = "nomic-embed-text".into();
        let route = ActiveRoute::from_settings(&settings).unwrap();
        assert_eq!(route.legacy_key().as_deref(), Some("nomic-embed-text"));
        settings.embedding_model = "  ".into();
        assert!(ActiveRoute::from_settings(&settings).is_none());
    }

    #[test]
    fn index_keys_name_route_model_and_rule() {
        assert_eq!(
            index_key(SemanticRoute::BuiltIn("embeddinggemma-300m")),
            "builtin:embeddinggemma-300m:w2"
        );
        assert_eq!(
            index_key(SemanticRoute::Ollama(" nomic-embed-text ")),
            "ollama:nomic-embed-text:w2"
        );
    }
}
