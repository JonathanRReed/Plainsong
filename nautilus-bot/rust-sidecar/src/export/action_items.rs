//! Structured action items over the stored one-line form.
//!
//! The recording row stores action items as plain strings, one per item, so
//! a person can edit them as text in the meeting workspace. A grounded item
//! with an owner or a due date is stored as `task (Owner: X · Due: Y)`; this
//! module is the single place that writes and reads that form, so exports
//! and the UI can show the parts without a second storage column and a
//! hand-typed line still round-trips as its own task.

const OWNER_LABEL: &str = "Owner: ";
const DUE_LABEL: &str = "Due: ";
const DETAIL_SEPARATOR: &str = " · ";

/// Serialized into the JSON export beside the verbatim `action_items`, whose
/// neighbours there are snake_case.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StructuredActionItem {
    /// The stored line, unchanged.
    pub text: String,
    pub task: String,
    pub owner: Option<String>,
    pub due_date: Option<String>,
}

fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The stored form of one item.
pub fn format_action_item_for_storage(
    task: &str,
    owner: Option<&str>,
    due_date: Option<&str>,
) -> String {
    let mut details = Vec::new();
    if let Some(owner) = clean(owner) {
        details.push(format!("{OWNER_LABEL}{owner}"));
    }
    if let Some(due) = clean(due_date) {
        details.push(format!("{DUE_LABEL}{due}"));
    }
    if details.is_empty() {
        task.trim().to_string()
    } else {
        format!("{} ({})", task.trim(), details.join(DETAIL_SEPARATOR))
    }
}

/// Read the stored form back. A line that does not end in a recognised
/// `(Owner: … · Due: …)` suffix is one task with no owner and no date — a
/// person's own parenthetical is never mistaken for structure.
pub fn parse_stored_action_item(text: &str) -> StructuredActionItem {
    let trimmed = text.trim();
    let whole = StructuredActionItem {
        text: trimmed.to_string(),
        task: trimmed.to_string(),
        owner: None,
        due_date: None,
    };
    let Some(without_close) = trimmed.strip_suffix(')') else {
        return whole;
    };
    let Some(open) = without_close.rfind(" (") else {
        return whole;
    };
    let task = without_close[..open].trim();
    let suffix = &without_close[open + 2..];
    if task.is_empty() || suffix.is_empty() {
        return whole;
    }
    let mut owner = None;
    let mut due_date = None;
    for part in suffix.split(DETAIL_SEPARATOR) {
        if let Some(value) = part.strip_prefix(OWNER_LABEL) {
            if owner.is_some() {
                return whole;
            }
            owner = clean(Some(value));
        } else if let Some(value) = part.strip_prefix(DUE_LABEL) {
            if due_date.is_some() {
                return whole;
            }
            due_date = clean(Some(value));
        } else {
            return whole;
        }
    }
    if owner.is_none() && due_date.is_none() {
        return whole;
    }
    StructuredActionItem {
        text: trimmed.to_string(),
        task: task.to_string(),
        owner,
        due_date,
    }
}

/// Every non-empty stored line, parsed.
pub fn structured_action_items(items: &[String]) -> Vec<StructuredActionItem> {
    items
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(parse_stored_action_item)
        .collect()
}

/// One Markdown bullet with the parts spelled out.
pub fn markdown_bullet(item: &StructuredActionItem) -> String {
    let mut line = format!("- {}", item.task);
    let mut details = Vec::new();
    if let Some(owner) = &item.owner {
        details.push(format!("**Owner:** {owner}"));
    }
    if let Some(due) = &item.due_date {
        details.push(format!("**Due:** {due}"));
    }
    if !details.is_empty() {
        line.push_str(" — ");
        line.push_str(&details.join(DETAIL_SEPARATOR));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_owner_and_due_through_the_stored_form() {
        let stored = format_action_item_for_storage("Send the deck", Some("Jane"), Some("Friday"));
        assert_eq!(stored, "Send the deck (Owner: Jane · Due: Friday)");
        let parsed = parse_stored_action_item(&stored);
        assert_eq!(parsed.task, "Send the deck");
        assert_eq!(parsed.owner.as_deref(), Some("Jane"));
        assert_eq!(parsed.due_date.as_deref(), Some("Friday"));
        assert_eq!(parsed.text, stored);
    }

    #[test]
    fn owner_only_and_due_only_forms_parse() {
        let owner_only = parse_stored_action_item("Book the room (Owner: Sam)");
        assert_eq!(owner_only.task, "Book the room");
        assert_eq!(owner_only.owner.as_deref(), Some("Sam"));
        assert_eq!(owner_only.due_date, None);

        let due_only = parse_stored_action_item("Book the room (Due: 2026-09-05)");
        assert_eq!(due_only.owner, None);
        assert_eq!(due_only.due_date.as_deref(), Some("2026-09-05"));
    }

    #[test]
    fn blank_parts_are_omitted_when_formatting() {
        assert_eq!(
            format_action_item_for_storage("  Task  ", Some("  "), None),
            "Task"
        );
        assert_eq!(
            format_action_item_for_storage("Task", None, Some("Monday")),
            "Task (Due: Monday)"
        );
    }

    #[test]
    fn a_persons_own_parenthetical_stays_part_of_the_task() {
        for text in [
            "Review the plan (draft two)",
            "Call the vendor (Owner: )",
            "Ship it (Owner: Al · Owner: Bo)",
            "Ship it (Owner: Al · Note: soon)",
            "(Owner: Nobody)",
            "Plain task",
        ] {
            let parsed = parse_stored_action_item(text);
            assert_eq!(parsed.task, text.trim(), "{text}");
            assert_eq!(parsed.owner, None, "{text}");
            assert_eq!(parsed.due_date, None, "{text}");
        }
    }

    #[test]
    fn structured_list_skips_blank_lines_and_markdown_spells_out_the_parts() {
        let items = structured_action_items(&[
            "Send the deck (Owner: Jane · Due: Friday)".to_string(),
            "   ".to_string(),
            "Plain task".to_string(),
        ]);
        assert_eq!(items.len(), 2);
        assert_eq!(
            markdown_bullet(&items[0]),
            "- Send the deck — **Owner:** Jane · **Due:** Friday"
        );
        assert_eq!(markdown_bullet(&items[1]), "- Plain task");
    }
}
