//! Telling the far side heard through the speakers apart from what the user
//! said.
//!
//! Without headphones the microphone picks up the meeting audio too, so one
//! remote sentence arrives twice: cleanly on the system track ("them") and
//! again, fainter and a little later, on the microphone ("me"). Showing both
//! puts the other person's words in the user's mouth. Hiding the wrong one is
//! worse: it removes something the user actually said, and a user who answers
//! "we should *not* ship the patch today" to "we should ship the patch today"
//! has said the opposite in six of the same seven words.
//!
//! So the rule is narrow, and every doubt keeps the user's words:
//!
//! - Both tracks are compared as time-aligned word sequences, whatever shape
//!   the recognizer returned them in (one row per word, which the default
//!   local route emits once alignment completes, or one row per sentence).
//! - A microphone utterance counts as bleed only if its words, ignoring case,
//!   punctuation and hesitation sounds ("um", "uh"), are *exactly* a run of
//!   the far side's words. One differing negation, number, amount, name or
//!   condition, and it is the user's own.
//! - The two copies must line up in time the way an echo does: starting with
//!   the far side or a little after it, never a beat later as a repetition
//!   would.
//! - When the two recordings are available, the microphone's loudness has to
//!   follow the far side's at that moment, the acoustic signature of a speaker
//!   feeding a microphone. Someone repeating a sentence after it ended does
//!   that while the far side is silent.
//! - And the microphone's copy has to be the quieter one. A speaker heard
//!   across the room reaches the microphone below the level the far side
//!   played at; the user's own voice is loudest at their own microphone, even
//!   when the far side carries it too (a colleague's open microphone in the
//!   same room, or a far end that echoes the user back).
//!
//! Nothing is deleted. Rows judged to be bleed are moved aside, out of the
//! transcript text, search and summaries, and kept with the transcript so the
//! meeting view can show them on request.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::models;

/// Seconds either side of a microphone utterance in which far-side words are
/// considered at all. Generous, because the two tracks are chunked and
/// segmented separately; the timing rule below is what decides.
const BLEED_SEARCH_WINDOW_SECONDS: f64 = 2.0;

/// How far an echo may start *before* the far-side copy (timestamp jitter
/// between two separately recognised tracks) and how far after it (output
/// latency, the trip from speaker to microphone, and that jitter).
const BLEED_EARLIEST_OFFSET_SECONDS: f64 = -0.5;
const BLEED_LATEST_OFFSET_SECONDS: f64 = 1.0;

/// A pause longer than this between two microphone words starts a new
/// utterance.
const UTTERANCE_GAP_SECONDS: f64 = 0.8;

/// Shortest utterance, in words that carry meaning, that may be treated as
/// bleed. "Yes", "okay, sure" are too likely to be the user agreeing out loud
/// with what they just heard.
const BLEED_MIN_WORDS: usize = 3;

/// Hesitation sounds that recognisers transcribe inconsistently on the two
/// tracks. Only pure hesitations: "like", "so" and "well" can carry meaning.
const HESITATIONS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm",
];

#[derive(Debug, Clone)]
struct TimedWord {
    start: f64,
    end: f64,
    token: String,
    /// The sentence mark the recogniser put on this word, if any.
    mark: Option<char>,
    row: usize,
    /// Words in the row this word came from: 1 for a word row.
    row_words: usize,
}

/// Normalise one word for comparison: lower case, surrounding punctuation
/// removed, typographic apostrophes straightened. Inner punctuation stays, so
/// "1,200" and "12,000" or "1.5" and "15" never compare equal; currency and
/// percent signs stay too.
fn normalize_word(raw: &str) -> String {
    let keep_edge = |character: char| {
        character.is_alphanumeric() || matches!(character, '$' | '€' | '£' | '¥' | '%')
    };
    raw.replace(['\u{2019}', '\u{2018}'], "'")
        .trim_matches(|character: char| !keep_edge(character))
        .to_lowercase()
}

fn sentence_mark(raw: &str) -> Option<char> {
    raw.trim_end_matches(['"', '\'', ')', '\u{201d}'])
        .chars()
        .last()
        .filter(|character| matches!(character, '.' | '?' | '!'))
}

