//! Plain-text renderers for the CLI. JSON output is serde's job; these are
//! the human-readable forms.

use super::{
    DictationEntry, MeetingDetail, MeetingSummary, Page, SearchResult, Stats, TranscriptView,
};

/// `1h 02m`, `12m 05s`, `8s`.
pub fn format_duration(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let rest = seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m {rest:02}s")
    } else {
        format!("{rest}s")
    }
}

/// `HH:MM:SS` for a transcript position.
pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as i64;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

/// `HH:MM:SS,mmm`, the SubRip timestamp form.
pub fn srt_time(seconds: f64) -> String {
    let clamped = seconds.max(0.0);
    let total_ms = (clamped * 1000.0).round() as i64;
    let ms = total_ms % 1000;
    let total = total_ms / 1000;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        total / 3600,
        (total % 3600) / 60,
        total % 60,
        ms
    )
}

fn date(value: &chrono::DateTime<chrono::Utc>) -> String {
    value
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

fn truncate_title(title: &str, max: usize) -> String {
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        collapsed
    } else {
        let mut cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }
}

pub fn render_meeting_list(page: &Page<MeetingSummary>) -> String {
    if page.items.is_empty() {
        return "No meetings match.\n".to_string();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "{:<36}  {:<16}  {:>8}  {}\n",
        "ID", "DATE", "LENGTH", "TITLE"
    ));
    for meeting in &page.items {
        let mut flags = Vec::new();
        if !meeting.has_transcript {
            flags.push("no transcript");
        }
        if meeting.has_summary {
            flags.push("summary");
        }
        if meeting.action_item_count > 0 {
            flags.push("actions");
        }
        let suffix = if flags.is_empty() {
            String::new()
        } else {
            format!("  [{}]", flags.join(", "))
        };
        out.push_str(&format!(
            "{:<36}  {:<16}  {:>8}  {}{}\n",
            meeting.id,
            date(&meeting.created_at),
            format_duration(meeting.duration_seconds),
            truncate_title(&meeting.title, 60),
            suffix
        ));
    }
    out.push_str(&format!(
        "{} of {} shown{}\n",
        page.items.len(),
        page.total,
        page.next_offset
            .map(|offset| format!("; next page: --offset {offset}"))
            .unwrap_or_default()
    ));
    out
}

pub fn render_meeting(meeting: &MeetingDetail) -> String {
    let mut out = String::new();
    out.push_str(&format!("{}\n", meeting.summary.title));
    out.push_str(&format!("ID:       {}\n", meeting.summary.id));
    out.push_str(&format!(
        "Date:     {}\n",
        date(&meeting.summary.created_at)
    ));
    out.push_str(&format!(
        "Length:   {}\n",
        format_duration(meeting.summary.duration_seconds)
    ));
    out.push_str(&format!("Project:  {}\n", meeting.summary.project));
    out.push_str(&format!("Status:   {}\n", meeting.summary.status));
    if let Some(template) = &meeting.template_id {
        out.push_str(&format!("Template: {template}\n"));
    }
    if let Some(failure) = &meeting.analysis_failure {
        out.push_str(&format!("Analysis: failed ({failure})\n"));
    }
    match meeting.summary_text.as_deref().map(str::trim) {
        Some(summary) if !summary.is_empty() => {
            out.push_str("\nSummary\n");
            out.push_str(summary);
            out.push('\n');
        }
        _ => out.push_str("\nSummary\n(none written yet)\n"),
    }
    let actions: Vec<&str> = meeting
        .action_items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect();
    if !actions.is_empty() {
        out.push_str("\nAction items\n");
        for item in actions {
            out.push_str(&format!("- {item}\n"));
        }
    }
    if let Some(notes) = meeting
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        out.push_str("\nNotes\n");
        out.push_str(notes);
        out.push('\n');
    }
    if !meeting.summary.has_transcript {
        out.push_str("\n(no transcript stored for this meeting)\n");
    }
    out
}

pub fn render_transcript_text(transcript: &TranscriptView) -> String {
    if transcript.segments.is_empty() {
        return if transcript.full_text.trim().is_empty() {
            "(empty transcript)\n".to_string()
        } else {
            format!("{}\n", transcript.full_text.trim())
        };
    }
    let mut out = String::new();
    for segment in &transcript.segments {
        match &segment.speaker {
            Some(speaker) => out.push_str(&format!(
                "[{}] {}: {}\n",
                clock(segment.start_seconds),
                speaker,
                segment.text.trim()
            )),
            None => out.push_str(&format!(
                "[{}] {}\n",
                clock(segment.start_seconds),
                segment.text.trim()
            )),
        }
    }
    out
}

