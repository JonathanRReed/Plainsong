//! Deterministic, bounded edits. Native callers validate focus and security on every read/write.
use super::inline_edit::{TextRange, MAX_UTF16};
use crate::dictation_parity::DictationCommandAction as Action;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Image {
    pub text: String,
    pub selection: TextRange,
}

#[derive(Clone)]
struct Change {
    before: Image,
    range: TextRange,
    replacement: Option<String>,
    insertion: Option<TextRange>,
}

pub(super) struct History {
    current: Image,
    insertion: Option<TextRange>,
    changes: Vec<Change>,
}

enum HistoryUpdate {
    Push,
    Reset,
    Pop,
}

pub(super) struct Plan {
    before: Image,
    pub after: Image,
    pub range: TextRange,
    pub replacement: Option<String>,
    insertion: Option<TextRange>,
    update: HistoryUpdate,
}

fn failure(message: &str) -> String {
    message.to_string()
}

fn byte_at_utf16(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += ch.len_utf16();
    }
    (units == offset).then_some(text.len())
}

fn grapheme_boundary(text: &str, byte: usize) -> bool {
    byte == text.len() || text.grapheme_indices(true).any(|(index, _)| index == byte)
}

pub(super) fn byte_range(text: &str, range: TextRange) -> Option<std::ops::Range<usize>> {
    let start = byte_at_utf16(text, range.location)?;
    let end = byte_at_utf16(text, range.location.checked_add(range.length)?)?;
    (grapheme_boundary(text, start) && grapheme_boundary(text, end)).then_some(start..end)
}

fn ax_range(text: &str, bytes: std::ops::Range<usize>) -> TextRange {
    TextRange {
        location: text[..bytes.start].encode_utf16().count(),
        length: text[bytes].encode_utf16().count(),
    }
}

fn unique_phrase(text: &str, phrase: &str) -> Result<TextRange, String> {
    if phrase.trim().is_empty() {
        return Err(failure("Say the phrase to select."));
    }
    let re = regex::RegexBuilder::new(&regex::escape(phrase))
        .case_insensitive(true)
        .build()
        .map_err(|_| failure("That phrase could not be selected."))?;
    // UAX #29 word boundaries: "plan" never selects part of "planning", while
    // scripts written without spaces still match within a run of ideographs.
    let words: Vec<usize> = text
        .split_word_bound_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect();
    let word_boundary = |byte: usize| words.binary_search(&byte).is_ok();
    let mut found = None;
    let mut inside_word = false;
    let mut start = 0;
    while let Some(candidate) = re.find_at(text, start) {
        // Resume one character after the start so overlapping matches count.
        start = candidate.start()
            + text[candidate.start()..]
                .chars()
                .next()
                .expect("nonempty phrase")
                .len_utf8();
        if !grapheme_boundary(text, candidate.start()) || !grapheme_boundary(text, candidate.end())
        {
            continue;
        }
        if !word_boundary(candidate.start()) || !word_boundary(candidate.end()) {
            inside_word = true;
            continue;
        }
        if found.is_some() {
            return Err(failure(
                "That phrase occurs more than once. Say a longer phrase.",
            ));
        }
        found = Some(candidate.range());
    }
    match found {
        Some(found) => Ok(ax_range(text, found)),
        None if inside_word => Err(failure(
            "That phrase only appears inside a longer word. Say the whole word.",
        )),
        None => Err(failure("That phrase was not found in the focused field.")),
    }
}

