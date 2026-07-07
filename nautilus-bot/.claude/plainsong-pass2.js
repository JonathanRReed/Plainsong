export const meta = {
  name: 'plainsong-build-pass2',
  description: 'Build Pass 2 — the set-down HUD loop (waveform settles into neumes, partials ink in, commit shine, serif done-title)',
  phases: [{ title: 'Build', detail: 'dictation HUD + recording HUD, additive & test-safe' }],
}

const BASE = `
Plainsong desktop app (Electron + React, Tailwind v4) in nautilus-bot/. Read nautilus-bot/STYLE.md. North-star: the most elegant, fully-LOCAL way to dictate into any app and capture meetings — "technology from an elegant advanced society." This pass builds the SIGNATURE moment: voice -> notation -> written record, made FELT in the floating HUDs.

HARD CONSTRAINTS:
- The floating popups render in separate Electron windows and CANNOT be eyeballed in a browser; the ONLY safety net is the existing tests (src/__tests__/dictation-popup.test.tsx, recording-popup.test.tsx) which mount real phases. So: do NOT change any test-asserted text/labels/roles, and keep those tests passing. Keep ALL gates green (tsc -p tsconfig.json && -p tsconfig.electron.json, vitest, knip, verify-dead-code-hygiene, vite build). No new deps, no unused imports.
- The FINAL inserted/delivered text must remain exactly the batch result — partial-preview animations are PURELY visual (never change what text is produced).
- Everything OFFLINE-safe, a11y-clean (aria-hidden on decorative glyphs; text stays the accessible truth), and reduced-motion-safe. The global CSS prefers-reduced-motion block neutralizes CSS animations; for any JS/canvas animation, guard with matchMedia('(prefers-reduced-motion: reduce)'). Forced-colors handled globally.
- RESTRAINT: the live-capture state is the ONE earned burnished-gold moment per surface; selectors stay rust; chrome stays neutral. Don't gold-flood.
- Any new props on shared components (e.g. audio-waveform / waveform-visualizer) must be OPTIONAL/ADDITIVE so other consumers don't break.

VOCABULARY (in index.css): .ink-in (per-segment stream fade+settle) · .commit-shine (ONE gold left-to-right sweep as text is set down) · .gilt-halo (layered gold seating for the earned mark) · .neume-live (slow scoped live breath on a .neume) · .neume / .neume-lit / .neume-hollow / .neume-rust · .settle-in / .settle-stagger · .manuscript (Newsreader inked text) · .time-spec (tabular figures) · .gilt-text · text-gold-text / bg-gold / border-gold · text-rust.

Return a concise structured summary, and in 'note' call out exactly what needs on-device (real-mic) feel-tuning.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path', 'changes'],
    properties: { path: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } } },
}

const buckets = [
  { key: 'dictation-hud', files: ['src/components/popups/dictation-popup.tsx', 'src/components/waveform-visualizer.tsx', 'src/components/ui/audio-waveform.tsx'], task: `
Build the dictation "set-down" loop (the hero). Read all three files first.
1) PARTIALS INK IN: as live partial text streams into the preview, new text should fade+settle like drying ink. Wrap the changing preview text so it re-animates on change — e.g. give the preview text element a React key tied to the partial content and class .ink-in (so each update briefly fades in), OR wrap the newest trailing segment in a <span className="ink-in">. Keep it subtle; reduced-motion-safe; do NOT alter the final delivered text.
2) WAVEFORM SETTLES INTO NEUMES: this is the brand thesis. When the phase leaves "recording" and the result is set down (transcribing->ready/done), the live waveform should resolve into a short row of gold neumes. Cleanest robust approach: in waveform-visualizer (or the popup where the waveform sits), when settled/done, render a row of ~5-7 <span className="neume neume-lit"> diamonds that settle in (.settle-stagger / staggered .settle-in) as the canvas waveform fades out (opacity transition). Add an optional 'phase'/'settled' prop to waveform-visualizer (additive, default current behavior) so the popup drives it. Reduced-motion: show the static neume row immediately (no morph).
3) COMMIT SHINE: on the delivering/inserting phase (text committing to the target app), apply .commit-shine to the result/preview text container so a single restrained gold sheen sweeps across once.
4) GILT MARK: the live-capture mic indicator is the one earned gold — add .gilt-halo to it (layered gold seating) on top of its existing gold treatment. Precede the phase label with a .neume.neume-lit.neume-live glyph during active capture.
5) DONE TITLE: the done/result title set in font-serif .manuscript so the finished words read as inked text.
6) audio-waveform.tsx: only touch if needed to support the settle (keep its API additive/back-compat — recording-popup consumes it).
Keep dictation-popup.test.tsx passing (it asserts phase text/roles).` },

  { key: 'recording-hud', files: ['src/components/popups/recording-popup.tsx'], task: `
Apply the same set-down craft to the meeting recording HUD (consumes ui/audio-waveform; do NOT edit that file here — only consume it, treat any new props as optional).
1) GILT MARK: the live-recording indicator is the one earned gold — add .gilt-halo; precede the live status with a .neume.neume-lit.neume-live glyph (the rust status pill already exists for "ambient status" — keep the gold strictly for the genuine live-capture mark, not a flood).
2) SERIF: the meeting title / "Live meeting" heading and the notes/result heading set in font-serif (.manuscript where it's the inked content) so the captured record reads as a manuscript.
3) COMMIT SHINE: if there's a moment notes/transcript are committed/saved, apply .commit-shine once to that block.
4) .time-spec already on the timer — verify it stays; ensure any other figures are tabular.
Keep recording-popup.test.tsx passing (asserts status/labels). Restraint: one earned gold; selectors/chrome stay rust/neutral.` },
]

phase('Build')
const results = await parallel(buckets.map((b) => () =>
  agent(
    `${BASE}\n\nYOUR FILES (edit only these): ${b.files.join(', ')}\n\nBUILD:\n${b.task}\n\nApply it carefully, keep every gate + the popup tests green, and return the structured summary.`,
    { label: `pass2:${b.key}`, phase: 'Build', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
