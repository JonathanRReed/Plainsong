## Goal

Fix the macOS dictation auto-insert path when transcription succeeds but Nautilus falls back to clipboard-only despite Accessibility appearing enabled in System Settings.

## Findings

- The live app is running from `/Applications/Nautilus.app`, so this is not the existing DMG-copy mismatch case.
- The live settings already request cursor insertion:
  - `dictationInsertionMode = "auto"`
  - `dictationPasteToCursor = true`
- The observed behavior is: transcript succeeds, text lands on the clipboard, and the final paste dispatch fails.
- The current diagnostics rely heavily on `AXIsProcessTrusted()`, but the actual paste pipeline can still fail for a different reason than the simple trust bit exposed in readiness UI.

## Approach

1. Preserve the current insertion behavior.
2. Add structured backend diagnostics for the last cursor-insert attempt so the UI can show the real failure mode instead of a generic Accessibility state.
3. Track successful cursor insertion as a first-class readiness signal for the active app session.
4. When paste falls back to clipboard-only, expose whether the failure looked like:
   - Accessibility / event dispatch failure
   - Automation / Apple Events failure
   - Self-target / frontmost-app mismatch
   - Other paste dispatch failure

## Backend Changes

- Extend permission diagnostics with the latest insert-at-cursor attempt status.
- Extend paste outcome reporting with a machine-readable failure reason plus the human-readable message already returned to the user.
- Update macOS permission diagnostics to combine:
  - `AXIsProcessTrusted()`
  - `accessibility_trust_observed`
  - last insert attempt status
- Keep successful insert as the strongest positive signal for session readiness.

## Frontend Changes

- Update the Apple Native setup card to distinguish:
  - “Accessibility API says ready”
  - “Cursor insert already worked in this session”
  - “Latest insert fell back to clipboard-only”
- Show the latest backend-reported insert failure reason inline so the user sees why paste failed.

## Testing

- Add backend tests for the new insert diagnostics mapping.
- Update frontend tests for the Apple Native setup card messaging where needed.
- Re-run frontend tests, production build, and targeted backend tests.