/// Whether a Unicode sentence boundary after `segment` is really an
/// abbreviation, title, initial or numbered reference ("Dr. Smith", "U.S.
/// Army", "No. 5"), so deleting the last sentence keeps the name or number
/// with the words around it.
fn continues_after(segment: &str, next: &str) -> bool {
    const TITLES: &[&str] = &[
        "dr", "mr", "mrs", "ms", "mx", "prof", "sr", "sra", "srta", "jr", "st", "mt", "vs", "cf",
        "approx", "dept",
    ];
    const NUMBERED: &[&str] = &["no", "nos", "nr", "vol", "pp", "fig", "ch", "sec", "art"];
    let Some(body) = segment.trim_end().strip_suffix('.') else {
        return false;
    };
    let word = body
        .rsplit(char::is_whitespace)
        .next()
        .unwrap_or_default()
        .trim_start_matches(|c: char| !c.is_alphanumeric());
    let lower = word.to_lowercase();
    if TITLES.contains(&lower.as_str()) {
        return true;
    }
    if NUMBERED.contains(&lower.as_str()) {
        return next.trim_start().starts_with(|c: char| c.is_ascii_digit());
    }
    // "J.", "U.S", "z.B", "e.g", "i.e". "a.m." and "p.m." often end a sentence.
    !matches!(lower.as_str(), "a.m" | "p.m")
        && !word.is_empty()
        && word
            .split('.')
            .all(|part| part.chars().count() == 1 && part.chars().all(char::is_alphabetic))
}

fn last_sentence_start(text: &str) -> Option<usize> {
    let mut start = None;
    let mut previous: Option<&str> = None;
    for (index, part) in text.split_sentence_bound_indices() {
        if part.trim().is_empty() {
            continue;
        }
        if !previous.is_some_and(|previous| continues_after(previous, part)) {
            start = Some(index);
        }
        previous = Some(part);
    }
    start
}

impl History {
    pub fn new(current: Image) -> Option<Self> {
        if current.text.encode_utf16().count() > MAX_UTF16
            || byte_range(&current.text, current.selection).is_none()
        {
            return None;
        }
        Some(Self {
            current,
            insertion: None,
            changes: vec![],
        })
    }

    pub fn inserted(before: Image, inserted: &str, after: Image) -> Option<Self> {
        let mut history = Self::new(before.clone())?;
        let plan = history
            .replacement(before.selection, inserted.to_owned(), true)
            .ok()?;
        if plan.after != after {
            return None;
        }
        let span = TextRange {
            location: before.selection.location,
            length: inserted.encode_utf16().count(),
        };
        history.commit(plan);
        history.insertion = Some(span);
        Some(history)
    }

    /// `dictated` means every character of `replacement` came from the
    /// user's dictation, so it may become the retained span. Transforms of
    /// existing text (case changes, phrase swaps) never do.
    fn replacement(
        &self,
        range: TextRange,
        replacement: String,
        dictated: bool,
    ) -> Result<Plan, String> {
        let bytes = byte_range(&self.current.text, range)
            .ok_or_else(|| failure("The field reported an invalid text range."))?;
        let mut text = self.current.text.clone();
        text.replace_range(bytes, &replacement);
        if text.encode_utf16().count() > MAX_UTF16 {
            return Err(failure("This field is too long for safe voice editing."));
        }
        let selection = TextRange {
            location: range.location + replacement.encode_utf16().count(),
            length: 0,
        };
        if byte_range(&text, selection).is_none()
            || byte_range(
                &text,
                TextRange {
                    location: range.location,
                    length: replacement.encode_utf16().count(),
                },
            )
            .is_none()
        {
            return Err(failure("The edit would split a character."));
        }
        let replacement_length = replacement.encode_utf16().count();
        let range_end = range.location + range.length;
        let insertion = match self.insertion {
            Some(span)
                if range.location >= span.location && range_end <= span.location + span.length =>
            {
                Some(TextRange {
                    location: span.location,
                    length: span.length - range.length + replacement_length,
                })
            }
            _ if dictated && replacement_length > 0 => Some(TextRange {
                location: range.location,
                length: replacement_length,
            }),
            Some(span) if range_end <= span.location => Some(TextRange {
                location: span.location - range.length + replacement_length,
                length: span.length,
            }),
            Some(span) if range.location >= span.location + span.length => Some(span),
            // An edit that straddles the span leaves no exact proof of ownership.
            _ => None,
        }
        .filter(|span| span.length > 0);
        Ok(Plan {
            before: self.current.clone(),
            after: Image { text, selection },
            range,
            replacement: Some(replacement),
            insertion,
            update: HistoryUpdate::Push,
        })
    }

