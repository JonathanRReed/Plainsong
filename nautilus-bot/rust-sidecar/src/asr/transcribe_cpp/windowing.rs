use super::RawSegment;

const SAMPLE_RATE: usize = 16_000;
const CORE_SAMPLES: usize = 30 * SAMPLE_RATE;
const CONTEXT_SAMPLES: usize = SAMPLE_RATE;
const TAIL_TOLERANCE_MS: i64 = 80;
const MAX_MIDPOINT_DELTA_MS: i64 = 1_000;
const ANCHOR_SEARCH_WORDS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Window {
    pub(super) core_start: usize,
    pub(super) core_end: usize,
    pub(super) decode_start: usize,
    pub(super) decode_end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct MergeResult {
    pub(super) text: String,
    pub(super) words: Vec<RawSegment>,
    pub(super) removed_duplicates: usize,
    pub(super) unresolved_count: usize,
}

pub(super) fn plan(total_samples: usize) -> Vec<Window> {
    let mut windows = Vec::new();
    let mut core_start = 0;
    while core_start < total_samples {
        let nominal_end = core_start.saturating_add(CORE_SAMPLES).min(total_samples);
        let core_end = if total_samples.saturating_sub(nominal_end) <= CONTEXT_SAMPLES {
            total_samples
        } else {
            nominal_end
        };
        windows.push(Window {
            core_start,
            core_end,
            decode_start: core_start.saturating_sub(CONTEXT_SAMPLES),
            decode_end: core_end.saturating_add(CONTEXT_SAMPLES).min(total_samples),
        });
        core_start = core_end;
    }
    windows
}

pub(super) fn merge(
    decoded: Vec<(Window, Vec<RawSegment>)>,
    total_samples: usize,
) -> anyhow::Result<MergeResult> {
    let expected = plan(total_samples);
    if decoded.len() != expected.len() {
        anyhow::bail!(
            "windowed decode returned {} windows for a {}-window plan",
            decoded.len(),
            expected.len()
        );
    }

    let mut windows = Vec::with_capacity(decoded.len());
    for (index, ((window, rows), expected_window)) in
        decoded.into_iter().zip(expected.into_iter()).enumerate()
    {
        if window != expected_window {
            anyhow::bail!("window {index} does not match the bounded decode plan");
        }
        validate_rows(index, window, &rows)?;

        let offset_ms = samples_to_ms(window.decode_start);
        let words = rows
            .into_iter()
            .filter(|row| !row.text.trim().is_empty())
            .map(|row| RawSegment {
                start_ms: row.start_ms + offset_ms,
                end_ms: row.end_ms + offset_ms,
                text: row.text,
            })
            .collect::<Vec<_>>();
        let selected = words
            .iter()
            .filter(|word| owns_midpoint(word, window, total_samples))
            .cloned()
            .collect();
        windows.push(DecodedWindow {
            window,
            words,
            selected,
        });
    }

    let mut removed_duplicate_count = 0;
    let mut unresolved_count = 0;
    for index in 0..windows.len().saturating_sub(1) {
        match inspect_seam(&windows[index], &windows[index + 1]) {
            SeamDecision::RemoveLeft => {
                windows[index].selected.pop();
                removed_duplicate_count += 1;
            }
            SeamDecision::RemoveRight => {
                windows[index + 1].selected.remove(0);
                removed_duplicate_count += 1;
            }
            SeamDecision::Unresolved => unresolved_count += 1,
            SeamDecision::None => {}
        }
    }

    let words = windows
        .into_iter()
        .flat_map(|window| window.selected)
        .collect::<Vec<_>>();
    validate_merged_order(&words)?;
    let text = words
        .iter()
        .flat_map(|word| word.text.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ");
    Ok(MergeResult {
        text,
        words,
        removed_duplicates: removed_duplicate_count,
        unresolved_count,
    })
}

#[derive(Debug)]
struct DecodedWindow {
    window: Window,
    words: Vec<RawSegment>,
    selected: Vec<RawSegment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeamDecision {
    None,
    Unresolved,
    RemoveLeft,
    RemoveRight,
}

fn samples_to_ms(samples: usize) -> i64 {
    ((samples as u128 * 1_000) / SAMPLE_RATE as u128) as i64
}

fn validate_rows(index: usize, window: Window, rows: &[RawSegment]) -> anyhow::Result<()> {
    let decode_end_ms = samples_to_ms(window.decode_end - window.decode_start);
    let tolerated_end_ms = decode_end_ms + TAIL_TOLERANCE_MS;
    let mut previous_start = 0;
    let mut previous_end = 0;
    for (row_index, row) in rows.iter().enumerate() {
        if row.start_ms < 0
            || row.start_ms > decode_end_ms
            || row.end_ms < row.start_ms
            || row.end_ms > tolerated_end_ms
        {
            anyhow::bail!("window {index} word row {row_index} has invalid measured bounds");
        }
        if row_index > 0 && (row.start_ms < previous_start || row.end_ms < previous_end) {
            anyhow::bail!("window {index} word row {row_index} is out of order");
        }
        previous_start = row.start_ms;
        previous_end = row.end_ms;
    }
    Ok(())
}

fn owns_midpoint(word: &RawSegment, window: Window, total_samples: usize) -> bool {
    let midpoint_twice = word.start_ms + word.end_ms;
    let core_start_twice = samples_to_ms(window.core_start) * 2;
    let core_end_twice = samples_to_ms(window.core_end) * 2;
    midpoint_twice >= core_start_twice
        && (midpoint_twice < core_end_twice
            || (window.core_end == total_samples && midpoint_twice == core_end_twice))
}

fn validate_merged_order(words: &[RawSegment]) -> anyhow::Result<()> {
    for (index, pair) in words.windows(2).enumerate() {
        if pair[1].start_ms < pair[0].start_ms || pair[1].end_ms < pair[0].end_ms {
            anyhow::bail!("retained word {} is out of order", index + 1);
        }
    }
    Ok(())
}

fn inspect_seam(left: &DecodedWindow, right: &DecodedWindow) -> SeamDecision {
    let Some(left_candidate) = left.selected.last() else {
        return SeamDecision::None;
    };
    let Some(right_candidate) = right.selected.first() else {
        return SeamDecision::None;
    };
    let left_token = normalize_token(&left_candidate.text);
    let right_token = normalize_token(&right_candidate.text);
    if left_token.is_empty() || left_token != right_token {
        return SeamDecision::None;
    }

    let overlap_start = samples_to_ms(left.window.decode_start.max(right.window.decode_start));
    let overlap_end = samples_to_ms(left.window.decode_end.min(right.window.decode_end));
    if overlap_start >= overlap_end
        || !lies_inside(left_candidate, overlap_start, overlap_end)
        || !lies_inside(right_candidate, overlap_start, overlap_end)
        || midpoint_delta(left_candidate, right_candidate) > MAX_MIDPOINT_DELTA_MS
    {
        return SeamDecision::Unresolved;
    }

    let left_occurrence = occurrence_info(
        &left.words,
        left_candidate,
        &left_token,
        overlap_start,
        overlap_end,
    );
    let right_occurrence = occurrence_info(
        &right.words,
        right_candidate,
        &right_token,
        overlap_start,
        overlap_end,
    );
    let (Some((left_count, left_ordinal)), Some((right_count, right_ordinal))) =
        (left_occurrence, right_occurrence)
    else {
        return SeamDecision::Unresolved;
    };
    if left_count != right_count || left_ordinal != right_ordinal {
        return SeamDecision::Unresolved;
    }
    if !has_distinct_anchor(
        left,
        right,
        left_candidate,
        right_candidate,
        &left_token,
        overlap_start,
        overlap_end,
    ) {
        return SeamDecision::Unresolved;
    }

    let left_edge_distance = distance_from_decode_edge(left_candidate, left.window);
    let right_edge_distance = distance_from_decode_edge(right_candidate, right.window);
    if left_edge_distance >= right_edge_distance {
        SeamDecision::RemoveRight
    } else {
        SeamDecision::RemoveLeft
    }
}

fn midpoint(word: &RawSegment) -> i64 {
    (word.start_ms + word.end_ms) / 2
}

fn midpoint_delta(left: &RawSegment, right: &RawSegment) -> i64 {
    (midpoint(left) - midpoint(right)).abs()
}

fn lies_inside(word: &RawSegment, start_ms: i64, end_ms: i64) -> bool {
    word.start_ms >= start_ms && word.end_ms <= end_ms
}

fn occurrence_info(
    words: &[RawSegment],
    candidate: &RawSegment,
    token: &str,
    overlap_start: i64,
    overlap_end: i64,
) -> Option<(usize, usize)> {
    let occurrences = words
        .iter()
        .filter(|word| {
            lies_inside(word, overlap_start, overlap_end) && normalize_token(&word.text) == token
        })
        .collect::<Vec<_>>();
    let ordinal = occurrences.iter().position(|word| *word == candidate)?;
    Some((occurrences.len(), ordinal))
}

fn has_distinct_anchor(
    left: &DecodedWindow,
    right: &DecodedWindow,
    left_candidate: &RawSegment,
    right_candidate: &RawSegment,
    candidate_token: &str,
    overlap_start: i64,
    overlap_end: i64,
) -> bool {
    [Direction::Before, Direction::After]
        .into_iter()
        .any(|direction| {
            let left_anchors = nearby_anchors(
                &left.words,
                left_candidate,
                overlap_start,
                overlap_end,
                direction,
            );
            let right_anchors = nearby_anchors(
                &right.words,
                right_candidate,
                overlap_start,
                overlap_end,
                direction,
            );
            left_anchors.iter().any(|left_anchor| {
                let token = normalize_token(&left_anchor.text);
                !token.is_empty()
                    && token != candidate_token
                    && right_anchors.iter().any(|right_anchor| {
                        normalize_token(&right_anchor.text) == token
                            && midpoint_delta(left_anchor, right_anchor) <= MAX_MIDPOINT_DELTA_MS
                    })
            })
        })
}

#[derive(Debug, Clone, Copy)]
enum Direction {
    Before,
    After,
}

fn nearby_anchors<'a>(
    words: &'a [RawSegment],
    candidate: &RawSegment,
    overlap_start: i64,
    overlap_end: i64,
    direction: Direction,
) -> Vec<&'a RawSegment> {
    let Some(candidate_index) = words.iter().position(|word| word == candidate) else {
        return Vec::new();
    };
    let indices: Box<dyn Iterator<Item = usize>> = match direction {
        Direction::Before => Box::new((0..candidate_index).rev()),
        Direction::After => Box::new(candidate_index + 1..words.len()),
    };
    indices
        .filter_map(|index| {
            let word = &words[index];
            (!normalize_token(&word.text).is_empty()
                && lies_inside(word, overlap_start, overlap_end))
            .then_some(word)
        })
        .take(ANCHOR_SEARCH_WORDS)
        .collect()
}

fn distance_from_decode_edge(word: &RawSegment, window: Window) -> i64 {
    let word_midpoint = midpoint(word);
    (word_midpoint - samples_to_ms(window.decode_start))
        .min(samples_to_ms(window.decode_end) - word_midpoint)
}

fn normalize_token(text: &str) -> String {
    let mut token = text.trim().to_lowercase();
    for (opening, closing) in [('"', '"'), ('\'', '\''), ('“', '”'), ('‘', '’')] {
        if token.starts_with(opening) && token.ends_with(closing) && token.chars().count() >= 2 {
            token.remove(0);
            token.pop();
            break;
        }
    }
    while token.ends_with(['!', '?', ';', ':', ',']) {
        token.pop();
    }
    while token.ends_with('.') && token.chars().count() > 1 {
        token.pop();
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_ms: i64, end_ms: i64) -> RawSegment {
        RawSegment {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    fn relative(absolute: RawSegment, window: Window) -> RawSegment {
        let offset = samples_to_ms(window.decode_start);
        RawSegment {
            start_ms: absolute.start_ms - offset,
            end_ms: absolute.end_ms - offset,
            text: absolute.text,
        }
    }

    #[test]
    fn plan_covers_every_sample_and_folds_a_one_second_tail() {
        for total in 0..CORE_SAMPLES * 3 + CONTEXT_SAMPLES + 2 {
            let windows = plan(total);
            assert_eq!(
                windows.first().map(|window| window.core_start),
                (total > 0).then_some(0)
            );
            assert_eq!(
                windows.last().map(|window| window.core_end),
                (total > 0).then_some(total)
            );
            assert!(windows
                .windows(2)
                .all(|pair| pair[0].core_end == pair[1].core_start));
            assert!(windows.iter().all(|window| {
                window.decode_start <= window.core_start
                    && window.core_start < window.core_end
                    && window.core_end <= window.decode_end
                    && window.decode_end <= total
            }));
        }
        assert_eq!(plan(CORE_SAMPLES + CONTEXT_SAMPLES).len(), 1);
        assert_eq!(plan(CORE_SAMPLES + CONTEXT_SAMPLES + 1).len(), 2);
    }

    #[test]
    fn merge_owns_midpoints_once_and_offsets_measured_times() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let boundary_ms = samples_to_ms(CORE_SAMPLES);
        let decoded = vec![
            (
                windows[0],
                vec![relative(
                    word("left", boundary_ms - 100, boundary_ms),
                    windows[0],
                )],
            ),
            (
                windows[1],
                vec![relative(
                    word("right", boundary_ms, boundary_ms + 100),
                    windows[1],
                )],
            ),
        ];
        let result = merge(decoded, total).unwrap();
        assert_eq!(result.text, "left right");
        assert_eq!(
            result.words[0],
            word("left", boundary_ms - 100, boundary_ms)
        );
        assert_eq!(
            result.words[1],
            word("right", boundary_ms, boundary_ms + 100)
        );
    }

    #[test]
    fn collapses_only_an_anchored_same_occurrence() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let seam = samples_to_ms(CORE_SAMPLES);
        let left_absolute = vec![
            word("Is", seam - 300, seam - 200),
            word("she", seam - 100, seam),
            word("gonna", seam + 100, seam + 200),
        ];
        let right_absolute = vec![
            word("Is", seam - 260, seam - 160),
            word("she", seam - 20, seam + 80),
            word("gonna", seam + 120, seam + 220),
        ];
        let result = merge(
            vec![
                (
                    windows[0],
                    left_absolute
                        .into_iter()
                        .map(|w| relative(w, windows[0]))
                        .collect(),
                ),
                (
                    windows[1],
                    right_absolute
                        .into_iter()
                        .map(|w| relative(w, windows[1]))
                        .collect(),
                ),
            ],
            total,
        )
        .unwrap();
        assert_eq!(result.text, "Is she gonna");
        assert_eq!(result.removed_duplicates, 1);
        assert_eq!(result.unresolved_count, 0);
    }

    #[test]
    fn preserves_true_repeats_when_occurrence_ordinals_disagree() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let seam = samples_to_ms(CORE_SAMPLES);
        let left = vec![
            word("anchor", seam - 300, seam - 250),
            word("yes", seam - 150, seam - 100),
            word("yes", seam + 100, seam + 150),
        ];
        let right = vec![
            word("anchor", seam - 280, seam - 230),
            word("yes", seam - 120, seam - 70),
            word("yes", seam + 120, seam + 170),
        ];
        let result = merge(
            vec![
                (
                    windows[0],
                    left.into_iter().map(|w| relative(w, windows[0])).collect(),
                ),
                (
                    windows[1],
                    right.into_iter().map(|w| relative(w, windows[1])).collect(),
                ),
            ],
            total,
        )
        .unwrap();
        assert_eq!(
            result
                .words
                .iter()
                .filter(|word| word.text == "yes")
                .count(),
            2
        );
        assert_eq!(result.removed_duplicates, 0);
        assert_eq!(result.unresolved_count, 1);
    }

    #[test]
    fn preserves_currency_decimals_signs_and_apostrophes() {
        assert_ne!(normalize_token("$1.4,"), normalize_token("€1.4"));
        assert_ne!(normalize_token(".5"), normalize_token("5"));
        assert_ne!(normalize_token("-1"), normalize_token("1"));
        assert_ne!(normalize_token("can't!"), normalize_token("cant"));
        assert_eq!(normalize_token("\"Can't!\""), "can't");
    }

    #[test]
    fn time_shift_and_missing_anchor_stay_unresolved() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let seam = samples_to_ms(CORE_SAMPLES);
        let result = merge(
            vec![
                (
                    windows[0],
                    vec![relative(word("same", seam - 900, seam - 850), windows[0])],
                ),
                (
                    windows[1],
                    vec![relative(word("same", seam + 200, seam + 250), windows[1])],
                ),
            ],
            total,
        )
        .unwrap();
        assert_eq!(result.words.len(), 2);
        assert_eq!(result.unresolved_count, 1);
    }

    #[test]
    fn chained_boundaries_do_not_reuse_a_removed_middle_word() {
        let total = CORE_SAMPLES * 3;
        let windows = plan(total);
        let first = samples_to_ms(CORE_SAMPLES);
        let second = samples_to_ms(CORE_SAMPLES * 2);
        let rows = vec![
            vec![
                word("anchor", first - 300, first - 250),
                word("same", first - 80, first + 20),
            ],
            vec![
                word("anchor", first - 280, first - 230),
                word("same", first - 20, first + 80),
                word("same", second - 80, second + 20),
                word("after", second + 100, second + 150),
            ],
            vec![
                word("same", second - 20, second + 80),
                word("after", second + 120, second + 170),
            ],
        ];
        let decoded = windows
            .iter()
            .copied()
            .zip(rows)
            .map(|(window, rows)| {
                (
                    window,
                    rows.into_iter()
                        .map(|word| relative(word, window))
                        .collect(),
                )
            })
            .collect();
        let result = merge(decoded, total).unwrap();
        assert_eq!(result.removed_duplicates, 2);
        assert_eq!(
            result
                .words
                .iter()
                .filter(|word| word.text == "same")
                .count(),
            2
        );
    }

    #[test]
    fn rejects_out_of_range_and_non_monotonic_rows_but_accepts_tail_rounding() {
        let total = CORE_SAMPLES;
        let window = plan(total)[0];
        assert!(merge(vec![(window, vec![word("bad", 0, 30_081)])], total).is_err());
        assert!(merge(
            vec![(window, vec![word("later", 20, 30), word("earlier", 10, 40)])],
            total
        )
        .is_err());
        assert!(merge(vec![(window, vec![word("rounded", 29_990, 30_080)])], total).is_ok());
    }

    #[test]
    fn missing_reordered_or_modified_windows_cannot_be_saved_as_complete() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        assert!(merge(vec![(windows[0], vec![])], total).is_err());
        assert!(merge(vec![(windows[1], vec![]), (windows[0], vec![])], total).is_err());
        let mut changed = windows[0];
        changed.decode_end -= 1;
        assert!(merge(vec![(changed, vec![]), (windows[1], vec![])], total).is_err());
    }

    #[test]
    fn unequal_overlap_occurrence_counts_preserve_ambiguous_words() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let left = vec![word("anchor", 29_700, 29_750), word("yes", 29_900, 29_950)];
        let right = vec![
            word("anchor", 29_710, 29_760),
            word("yes", 30_000, 30_050),
            word("yes", 30_100, 30_150),
        ];
        let result = merge(
            vec![
                (
                    windows[0],
                    left.into_iter().map(|w| relative(w, windows[0])).collect(),
                ),
                (
                    windows[1],
                    right.into_iter().map(|w| relative(w, windows[1])).collect(),
                ),
            ],
            total,
        )
        .unwrap();
        assert_eq!(result.removed_duplicates, 0);
        assert_eq!(result.unresolved_count, 1);
        assert_eq!(result.words.iter().filter(|w| w.text == "yes").count(), 3);
    }

    #[test]
    fn empty_measured_windows_are_valid_silence() {
        let total = CORE_SAMPLES * 2;
        let windows = plan(total);
        let result = merge(vec![(windows[0], vec![]), (windows[1], vec![])], total).unwrap();
        assert!(result.words.is_empty());
        assert!(result.text.is_empty());
        assert_eq!(result.removed_duplicates, 0);
        assert_eq!(result.unresolved_count, 0);
    }
}
