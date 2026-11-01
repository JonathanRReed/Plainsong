//! Single-use reversal of a verified inline insertion. No native Undo or whole-value writes.
use std::time::Instant;

pub(super) const MAX_UTF16: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TextRange {
    pub(crate) location: usize,
    pub(crate) length: usize,
}

/// Each read must fail unless the original retained target is focused and nonsecure.
/// Read complete values. Check native UTF-16 length before copying into Rust,
/// rejecting values over 64 Ki units.
/// Every setter must independently recheck target identity, security and deadline.
/// A failed deletion must mean no write was dispatched. Any possibly dispatched
/// deletion is Accepted, even if the native API returned an ambiguous error.
/// AX cannot make the final read and setter atomic against external editing.
pub(crate) trait Backend {
    fn read_state(&mut self, deadline: Instant) -> Option<(String, TextRange)>;
    fn read_selected_text(&mut self, deadline: Instant) -> Option<String>;
    fn set_range(&mut self, range: TextRange, deadline: Instant) -> bool;
    fn delete_selected_text(&mut self, deadline: Instant) -> Deletion;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Deletion {
    Refused,
    Accepted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReverseResult {
    Refused,
    Removed { caret_restored: bool },
    Uncertain,
}

pub(crate) struct InlineInsertion {
    before: String,
    after: String,
    inserted: String,
    before_selection: TextRange,
    post_selection: TextRange,
    span: TextRange,
}

impl std::fmt::Debug for InlineInsertion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InlineInsertion { <redacted> }")
    }
}

impl InlineInsertion {
    pub(crate) fn capture(
        before: &str,
        before_selection: TextRange,
        inserted: &str,
        after: &str,
        post_selection: TextRange,
    ) -> Option<Self> {
        if inserted.is_empty()
            || before_selection.length != 0
            || [before, inserted, after]
                .iter()
                .any(|s| s.encode_utf16().count() > MAX_UTF16)
            || inserted
                .chars()
                .any(|c| matches!(c, '\r' | '\n' | '\u{85}' | '\u{2028}' | '\u{2029}'))
        {
            return None;
        }
        let span = TextRange {
            location: before_selection.location,
            length: inserted.encode_utf16().count(),
        };
        let expected_caret = TextRange {
            location: span.location.checked_add(span.length)?,
            length: 0,
        };
        let mut units: Vec<u16> = before.encode_utf16().collect();
        if span.location > units.len() {
            return None;
        }
        units.splice(span.location..span.location, inserted.encode_utf16());
        if String::from_utf16(&units).ok()?.as_str() != after || post_selection != expected_caret {
            return None;
        }
        Some(Self {
            before: before.into(),
            after: after.into(),
            inserted: inserted.into(),
            before_selection,
            post_selection,
            span,
        })
    }

    fn matches<B: Backend>(&self, backend: &mut B, range: TextRange, deadline: Instant) -> bool {
        Instant::now() < deadline
            && backend
                .read_state(deadline)
                .is_some_and(|(value, selected)| value == self.after && selected == range)
            && Instant::now() < deadline
    }

    fn owns_span<B: Backend>(&self, backend: &mut B, deadline: Instant) -> bool {
        // Read selected text first so the complete state is the last read before a setter.
        Instant::now() < deadline
            && backend.read_selected_text(deadline).as_deref() == Some(self.inserted.as_str())
            && self.matches(backend, self.span, deadline)
    }

    fn clean_selection<B: Backend>(&self, backend: &mut B, deadline: Instant) {
        if self.owns_span(backend, deadline) {
            let _ = backend.set_range(self.post_selection, deadline);
        }
    }