    pub fn plan(&self, current: &Image, action: &Action) -> Result<Plan, String> {
        let needs_retained_text =
            matches!(action, Action::UndoLastInsert | Action::DeleteLastSentence)
                || matches!(action, Action::DeleteThat) && current.selection.length == 0;
        if current.text != self.current.text && !needs_retained_text {
            let fresh = Self::new(current.clone())
                .ok_or_else(|| failure("The field is too long or has an invalid selection."))?;
            let mut plan = fresh.plan(current, action)?;
            plan.update = HistoryUpdate::Reset;
            return Ok(plan);
        }
        if matches!(action, Action::UndoLastInsert) && current.selection != self.current.selection {
            return Err(failure("The selection changed. Undo was refused."));
        }
        let mut plan = self.plan_inner(current, action)?;
        plan.before = current.clone();
        Ok(plan)
    }

    fn plan_inner(&self, current: &Image, action: &Action) -> Result<Plan, String> {
        if current.text != self.current.text {
            return Err(failure(
                "The field text or selection changed. Voice edit was refused.",
            ));
        }
        let mut range = current.selection;
        let selected_bytes = byte_range(&current.text, range)
            .ok_or_else(|| failure("The field reported an invalid text range."))?;
        let selected = &current.text[selected_bytes];
        let replacement = match action {
            Action::SelectPhrase(phrase) => {
                range = unique_phrase(&current.text, phrase)?;
                None
            }
            Action::MoveToStart => {
                range = TextRange {
                    location: 0,
                    length: 0,
                };
                None
            }
            Action::MoveToEnd => {
                range = TextRange {
                    location: current.text.encode_utf16().count(),
                    length: 0,
                };
                None
            }
            Action::InsertText(text) => Some(text.clone()),
            Action::DeleteThat if range.length > 0 => Some(String::new()),
            Action::DeleteThat | Action::DeleteLastSentence => {
                range = self.insertion.ok_or_else(|| {
                    failure("No verified Plainsong insertion is available in this field.")
                })?;
                let bytes = byte_range(&current.text, range)
                    .ok_or_else(|| failure("The last insertion no longer matches."))?;
                if matches!(action, Action::DeleteLastSentence) {
                    let inserted = &current.text[bytes.clone()];
                    // Unicode sentence boundaries keep CJK and combining marks intact.
                    let sentence = last_sentence_start(inserted)
                        .ok_or_else(|| failure("The last insertion has no sentence to delete."))?;
                    range = ax_range(&current.text, bytes.start + sentence..bytes.end);
                }
                return self.replacement(range, String::new(), false);
            }
            Action::UndoLastInsert => {
                let change = self
                    .changes
                    .last()
                    .ok_or_else(|| failure("No voice edit is available to undo."))?;
                let replacement = change.replacement.as_ref().map(|text| {
                    let bytes =
                        byte_range(&change.before.text, change.range).expect("validated change");
                    (
                        TextRange {
                            location: change.range.location,
                            length: text.encode_utf16().count(),
                        },
                        change.before.text[bytes].to_owned(),
                    )
                });
                return Ok(Plan {
                    before: current.clone(),
                    after: change.before.clone(),
                    range: replacement
                        .as_ref()
                        .map_or(change.before.selection, |v| v.0),
                    replacement: replacement.map(|v| v.1),
                    insertion: change.insertion,
                    update: HistoryUpdate::Pop,
                });
            }
            Action::DeleteSelection if range.length > 0 => Some(String::new()),
            Action::ReplaceEntireSelection(text) if range.length > 0 => Some(
                crate::dictation_parity::replace_context_selection(selected, text)?,
            ),
            Action::UppercaseSelection if range.length > 0 => Some(
                crate::dictation_parity::uppercase_context_selection(selected)?,
            ),
            Action::LowercaseSelection if range.length > 0 => Some(
                crate::dictation_parity::lowercase_context_selection(selected)?,
            ),
            Action::TitleCaseSelection if range.length > 0 => Some(
                crate::dictation_parity::title_case_context_selection(selected)?,
            ),
            Action::SentenceCaseSelection if range.length > 0 => Some(
                crate::dictation_parity::sentence_case_context_selection(selected)?,
            ),
            Action::AppendToSelection(text) if range.length > 0 => Some(
                crate::dictation_parity::append_to_context_selection(selected, text)?,
            ),
            Action::PrependToSelection(text) if range.length > 0 => Some(
                crate::dictation_parity::prepend_to_context_selection(selected, text)?,
            ),
            Action::ReplaceSelection {
                target,
                replacement,
            } if range.length > 0 => Some(
                crate::dictation_parity::apply_contextual_phrase_replacement(
                    selected,
                    target,
                    replacement,
                )?
                .0,
            ),
            Action::DeletePhrase(phrase) if range.length > 0 => {
                Some(crate::dictation_parity::delete_phrase_from_context(selected, phrase)?.0)
            }
            _ => {
                return Err(failure(
                    "Select text in this field before using that command.",
                ))
            }
        };
        if let Some(replacement) = replacement {
            let dictated = matches!(
                action,
                Action::InsertText(_) | Action::ReplaceEntireSelection(_)
            );
            return self.replacement(range, replacement, dictated);
        }
        Ok(Plan {
            before: current.clone(),
            after: Image {
                text: current.text.clone(),
                selection: range,
            },
            range,
            replacement: None,
            insertion: self.insertion,
            update: HistoryUpdate::Push,
        })
    }