/// Spread each timed row's words across its span. A word row stays one word;
/// a sentence row's words share its span evenly, which is all the timing a
/// sentence row offers.
fn timed_words(segments: &[models::TranscriptSegment], speaker: &str) -> Vec<TimedWord> {
    let mut words = Vec::new();
    for (row, segment) in segments.iter().enumerate() {
        if segment.speaker_id.as_deref() != Some(speaker) || segment.end_time <= segment.start_time
        {
            continue;
        }
        let raw: Vec<&str> = segment.text.split_whitespace().collect();
        if raw.is_empty() {
            continue;
        }
        let step = (segment.end_time - segment.start_time) / raw.len() as f64;
        for (index, word) in raw.iter().enumerate() {
            let token = normalize_word(word);
            if token.is_empty() || HESITATIONS.contains(&token.as_str()) {
                continue;
            }
            let start = segment.start_time + step * index as f64;
            words.push(TimedWord {
                start,
                end: start + step,
                token,
                mark: sentence_mark(word),
                row,
                row_words: raw.len(),
            });
        }
    }
    words.sort_by(|left, right| left.start.total_cmp(&right.start));
    words
}

/// Where one utterance ends and the next begins: a pause, a sentence mark,
/// or the edge of a sentence row (the recogniser's own segmentation). Word
/// rows carry no segmentation of their own, so between two of them only a
/// pause or a sentence mark counts.
fn starts_new_utterance(previous: &TimedWord, word: &TimedWord) -> bool {
    word.start - previous.end > UTTERANCE_GAP_SECONDS
        || previous.mark.is_some()
        || (previous.row != word.row && (previous.row_words > 1 || word.row_words > 1))
}

fn utterances(words: Vec<TimedWord>) -> Vec<Vec<TimedWord>> {
    let mut groups: Vec<Vec<TimedWord>> = Vec::new();
    for word in words {
        match groups.last_mut() {
            Some(group)
                if group
                    .last()
                    .is_some_and(|last| !starts_new_utterance(last, &word)) =>
            {
                group.push(word)
            }
            _ => groups.push(vec![word]),
        }
    }
    groups
}

/// A question and a statement in the same words are different things, but
/// only when both recognisers marked the sentence.
fn marks_conflict(left: Option<char>, right: Option<char>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => (left == '?') != (right == '?'),
        _ => false,
    }
}

/// Whether the microphone's loudness follows the far side's at a moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcousticVerdict {
    /// It does: a speaker feeding the microphone.
    Bleed,
    /// It does not, or there is not enough far-side sound to tell.
    NotBleed,
}

/// Loudness envelopes of the two meeting tracks, for the acoustic check.
pub(crate) struct BleedAcoustics {
    mic_db: Vec<f32>,
    system_db: Vec<f32>,
}

/// Envelope resolution: 20 ms frames, fine enough to follow syllables.
const ENVELOPE_FRAME_SECONDS: f64 = 0.02;
/// Echo delays searched, in frames: 0 to 500 ms.
const ENVELOPE_MAX_LAG_FRAMES: usize = 25;
/// Far-side loudness that counts as sound (about -50 dBFS).
const ENVELOPE_ACTIVE_DB: f32 = -50.0;
/// Share of the utterance in which the far side must be sounding.
const ENVELOPE_MIN_ACTIVE_SHARE: f64 = 0.3;
/// Correlation of the two envelopes that marks the microphone as following
/// the far side.
const ENVELOPE_MIN_CORRELATION: f64 = 0.6;
/// Fewest frames that can be judged at all (200 ms).
const ENVELOPE_MIN_FRAMES: usize = 10;
/// Loudness level compared between the tracks: the 90th percentile of each
/// utterance window's envelope, i.e. how loud the speech in it gets, which
/// does not depend on the two envelopes lining up frame by frame (an echo
/// that comes back later than the user spoke does not).
const ENVELOPE_LEVEL_PERCENTILE: f64 = 0.9;

fn rms_db(sum_squares: f64, frames: usize) -> f32 {
    let rms = (sum_squares / frames.max(1) as f64).sqrt();
    (20.0 * (rms + 1.0e-6).log10()) as f32
}