pub fn render_srt(transcript: &TranscriptView) -> String {
    let mut out = String::new();
    for (position, segment) in transcript.segments.iter().enumerate() {
        out.push_str(&format!("{}\n", position + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            srt_time(segment.start_seconds),
            srt_time(segment.end_seconds)
        ));
        match &segment.speaker {
            Some(speaker) => out.push_str(&format!("{}: {}\n", speaker, segment.text.trim())),
            None => out.push_str(&format!("{}\n", segment.text.trim())),
        }
        out.push('\n');
    }
    out
}

pub fn render_search(query: &str, hits: &[SearchResult]) -> String {
    if hits.is_empty() {
        return format!("No transcript matches for \"{query}\".\n");
    }
    let mut out = String::new();
    for hit in hits {
        out.push_str(&format!(
            "{}  {}  [{}]\n    {}\n",
            hit.recording_id,
            truncate_title(&hit.title, 50),
            clock(hit.start_seconds),
            hit.text.split_whitespace().collect::<Vec<_>>().join(" ")
        ));
    }
    out
}

pub fn render_dictations(page: &Page<DictationEntry>) -> String {
    if page.items.is_empty() {
        return "No dictations yet.\n".to_string();
    }
    let mut out = String::new();
    for entry in &page.items {
        out.push_str(&format!(
            "{}  {}  {}\n    {}\n",
            date(&entry.created_at),
            format_duration(entry.duration_seconds),
            entry.id,
            entry.text.split_whitespace().collect::<Vec<_>>().join(" ")
        ));
    }
    out.push_str(&format!(
        "{} of {} shown{}\n",
        page.items.len(),
        page.total,
        page.next_offset
            .map(|offset| format!("; next page: --offset {offset}"))
            .unwrap_or_default()
    ));
    out
}

pub fn render_stats(stats: &Stats) -> String {
    let mut out = String::new();
    out.push_str(&format!("Database:   {}\n", stats.database_path));
    out.push_str(&format!(
        "Encrypted:  {}\n",
        if stats.database_encrypted {
            "yes (SQLCipher)"
        } else {
            "no"
        }
    ));
    out.push_str(&format!("Meetings:   {}\n", stats.meetings));
    out.push_str(&format!("Dictations: {}\n", stats.dictations));
    if stats.other_recordings > 0 {
        out.push_str(&format!("Other:      {}\n", stats.other_recordings));
    }
    out.push_str(&format!("Transcribed:{:>5}\n", stats.transcribed));
    out.push_str(&format!("Projects:   {}\n", stats.projects));
    out.push_str(&format!(
        "Total audio:{:>5}\n",
        format_duration(stats.total_duration_seconds)
    ));
    if let (Some(earliest), Some(latest)) = (&stats.earliest, &stats.latest) {
        out.push_str(&format!(
            "Range:      {} to {}\n",
            date(earliest),
            date(latest)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_tools::test_support::{transcript, FakeSource};
    use crate::local_tools::{ListFilter, MeetingSource};

    #[test]
    fn duration_and_clock_forms() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(59), "59s");
        assert_eq!(format_duration(65), "1m 05s");
        assert_eq!(format_duration(3_720), "1h 02m");
        assert_eq!(format_duration(-5), "0s");
        assert_eq!(clock(3_661.9), "01:01:01");
        assert_eq!(srt_time(3_661.25), "01:01:01,250");
        assert_eq!(srt_time(0.0), "00:00:00,000");
    }

    #[test]
    fn srt_numbers_cues_and_keeps_speakers() {
        let view = transcript("m1", 2);
        let srt = render_srt(&view);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:01,500\nMe: Segment 0"));
        assert!(srt.contains("\n2\n00:00:02,000 --> 00:00:03,500\nThem: Segment 1"));
    }

    #[test]
    fn transcript_text_carries_clock_and_speaker() {
        let view = transcript("m1", 1);
        assert!(render_transcript_text(&view).starts_with("[00:00:00] Me: Segment 0"));
    }

    #[test]
    fn list_and_stats_render_counts() {
        let source = FakeSource::sample();
        let page = source
            .list_meetings(&ListFilter {
                limit: 2,
                ..ListFilter::default()
            })
            .unwrap();
        let text = render_meeting_list(&page);
        assert!(text.contains("2 of 3 shown; next page: --offset 2"));
        assert!(text.contains("m3"));
        assert!(text.contains("[summary, actions]"));

        let stats = render_stats(&source.stats().unwrap());
        assert!(stats.contains("Meetings:   3"));
        assert!(stats.contains("Encrypted:  yes (SQLCipher)"));
    }

    #[test]
    fn meeting_detail_names_missing_summary_and_transcript() {
        let source = FakeSource::sample();
        let mut meeting = source.get_meeting("m1").unwrap().unwrap();
        meeting.summary_text = None;
        meeting.summary.has_transcript = false;
        let text = render_meeting(&meeting);
        assert!(text.contains("(none written yet)"));
        assert!(text.contains("(no transcript stored for this meeting)"));
        assert!(text.contains("- Send the deck"));
    }
}
