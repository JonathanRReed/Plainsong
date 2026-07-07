export const meta = {
  name: 'plainsong-build-pass1',
  description: 'Build Pass 1 — renderer-visible quick wins (hotkey sheet, tabular figures, neume phase glyphs, versal/empty-state craft)',
  phases: [{ title: 'Build', detail: 'disjoint-file builders using the new set-down vocabulary' }],
}

const BASE = `
Plainsong desktop app (Electron + React + shadcn, Tailwind v4) in nautilus-bot/. It's fully on-brand (read nautilus-bot/STYLE.md). North-star: the most elegant, functional, fully-LOCAL way to dictate into any app and capture meeting notes — "technology from an elegant advanced society." You are building tasteful, brand-faithful, OFFLINE-safe, a11y-clean, reduced-motion-safe refinements. Keep ALL gates green (tsc -p tsconfig.json && -p tsconfig.electron.json, vitest, knip, verify-dead-code-hygiene); don't change test-asserted text/labels/roles; don't add deps or unused imports; don't invent copy or fabricate values — source real hotkeys/shortcuts/labels from existing code.

NEW UTILITIES available in index.css (use these; do not reinvent):
  .time-spec (tabular figures — apply to every timer/duration/count) · .surface-elevation-1/2/3 (folio depth) · .gilt-halo (gold seating for the ONE earned mark) · .versal (real gilded drop-cap initial — keep the letter in the DOM) · .ink-in (per-segment stream fade) · .commit-shine (one gold sweep on set-down) · .gilt-reveal (first-paint gild) · .neume-live (slow live-capture breath, apply to a .neume) · .settle-stagger (staggered child reveals).
EXISTING: .rubric / .rubric-muted · .neume / .neume-lit / .neume-hollow / .neume-rust · .gilt-text · .manuscript · .staff-bg · .settle-in · text-gold-text (gold TEXT, AA-safe) · bg-gold/border-gold (fills) · text-rust/bg-rust.
RESTRAINT: gold is earned — at most one burnished gold per surface; selectors stay rust; neutral chrome stays muted. Motion is compositor-only and respects reduced-motion (the global CSS block already neutralizes animations; just don't add layout/filter animation).

Return a concise structured summary.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path', 'changes'],
    properties: { path: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } } },
}

const buckets = [
  { key: 'sidebar-hotkey', files: ['src/components/sidebar.tsx'], task: `
1) Persistent hotkey-status line: below the "Local only" chip, add ONE quiet mono line (~10-11px, .rubric-muted register) showing the real dictation hotkey, e.g. "Dictation · {hotkey}". SOURCE the hotkey label from the same place the rest of the app shows it (check src/lib/dictation-hotkey.ts / settings / how dictation-view's header renders "Cmd + Shift + Space") — do NOT hardcode a guess, and keep its toggle/hold wording consistent with the existing label (honesty contract). Clicking it should navigate to Settings (reuse the existing nav mechanism). Collapsed-rail: hide the text, keep an accessible affordance.
2) A "?" affordance (small icon button, accessible label "Keyboard shortcuts") that opens a shortcut sheet — a Dialog/Popover (reuse the existing ui/dialog or ui/popover) listing the app's real shortcuts (source from src/lib/shortcuts.ts and/or the ⌘H/⌘D/⌘M/⌘P/⌘, nav shortcuts already in App.tsx). Render each as label + mono keycaps (small rounded border-border bg-muted/40 mono chips). Calm, gold accent only on the title's rubric. Esc closes (Dialog gives this free).
3) The recording chip's pulse dot: use a .neume.neume-rust.neume-live (the slow scoped breath) instead of any fast ping, keeping the rust live meaning.
Keep everything restrained; no gold flood.` },

  { key: 'empty-headers', files: ['src/components/ui/empty-state.tsx', 'src/components/ui/page-header.tsx'], task: `
empty-state.tsx: make it a calm manuscript moment that lands gracefully — wrap the stacked content (glyph → title → description → action) in .settle-stagger so they settle in one after another; ensure the leading glyph is a neume (neume-hollow default) or the provided icon; the title in font-serif. Optionally give the opening of the title/description a subtle presence — but keep it restrained. Reduced-motion safe (global block handles it).
page-header.tsx: add an OPTIONAL "versal" boolean prop (default false). When true AND a title string is present, render the title's first letter as a real <span className="versal gilt-text">{first}</span> followed by the rest, so the letter stays in the DOM for screen readers (the whole word is still read). Keep the existing eyebrow + font-serif title behavior and the full existing API intact (versal is opt-in, off by default — no call sites change).` },

  { key: 'dictation-craft', files: ['src/components/views/dictation-view.tsx', 'src/components/recording-overlay.tsx'], task: `
Apply craft polish to the IN-APP dictation view + recording overlay (not the floating popups — those are a later pass):
1) .time-spec on every timer/duration/elapsed/count readout (so digits stop shimmering). Keep them mono.
2) Neume phase glyphs: where these surfaces show a dictation/recording state label (listening / recording / transcribing / ready / error), precede the label with the matching neume — neume-lit (active/ready/local), neume-rust (error/"not yet"), neume-hollow (idle/optional) — text stays the accessible source of truth. For an ACTIVE live state, use .neume-live on the neume (slow breath).
3) If either surface has a live "mic"/recording indicator that is the earned gold moment, give it .gilt-halo (one earned mark only). Don't gild selectors.
4) Any "result is ready / set down" text → font-serif .manuscript so the finished words read as inked text.
Keep restraint; preserve all logic/copy/props.` },
]

phase('Build')
const results = await parallel(buckets.map((b) => () =>
  agent(
    `${BASE}\n\nYOUR FILES (edit only these): ${b.files.join(', ')}\n\nBUILD:\n${b.task}\n\nApply it, keep gates green, and return the structured summary.`,
    { label: `pass1:${b.key}`, phase: 'Build', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