fn envelope_db(samples: impl Iterator<Item = f32>, sample_rate: u32) -> Vec<f32> {
    let frame = ((f64::from(sample_rate) * ENVELOPE_FRAME_SECONDS).round() as usize).max(1);
    let mut envelope = Vec::new();
    let (mut sum, mut count) = (0.0_f64, 0usize);
    for sample in samples {
        sum += f64::from(sample) * f64::from(sample);
        count += 1;
        if count == frame {
            envelope.push(rms_db(sum, count));
            sum = 0.0;
            count = 0;
        }
    }
    if count > 0 {
        envelope.push(rms_db(sum, count));
    }
    envelope
}

fn wav_envelope(path: &Path) -> Option<Vec<f32>> {
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }
    let channels = usize::from(spec.channels);
    let samples: Box<dyn Iterator<Item = f32> + '_> = match spec.sample_format {
        hound::SampleFormat::Float => Box::new(reader.samples::<f32>().map_while(Result::ok)),
        hound::SampleFormat::Int => {
            let scale = 2.0_f32.powi(i32::from(spec.bits_per_sample.clamp(1, 32)) - 1);
            Box::new(
                reader
                    .samples::<i32>()
                    .map_while(Result::ok)
                    .map(move |sample| sample as f32 / scale),
            )
        }
    };
    // Mono, by averaging each frame's channels.
    let mut pending = Vec::with_capacity(channels);
    let mono = samples.filter_map(move |sample| {
        pending.push(sample);
        (pending.len() == channels).then(|| {
            let mean = pending.iter().sum::<f32>() / channels as f32;
            pending.clear();
            mean
        })
    });
    Some(envelope_db(mono, spec.sample_rate))
}

/// The `fraction` percentile of `values`, interpolating between neighbours.
fn percentile(values: &[f32], fraction: f64) -> f64 {
    let mut sorted: Vec<f64> = values.iter().map(|value| f64::from(*value)).collect();
    sorted.sort_by(f64::total_cmp);
    let Some(top) = sorted.len().checked_sub(1) else {
        return f64::MIN;
    };
    let rank = fraction.clamp(0.0, 1.0) * top as f64;
    let (below, above) = (rank.floor() as usize, rank.ceil() as usize);
    sorted[below] + (sorted[above] - sorted[below]) * (rank - below as f64)
}

fn pearson(left: &[f32], right: &[f32]) -> f64 {
    let count = left.len().min(right.len());
    if count < 2 {
        return 0.0;
    }
    let mean =
        |values: &[f32]| values[..count].iter().map(|v| f64::from(*v)).sum::<f64>() / count as f64;
    let (left_mean, right_mean) = (mean(left), mean(right));
    let (mut covariance, mut left_variance, mut right_variance) = (0.0, 0.0, 0.0);
    for index in 0..count {
        let a = f64::from(left[index]) - left_mean;
        let b = f64::from(right[index]) - right_mean;
        covariance += a * b;
        left_variance += a * a;
        right_variance += b * b;
    }
    if left_variance <= f64::EPSILON || right_variance <= f64::EPSILON {
        return 0.0;
    }
    covariance / (left_variance.sqrt() * right_variance.sqrt())
}

