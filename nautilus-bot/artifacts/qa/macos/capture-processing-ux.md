# Capture: Meeting processing UX: immediate `processing` status + spinner + detail auto-refresh

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T22:23:20.000Z

## Evidence

- Packaged mic-only artifact: `artifacts/qa/macos/capture-meeting-mic.json`
- Packaged system-audio artifact: `artifacts/qa/macos/capture-meeting-system-audio.json`
- UI regression tests: `src/__tests__/recordings-view.test.tsx`
- Detail auto-refresh tests: `src/__tests__/use-recording-detail.test.tsx`

## Commands

- `bun run qa:packaged:macos:meeting:mic`
- `bun run qa:packaged:macos:meeting:system`
- `bun run test -- src/__tests__/use-recording-detail.test.tsx src/__tests__/recordings-view.test.tsx`
- `bun run typecheck`

## Verified Checks

- Packaged mic-only meeting capture moves the recording row to `processing` immediately after stop.
- Packaged system-audio meeting capture moves the recording row to `processing` immediately after stop.
- Packaged recording overlay enters `transcribing` after stop.
- Packaged status events include `recording` and `processing`.
- The meeting list updates immediately when a `recording-status-changed` event enters `processing`.
- The meeting list renders the `Processing` state with the spinner-bearing row surface.
- The selected recording detail hook auto-refreshes a processing recording until canonical completed data lands.
- Transcript and transcript-detail refresh calls are included in the processing auto-refresh path.

## Notes

- This row combines packaged sidecar evidence for the immediate processing transition with focused renderer tests for the spinner and detail auto-refresh behavior.
- Long-duration soak coverage remains separate in `artifacts/qa/macos/capture-soak-3h.md`.