    pub fn commit(&mut self, plan: Plan) {
        let previous_insertion = if matches!(plan.update, HistoryUpdate::Reset) {
            self.changes.clear();
            None
        } else {
            self.insertion
        };
        if matches!(plan.update, HistoryUpdate::Pop) {
            self.changes.pop();
        } else {
            if self.changes.len() == 32 {
                self.changes.remove(0);
            }
            self.changes.push(Change {
                before: plan.before,
                range: plan.range,
                replacement: plan.replacement,
                insertion: previous_insertion,
            });
        }
        self.current = plan.after;
        self.insertion = plan.insertion;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(text: &str, location: usize, length: usize) -> Image {
        Image {
            text: text.into(),
            selection: TextRange { location, length },
        }
    }
    fn apply(h: &mut History, action: Action) -> Image {
        let plan = h.plan(&h.current, &action).unwrap();
        let after = plan.after.clone();
        h.commit(plan);
        after
    }
    #[test]
    fn select_replace_case_delete_and_undo_use_utf16_and_preserve_neighbors() {
        let mut h = History::new(image("🙂 cafe\u{301} 東京 🚀!", 0, 0)).unwrap();
        let original = h.current.clone();
        assert_eq!(
            apply(&mut h, Action::SelectPhrase("cafe\u{301}".into())).selection,
            TextRange {
                location: 3,
                length: 5
            }
        );
        assert_eq!(
            apply(&mut h, Action::SentenceCaseSelection).text,
            "🙂 Cafe\u{301} 東京 🚀!"
        );
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(
            h.current.selection,
            TextRange {
                location: 3,
                length: 5
            }
        );
        assert_eq!(
            apply(&mut h, Action::ReplaceEntireSelection("中文👩🏽‍💻".into())).text,
            "🙂 中文👩🏽‍💻 東京 🚀!"
        );
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(apply(&mut h, Action::DeleteThat).text, "🙂  東京 🚀!");
        apply(&mut h, Action::UndoLastInsert);
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(h.current, original);
    }
    #[test]
    fn insertion_span_deletes_only_our_text_and_last_sentence_in_middle_of_field() {
        for (inserted, retained) in [
            ("First. Last!", "First. "),
            ("一。二。", "一。"),
            ("Hi 👨‍👩‍👧‍👦. Cafe\u{301}!", "Hi 👨‍👩‍👧‍👦. "),
        ] {
            let before = image("🙂 suffix", 3, 0);
            let after = image(
                &format!("🙂 {inserted}suffix"),
                3 + inserted.encode_utf16().count(),
                0,
            );
            let mut h = History::inserted(before.clone(), inserted, after.clone()).unwrap();
            let deleted = apply(&mut h, Action::DeleteLastSentence);
            assert_eq!(deleted.text, format!("🙂 {retained}suffix"));
            apply(&mut h, Action::UndoLastInsert);
            assert_eq!(h.current, after);
            // A new insertion receipt proves exact last-insertion deletion separately.
            let mut h = History::inserted(before.clone(), inserted, after).unwrap();
            assert_eq!(apply(&mut h, Action::DeleteThat).text, before.text);
            apply(&mut h, Action::UndoLastInsert);
            assert!(h.current.text.contains(inserted));
        }
    }
    #[test]
    fn absent_ambiguous_overlapping_and_partial_grapheme_phrases_refuse() {
        for (text, phrase, message) in [
            ("go go", "go", "more than once"),
            ("banana", "ana", "inside a longer word"),
            ("Roadmap roadmap", "roadmap", "more than once"),
            ("abc", "xyz", "not found"),
            ("e\u{301}", "e", "not found"),
            ("👩🏽‍💻", "👩", "not found"),
        ] {
            let h = History::new(image(text, 0, 0)).unwrap();
            assert!(h
                .plan(&h.current, &Action::SelectPhrase(phrase.into()))
                .err()
                .unwrap()
                .contains(message));
        }
        assert!(byte_range(
            "🙂",
            TextRange {
                location: 1,
                length: 1
            }
        )
        .is_none());
        assert!(byte_range(
            "e\u{301}",
            TextRange {
                location: 0,
                length: 1
            }
        )
        .is_none());
        assert!(byte_range(
            "👩🏽‍💻",
            TextRange {
                location: 0,
                length: 2
            }
        )
        .is_none());
    }
    #[test]
    fn edits_that_merge_into_a_neighboring_grapheme_are_refused_before_writing() {
        let h = History::new(image("ab", 1, 1)).unwrap();
        assert!(h
            .plan(
                &h.current,
                &Action::ReplaceEntireSelection("\u{301}".into())
            )
            .is_err());
        assert!(History::inserted(image("a", 1, 0), "\u{301}", image("a\u{301}", 2, 0)).is_none());
        assert_eq!(
            unique_phrase("e\u{301} e", "e").unwrap(),
            TextRange {
                location: 3,
                length: 1
            }
        );
    }

    #[test]
    fn changed_text_or_selection_and_unowned_sentence_refuse() {
        let h = History::inserted(image("abc", 1, 0), "X", image("aXbc", 2, 0)).unwrap();
        for current in [image("aYbc", 2, 0), image("changed", 0, 0)] {
            for action in [
                Action::DeleteThat,
                Action::DeleteLastSentence,
                Action::UndoLastInsert,
            ] {
                assert!(h.plan(&current, &action).is_err());
            }
        }
        let h = History::new(image("someone else's words", 0, 0)).unwrap();
        assert!(h.plan(&h.current, &Action::DeleteLastSentence).is_err());
        assert!(h.plan(&h.current, &Action::DeleteThat).is_err());
    }
    #[test]
    fn fresh_selection_after_manual_typing_discards_stale_spans_and_undo() {
        let mut h = History::inserted(image("ab", 1, 0), "X", image("aXb", 2, 0)).unwrap();
        let current = image("edited target", 0, 0);
        assert!(h.plan(&current, &Action::DeleteLastSentence).is_err());
        assert!(h.plan(&current, &Action::DeleteThat).is_err());
        let plan = h
            .plan(&current, &Action::SelectPhrase("target".into()))
            .unwrap();
        h.commit(plan);
        assert_eq!(h.changes.len(), 1);
        assert_eq!(apply(&mut h, Action::UndoLastInsert), current);
        assert!(h.plan(&h.current, &Action::UndoLastInsert).is_err());
        assert!(h.plan(&h.current, &Action::DeleteLastSentence).is_err());
        let selected = image("edited target", 7, 6);
        let plan = h.plan(&selected, &Action::UppercaseSelection).unwrap();
        h.commit(plan);
        assert_eq!(h.current.text, "edited TARGET");
        assert_eq!(apply(&mut h, Action::UndoLastInsert), selected);
    }

    #[test]
    fn manual_selection_and_caret_movement_keep_span_ownership_and_exact_undo() {
        let mut h = History::inserted(image("ab", 1, 0), "X", image("aXb", 2, 0)).unwrap();
        let manual = image("aXb", 0, 1);
        assert!(h.plan(&manual, &Action::UndoLastInsert).is_err());
        let plan = h.plan(&manual, &Action::UppercaseSelection).unwrap();
        h.commit(plan);
        assert_eq!(apply(&mut h, Action::UndoLastInsert), manual);
        let plan = h.plan(&image("aXb", 0, 0), &Action::DeleteThat).unwrap();
        assert_eq!(plan.after.text, "ab");
        h.commit(plan);
        assert_eq!(apply(&mut h, Action::UndoLastInsert), image("aXb", 0, 0));
    }

    #[test]
    fn repeated_sentence_deletion_and_case_expansion_keep_exact_undo_spans() {
        let mut h = History::inserted(
            image("", 0, 0),
            "First. Last!",
            image("First. Last!", 12, 0),
        )
        .unwrap();
        assert_eq!(apply(&mut h, Action::DeleteLastSentence).text, "First. ");
        assert_eq!(apply(&mut h, Action::DeleteLastSentence).text, "");
        apply(&mut h, Action::UndoLastInsert);
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(h.current.text, "First. Last!");
        let mut h = History::new(image("ß東京", 0, 1)).unwrap();
        assert_eq!(apply(&mut h, Action::UppercaseSelection).text, "SS東京");
        assert_eq!(apply(&mut h, Action::UndoLastInsert), image("ß東京", 0, 1));
        assert!(History::new(image(&"x".repeat(MAX_UTF16 + 1), 0, 0)).is_none());
    }

    #[test]
    fn last_sentence_deletion_keeps_abbreviations_numbers_and_names_together() {
        for (inserted, retained) in [
            ("First. Call Dr. Smith tomorrow.", "First. "),
            ("First. Mr. and Mrs. Jones met Ms. Lee.", "First. "),
            ("First. Meet on St. Mark's Place.", "First. "),
            ("First. Ship it to the U.S. Army base.", "First. "),
            ("First. Bring snacks, e.g. Fruit or nuts.", "First. "),
            ("First. Use one, i.e. The blue one.", "First. "),
            ("First. Meet at 3 p.m. tomorrow.", "First. "),
            ("Meet at 3 p.m. Bring the deck.", "Meet at 3 p.m. "),
            ("First. See No. 5 on the list.", "First. "),
            ("No. We cannot.", "No. "),
            ("First. It costs 3.50 today.", "First. "),
            ("Erst. Das ist z.B. Gut so.", "Erst. "),
            ("¿Vienes? Sí, con el Sr. García.", "¿Vienes? "),
            ("Bonjour. M. Dupont arrive.", "Bonjour. "),
            ("一。二。", "一。"),
            ("Hi 👨‍👩‍👧‍👦. Cafe\u{301}!", "Hi 👨‍👩‍👧‍👦. "),
        ] {
            let mut h = History::inserted(
                image("", 0, 0),
                inserted,
                image(inserted, inserted.encode_utf16().count(), 0),
            )
            .unwrap();
            assert_eq!(
                apply(&mut h, Action::DeleteLastSentence).text,
                retained,
                "{inserted}"
            );
        }
    }

    #[test]
    fn phrase_selection_prefers_whole_words_and_refuses_partial_words() {
        let select = |text: &str, phrase: &str| {
            let h = History::new(image(text, 0, 0)).unwrap();
            h.plan(&h.current, &Action::SelectPhrase(phrase.into()))
                .map(|plan| plan.after.selection)
        };
        let range = |location, length| TextRange { location, length };
        assert_eq!(select("plan planning planned", "plan"), Ok(range(0, 4)));
        assert_eq!(select("Ask Ana about banana", "ana"), Ok(range(4, 3)));
        assert_eq!(select("re-plan it", "plan"), Ok(range(3, 4)));
        assert_eq!(select("東京都に行く", "東京"), Ok(range(0, 2)));
        for (text, phrase) in [
            ("The planning meeting", "plan"),
            ("banana", "ana"),
            ("cafe\u{301}s", "cafe\u{301}"),
        ] {
            assert!(select(text, phrase)
                .unwrap_err()
                .contains("inside a longer word"));
        }
        assert!(select("go go go", "go go")
            .unwrap_err()
            .contains("more than once"));
    }

    #[test]
    fn transforms_outside_the_insertion_never_adopt_user_text_as_ours() {
        let before = image("straße words ", 13, 0);
        let after = image("straße words Mine.", 18, 0);
        let inserted = || History::inserted(before.clone(), "Mine.", after.clone()).unwrap();

        // A case change of the user's words keeps (and shifts) our span.
        let mut h = inserted();
        apply(&mut h, Action::SelectPhrase("straße".into()));
        assert_eq!(
            apply(&mut h, Action::UppercaseSelection).text,
            "STRASSE words Mine."
        );
        assert_eq!(apply(&mut h, Action::DeleteThat).text, "STRASSE words ");
        apply(&mut h, Action::UndoLastInsert);
        apply(&mut h, Action::UndoLastInsert);
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(h.current, after);

        // Deleting the user's words before our span shifts it.
        let mut h = inserted();
        apply(&mut h, Action::SelectPhrase("words".into()));
        assert_eq!(apply(&mut h, Action::DeleteThat).text, "straße  Mine.");
        assert_eq!(apply(&mut h, Action::DeleteThat).text, "straße  ");

        // Words the user dictated as a replacement become the retained span.
        let mut h = inserted();
        apply(&mut h, Action::SelectPhrase("words".into()));
        apply(&mut h, Action::ReplaceEntireSelection("notes".into()));
        assert_eq!(apply(&mut h, Action::DeleteThat).text, "straße  Mine.");

        // A transform across the span boundary retires it.
        let mut h = inserted();
        apply(&mut h, Action::SelectPhrase("words Mine".into()));
        assert_eq!(
            apply(&mut h, Action::UppercaseSelection).text,
            "straße WORDS MINE."
        );
        assert!(h.plan(&h.current, &Action::DeleteThat).is_err());
        assert!(h.plan(&h.current, &Action::DeleteLastSentence).is_err());
    }

    #[test]
    fn cursor_breaks_selection_replacement_and_undo_are_exact() {
        let mut h = History::new(image("中文🙂", 0, 0)).unwrap();
        let original = h.current.clone();
        assert_eq!(apply(&mut h, Action::MoveToEnd).selection.location, 4);
        assert_eq!(
            apply(&mut h, Action::InsertText("\n\n".into())).text,
            "中文🙂\n\n"
        );
        apply(&mut h, Action::UndoLastInsert);
        apply(&mut h, Action::UndoLastInsert);
        assert_eq!(h.current, original);
        apply(&mut h, Action::MoveToEnd);
        apply(&mut h, Action::MoveToStart);
        assert_eq!(h.current.selection.location, 0);
        let h = History::inserted(image("🙂abc", 2, 3), "東京\n", image("🙂東京\n", 5, 0)).unwrap();
        assert_eq!(
            h.plan(&h.current, &Action::UndoLastInsert)
                .unwrap()
                .after
                .text,
            "🙂abc"
        );
    }
}