impl BleedAcoustics {
    /// Read both meeting tracks. `None` when either cannot be read, and the
    /// text and timing rules then decide alone.
    pub(crate) fn from_wav_files(mic: &Path, system: &Path) -> Option<Self> {
        Some(Self {
            mic_db: wav_envelope(mic)?,
            system_db: wav_envelope(system)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_samples(mic: &[f32], system: &[f32], sample_rate: u32) -> Self {
        Self {
            mic_db: envelope_db(mic.iter().copied(), sample_rate),
            system_db: envelope_db(system.iter().copied(), sample_rate),
        }
    }

    pub(crate) fn verdict(&self, start: f64, end: f64) -> AcousticVerdict {
        let first = (start.max(0.0) / ENVELOPE_FRAME_SECONDS).floor() as usize;
        let last = ((end / ENVELOPE_FRAME_SECONDS).ceil() as usize)
            .min(self.mic_db.len())
            .min(self.system_db.len());
        if last <= first || last - first < ENVELOPE_MIN_FRAMES {
            return AcousticVerdict::NotBleed;
        }
        let mic = &self.mic_db[first..last];
        let mut best: Option<(f64, usize)> = None;
        for lag in 0..=ENVELOPE_MAX_LAG_FRAMES.min(first) {
            let system = &self.system_db[first - lag..last - lag];
            let active = system
                .iter()
                .filter(|db| **db >= ENVELOPE_ACTIVE_DB)
                .count();
            if (active as f64) < ENVELOPE_MIN_ACTIVE_SHARE * system.len() as f64 {
                continue;
            }
            let correlation = pearson(mic, system);
            if best.is_none_or(|(highest, _)| correlation > highest) {
                best = Some((correlation, lag));
            }
        }
        let Some((_, lag)) =
            best.filter(|(correlation, _)| *correlation >= ENVELOPE_MIN_CORRELATION)
        else {
            return AcousticVerdict::NotBleed;
        };
        // Louder at the microphone than on the far side: it started there.
        let system = &self.system_db[first - lag..last - lag];
        if percentile(mic, ENVELOPE_LEVEL_PERCENTILE)
            > percentile(system, ENVELOPE_LEVEL_PERCENTILE)
        {
            AcousticVerdict::NotBleed
        } else {
            AcousticVerdict::Bleed
        }
    }
}

/// The rows of `segments` that are the far side heard through the speakers.
///
/// Only rows spoken by "me" are ever returned, and only whole utterances: a
/// microphone utterance that mixes the user's own words with the far side's
/// is kept entirely.
pub(crate) fn far_side_bleed_rows(
    segments: &[models::TranscriptSegment],
    acoustics: Option<&BleedAcoustics>,
) -> HashSet<usize> {
    let far_side = timed_words(segments, "them");
    if far_side.is_empty() {
        return HashSet::new();
    }
    let near_side = timed_words(segments, "me");
    let mut words_per_row: HashMap<usize, usize> = HashMap::new();
    for word in &near_side {
        *words_per_row.entry(word.row).or_default() += 1;
    }
    let mut bleed_words_per_row: HashMap<usize, usize> = HashMap::new();
    for utterance in utterances(near_side) {
        if utterance.len() < BLEED_MIN_WORDS {
            continue;
        }
        let (Some(first), Some(last)) = (utterance.first(), utterance.last()) else {
            continue;
        };
        let nearby: Vec<&TimedWord> = far_side
            .iter()
            .filter(|word| {
                word.end >= first.start - BLEED_SEARCH_WINDOW_SECONDS
                    && word.start <= last.end + BLEED_SEARCH_WINDOW_SECONDS
            })
            .collect();
        let echoed = nearby.windows(utterance.len()).any(|run| {
            let same_words = run
                .iter()
                .zip(&utterance)
                .all(|(far, near)| far.token == near.token && !marks_conflict(far.mark, near.mark));
            let start_offset = first.start - run[0].start;
            let end_offset = last.end - run[run.len() - 1].end;
            let in_step = |offset: f64| {
                (BLEED_EARLIEST_OFFSET_SECONDS..=BLEED_LATEST_OFFSET_SECONDS).contains(&offset)
            };
            same_words && in_step(start_offset) && in_step(end_offset)
        });
        if !echoed {
            continue;
        }
        if acoustics.is_some_and(|acoustics| {
            acoustics.verdict(first.start, last.end) != AcousticVerdict::Bleed
        }) {
            continue;
        }
        for word in &utterance {
            *bleed_words_per_row.entry(word.row).or_default() += 1;
        }
    }
    // A row is moved aside only if every one of its words was judged bleed;
    // otherwise part of it was the user's own and the whole row stays.
    bleed_words_per_row
        .into_iter()
        .filter(|(row, judged)| words_per_row.get(row) == Some(judged))
        .map(|(row, _)| row)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalisation_keeps_numbers_and_amounts_distinct() {
        assert_eq!(normalize_word("Thursday."), "thursday");
        assert_eq!(normalize_word("don\u{2019}t"), "don't");
        assert_eq!(normalize_word("$1,200"), "$1,200");
        assert_ne!(normalize_word("$1,200"), normalize_word("$12,000"));
        assert_ne!(normalize_word("1.5"), normalize_word("15"));
        assert_eq!(normalize_word("\"(yes),\""), "yes");
        assert_eq!(normalize_word("--"), "");
    }

    #[test]
    fn sentence_marks_only_conflict_when_both_sides_have_one() {
        assert!(marks_conflict(Some('?'), Some('.')));
        assert!(!marks_conflict(Some('.'), Some('!')));
        assert!(!marks_conflict(Some('?'), None));
        assert_eq!(sentence_mark("today?\""), Some('?'));
    }

    /// Syllable-like bursts of noise: loud for a word, quiet between words.
    fn speech_like(seconds: f64, rate: u32, seed: u64, offset_seconds: f64) -> Vec<f32> {
        let total = (seconds * f64::from(rate)) as usize;
        let mut state = seed;
        let mut noise = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % 20_000) as f32 / 10_000.0 - 1.0
        };
        (0..total)
            .map(|index| {
                let t = index as f64 / f64::from(rate) - offset_seconds;
                // Word rhythm that varies with the seed, so two talkers differ.
                let syllable = ((t * (3.0 + (seed % 5) as f64 * 0.7)).sin()
                    * (t * (1.3 + (seed % 3) as f64 * 0.4)).cos())
                .abs();
                let gain = if t < 0.0 || syllable < 0.35 {
                    0.002
                } else {
                    0.3 * syllable as f32
                };
                gain * noise()
            })
            .collect()
    }

    #[test]
    fn a_microphone_that_follows_the_far_side_reads_as_bleed() {
        let rate = 16_000;
        let system = speech_like(6.0, rate, 7, 0.0);
        // The speaker's sound reaches the mic 150 ms later and much quieter,
        // over a little room noise.
        let delay = (0.15 * f64::from(rate)) as usize;
        let room = speech_like(6.0, rate, 99, 0.0);
        let mic: Vec<f32> = (0..system.len())
            .map(|index| {
                let echo = if index >= delay {
                    system[index - delay] * 0.2
                } else {
                    0.0
                };
                echo + room[index] * 0.005
            })
            .collect();
        let acoustics = BleedAcoustics::from_samples(&mic, &system, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::Bleed);
    }

    #[test]
    fn the_user_speaking_while_the_far_side_is_silent_is_not_bleed() {
        let rate = 16_000;
        let silent_system = vec![0.0_f32; 6 * rate as usize];
        let mic = speech_like(6.0, rate, 3, 0.0);
        let acoustics = BleedAcoustics::from_samples(&mic, &silent_system, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::NotBleed);
    }

    #[test]
    fn the_users_voice_carried_by_the_far_side_too_is_not_bleed() {
        // A colleague's open microphone in the same room sends the user's
        // own sentence back on the far side, fainter, at about the same
        // moment. The envelopes match, but the sound is loudest at the
        // user's microphone, where it started.
        let rate = 16_000;
        let voice = speech_like(6.0, rate, 7, 0.0);
        let mic: Vec<f32> = voice.iter().map(|sample| sample * 0.8).collect();
        let system: Vec<f32> = voice.iter().map(|sample| sample * 0.1).collect();
        let acoustics = BleedAcoustics::from_samples(&mic, &system, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::NotBleed);
        // The same recordings the other way round are a speaker feeding the
        // microphone.
        let acoustics = BleedAcoustics::from_samples(&system, &mic, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::Bleed);
        // A far end that echoes the user back 300 ms later, half as loud.
        let delay = (0.3 * f64::from(rate)) as usize;
        let echoed: Vec<f32> = (0..voice.len())
            .map(|index| {
                index
                    .checked_sub(delay)
                    .map_or(0.0, |earlier| voice[earlier] * 0.4)
            })
            .collect();
        let acoustics = BleedAcoustics::from_samples(&mic, &echoed, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::NotBleed);
    }

    #[test]
    fn two_people_talking_at_once_is_not_bleed() {
        let rate = 16_000;
        let system = speech_like(6.0, rate, 7, 0.0);
        let mic = speech_like(6.0, rate, 12, 0.0);
        let acoustics = BleedAcoustics::from_samples(&mic, &system, rate);
        assert_eq!(acoustics.verdict(1.0, 5.0), AcousticVerdict::NotBleed);
    }
}
