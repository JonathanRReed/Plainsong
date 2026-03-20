export function formatAppliedDictationCommandLabel(
  command: string | null | undefined
): string | null {
  if (!command) {
    return null;
  }

  switch (command) {
    case "rewrite_shorter":
      return "Rewrite shorter";
    case "rewrite_professional":
      return "Rewrite professional";
    case "bulletize_selection":
      return "Bulletize selection";
    case "undo_last_insert":
    case "backtrack_undo_last_insert":
      return "Undo last insert";
    case "backtrack_replace_last_insert":
      return "Backtrack replace last insert";
    case "backtrack_replace_phrase":
      return "Backtrack replace phrase";
    default:
      return command
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function isBacktrackDictationCommand(command: string | null | undefined): boolean {
  return Boolean(command && command.startsWith("backtrack_"));
}