    pub(crate) fn reverse<B: Backend>(self, backend: &mut B, deadline: Instant) -> ReverseResult {
        if !self.matches(backend, self.post_selection, deadline) {
            return ReverseResult::Refused;
        }
        if !backend.set_range(self.span, deadline) {
            self.clean_selection(backend, deadline);
            return ReverseResult::Refused;
        }
        if !self.owns_span(backend, deadline) {
            self.clean_selection(backend, deadline);
            return ReverseResult::Refused;
        }
        if backend.delete_selected_text(deadline) == Deletion::Refused {
            self.clean_selection(backend, deadline);
            return ReverseResult::Refused;
        }
        // Once dispatched, deletion is never retried, including on read failure.
        if Instant::now() >= deadline {
            return ReverseResult::Uncertain;
        }
        let Some((value, selection)) = backend.read_state(deadline) else {
            return ReverseResult::Uncertain;
        };
        if value != self.before {
            return ReverseResult::Uncertain;
        }
        if selection == self.before_selection {
            return ReverseResult::Removed {
                caret_restored: true,
            };
        }
        ReverseResult::Removed {
            caret_restored: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn r(location: usize, length: usize) -> TextRange {
        TextRange { location, length }
    }
    fn end() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }
    struct Fake {
        value: String,
        range: TextRange,
        valid: bool,
        writes: Vec<TextRange>,
        deletes: usize,
        wrong_span: bool,
        wrong_text: bool,
        refuse: bool,
        unreadable: bool,
        move_on_refusal: bool,
        deletion_range: Option<TextRange>,
    }
    impl Fake {
        fn new(value: &str, range: TextRange) -> Self {
            Self {
                value: value.into(),
                range,
                valid: true,
                writes: vec![],
                deletes: 0,
                wrong_span: false,
                wrong_text: false,
                refuse: false,
                unreadable: false,
                move_on_refusal: false,
                deletion_range: None,
            }
        }
    }
    impl Backend for Fake {
        fn read_state(&mut self, _: Instant) -> Option<(String, TextRange)> {
            (self.valid && !(self.unreadable && self.deletes > 0))
                .then(|| (self.value.clone(), self.range))
        }
        fn read_selected_text(&mut self, _: Instant) -> Option<String> {
            if !self.valid {
                return None;
            }
            if self.wrong_text {
                return Some("different".into());
            }
            let units: Vec<_> = self.value.encode_utf16().collect();
            String::from_utf16(
                units.get(
                    self.range.location..self.range.location.checked_add(self.range.length)?,
                )?,
            )
            .ok()
        }
        fn set_range(&mut self, range: TextRange, deadline: Instant) -> bool {
            if !self.valid || Instant::now() >= deadline {
                return false;
            }
            self.writes.push(range);
            self.range = if self.wrong_span { r(0, 0) } else { range };
            true
        }
        fn delete_selected_text(&mut self, deadline: Instant) -> Deletion {
            if !self.valid || Instant::now() >= deadline {
                return Deletion::Refused;
            }
            if self.refuse {
                if self.move_on_refusal {
                    self.range = r(0, 0);
                }
                return Deletion::Refused;
            }
            self.deletes += 1;
            let mut units: Vec<_> = self.value.encode_utf16().collect();
            units.drain(self.range.location..self.range.location + self.range.length);
            self.value = String::from_utf16(&units).unwrap();
            self.range = self.deletion_range.unwrap_or(r(self.range.location, 0));
            Deletion::Accepted
        }
    }
    fn receipt() -> InlineInsertion {
        InlineInsertion::capture("ab", r(1, 0), "X", "aXb", r(2, 0)).unwrap()
    }
    #[test]
    fn restores_exact_text_and_caret_in_utf16() {
        for (before, caret, inserted, after, post) in [
            ("ab", 1, "X", "aXb", 2),
            ("🙂z", 2, "é🚀", "🙂é🚀z", 5),
            ("a\nb", 2, "X", "a\nXb", 3),
        ] {
            let edit =
                InlineInsertion::capture(before, r(caret, 0), inserted, after, r(post, 0)).unwrap();
            let mut b = Fake::new(after, r(post, 0));
            assert_eq!(
                edit.reverse(&mut b, end()),
                ReverseResult::Removed {
                    caret_restored: true
                }
            );
            assert_eq!(b.value, before);
            assert_eq!(b.range, r(caret, 0));
            assert_eq!(b.deletes, 1);
            assert_eq!(b.writes, vec![r(caret, inserted.encode_utf16().count())]);
        }
    }
    #[test]
    fn changed_target_text_or_caret_and_expiry_never_mutate() {
        for kind in 0..4 {
            let mut b = Fake::new("aXb", r(2, 0));
            match kind {
                0 => b.valid = false,
                1 => b.value = "changed".into(),
                2 => b.range = r(0, 0),
                _ => {}
            }
            let deadline = if kind == 3 { Instant::now() } else { end() };
            assert_eq!(receipt().reverse(&mut b, deadline), ReverseResult::Refused);
            assert!(b.writes.is_empty());
            assert_eq!(b.deletes, 0);
        }
    }
    #[test]
    fn capture_rejects_unsupported_or_inexact_images() {
        assert!(InlineInsertion::capture("ab", r(1, 0), "", "ab", r(1, 0)).is_none());
        assert!(InlineInsertion::capture("ab", r(1, 1), "X", "aX", r(2, 0)).is_none());
        assert!(InlineInsertion::capture("ab", r(1, 0), "X", "aXb", r(1, 0)).is_none());
        assert!(InlineInsertion::capture("🙂", r(1, 0), "X", "X🙂", r(2, 0)).is_none());
        for separator in ['\r', '\n', '\u{85}', '\u{2028}', '\u{2029}'] {
            let s = separator.to_string();
            assert!(InlineInsertion::capture("", r(0, 0), &s, &s, r(1, 0)).is_none());
            assert!(
                InlineInsertion::capture(&s, r(0, 0), "X", &format!("X{s}"), r(1, 0)).is_some()
            );
        }
        let full = "a".repeat(MAX_UTF16);
        assert!(InlineInsertion::capture("", r(0, 0), &full, &full, r(MAX_UTF16, 0)).is_some());
        let too_big = format!("{full}a");
        assert!(
            InlineInsertion::capture("", r(0, 0), &too_big, &too_big, r(MAX_UTF16 + 1, 0))
                .is_none()
        );
    }
    #[test]
    fn incorrect_selection_or_text_cannot_delete() {
        for wrong_span in [false, true] {
            let mut b = Fake::new("aXb", r(2, 0));
            b.wrong_span = wrong_span;
            b.wrong_text = !wrong_span;
            assert_eq!(receipt().reverse(&mut b, end()), ReverseResult::Refused);
            assert_eq!(b.deletes, 0);
            assert_eq!(b.writes, vec![r(1, 1)]);
        }
    }
    #[test]
    fn refused_deletion_restores_selection_only_if_still_owned() {
        for moved in [false, true] {
            let mut b = Fake::new("aXb", r(2, 0));
            b.refuse = true;
            b.move_on_refusal = moved;
            assert_eq!(receipt().reverse(&mut b, end()), ReverseResult::Refused);
            assert_eq!(b.value, "aXb");
            assert_eq!(b.deletes, 0);
            assert_eq!(
                b.writes,
                if moved {
                    vec![r(1, 1)]
                } else {
                    vec![r(1, 1), r(2, 0)]
                }
            );
        }
    }
    #[test]
    fn accepted_unconfirmed_deletion_is_not_retried() {
        let mut b = Fake::new("aXb", r(2, 0));
        b.unreadable = true;
        assert_eq!(receipt().reverse(&mut b, end()), ReverseResult::Uncertain);
        assert_eq!(b.deletes, 1);
        assert_eq!(b.writes, vec![r(1, 1)]);
    }
    #[test]
    fn moved_caret_reports_warning_without_another_write_and_final_match_succeeds() {
        let mut b = Fake::new("aXb", r(2, 0));
        b.deletion_range = Some(r(0, 0));
        assert_eq!(
            receipt().reverse(&mut b, end()),
            ReverseResult::Removed {
                caret_restored: false
            }
        );
        assert_eq!(b.value, "ab");
        assert_eq!(b.deletes, 1);
        assert_eq!(b.range, r(0, 0));
        assert_eq!(b.writes, vec![r(1, 1)]);
        let mut b = Fake::new("aXb", r(2, 0));
        b.deletion_range = Some(r(1, 0));
        assert_eq!(
            receipt().reverse(&mut b, end()),
            ReverseResult::Removed {
                caret_restored: true
            }
        );
        assert_eq!(b.writes, vec![r(1, 1)]);
    }
}
