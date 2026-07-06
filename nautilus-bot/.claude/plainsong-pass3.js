export const meta = {
  name: 'plainsong-build-pass3',
  description: 'Build Pass 3 — the Scriptorium reading surface (transcript as illuminated leaf) + recording-list status bands',
  phases: [{ title: 'Build', detail: 'transcript-viewer + recordings-view, the place users read' }],
}

const BASE = [
  'Plainsong desktop app (Electron + React, Tailwind v4) in nautilus-bot/. Read nautilus-bot/STYLE.md. North-star: the most elegant, fully-LOCAL way to dictate into any app and capture meetings — technology from an elegant advanced society. This pass makes the place users spend the MOST minutes — reading transcripts and triaging recordings — feel like a true illuminated manuscript leaf, calm and trustworthy.',
  '',
  'HARD CONSTRAINTS: keep ALL gates green (tsc -p tsconfig.json AND -p tsconfig.electron.json, vitest, knip, verify-dead-code-hygiene, vite build). Do NOT change test-asserted text/labels/roles (transcript-viewer.test.tsx and recordings-view.test.tsx must keep passing). No new deps, no unused imports. OFFLINE/local-first and HONEST (local by default; cloud is opt-in and NAMED; never claim absolute privacy). a11y-clean (decorative glyphs aria-hidden; real letters stay in the DOM for versals; keep accessible labels), reduced-motion + forced-colors are handled globally. RESTRAINT: gold is earned — at most one burnished gold per surface; rust = rubric/structure/not-yet; neutral chrome stays muted; no stoplight hues.',
  '',
  'VOCABULARY (index.css): .versal (real gilded drop-cap initial; keep the letter in the DOM) · .gilt-text · .manuscript (Newsreader inked body) · .rubric / .rubric-muted (mono uppercase labels) · .neume / .neume-lit / .neume-hollow / .neume-rust · .neume-live · .settle-in / .settle-stagger · .time-spec (tabular figures) · .surface-elevation-1/2/3 · text-gold-text / bg-gold / border-gold · text-rust / bg-rust / border-rust · .staff-bg.',
  '',
  'Return a concise structured summary.',
].join('\n')

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path', 'changes'],
    properties: { path: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } } },
}

const buckets = [
  { key: 'scriptorium', files: ['src/components/transcript-viewer.tsx'], task: [
    'Rebuild the transcript into an illuminated reading leaf. Read the file first; preserve all logic, playback/scrub behavior, editing, copy, props, and test-asserted text.',
    '1) MANUSCRIPT BODY: the transcript text reads in Newsreader (.manuscript) with a comfortable measure and line-height; timestamps/speaker labels stay mono rubric (.rubric-muted) and tabular (.time-spec). Keep it calm and legible for long reads.',
    '2) VERSAL: the very first word of the transcript opens with a real gilded drop-cap — wrap the first letter as <span className="versal gilt-text">{first}</span> followed by the rest, so the whole word stays in the DOM for screen readers. Only the first segment, once.',
    '3) SPEAKER RULES + BADGES: separate speaker turns with a faint gold-ambient hairline rule; render each speaker label as a quiet rubric; you may gild the FIRST occurrence of each speaker badge subtly (text-gold-text) and keep later mentions neutral. The currently-active speaker is gold, others neutral (restraint).',
    '4) PLAYHEAD NEUME: the segment currently playing gets a left-edge .neume.neume-lit (settling in ~150ms) + a faint bg-gold/5; keep the existing word-level dotted-gold playback underline.',
    '5) LOW-CONFIDENCE: keep the dotted-gold underline on low-confidence words, but surface the readout as an inline .neume-hollow + a muted "Low confidence" badge (rubric), not a bare percentage — never red/amber.',
    '6) TRUST BADGE: add a toolbar badge stating provenance — "Local transcript" with .neume-lit when transcription was on-device, or "Cloud (Name)" with .neume-hollow when a named cloud provider was used. Source the local/remote state from existing settings/props (do not fabricate; honest, named).',
    '7) INFO STRIP: a calm top strip in mono rubric — word count, approximate minutes, average confidence, and Local/Cloud — using .time-spec for figures. Numbers must be defensible from the actual transcript data (compute word count / derive minutes from timestamps; label confidence "avg").',
    '8) RIBBON BOOKMARK (optional, session-scoped): a thin gold left-edge marking the last-read/last-played position per recording, stored in component/session state only (no persistence backend). If it adds risk to tests, keep it minimal or omit — do not break anything.',
    'Keep transcript-viewer.test.tsx passing (it checks Me/Them + segment text).',
  ].join('\n') },

  { key: 'recordings-list', files: ['src/components/views/recordings-view.tsx'], task: [
    'Refine the meetings/recordings list + notes for calm daily triage. Read the file first; preserve all logic, data, copy, props, and test-asserted text. This file already had the brand sweep + earlier polish — layer these on top, do not regress them.',
    '1) STATUS BANDS: give each recording-list card a 1.5-2px LEFT band encoding state — gold = ready/done, rust = needs-attention/error, gold-ambient (bronze) = processing, muted/border = draft — paired with a small mono status word (.rubric-muted). Where this duplicates an existing status badge, prefer the band + remove the redundant badge so the row is calmer. Use border-left (remember: single-sided border => border-radius 0 on that element).',
    '2) AI-vs-MANUAL HONESTY GLYPH: in the meeting notes/detail, mark LLM-generated sections (e.g. Summary, Action Items) with a subtle rust left-accent or an inline .neume-rust + a tiny rubric note, while hand-typed/raw sections stay unmarked. This makes provenance honest and calm (no loud banner).',
    '3) Ensure list timestamps/durations use .time-spec; section/group headers use .rubric; the selected/active recording carries the single earned gold (border-gold/40 bg-gold/10), others neutral.',
    'Keep recordings-view.test.tsx passing.',
  ].join('\n') },
]

phase('Build')
const results = await parallel(buckets.map((b) => () =>
  agent(
    BASE + '\n\nYOUR FILES (edit only these): ' + b.files.join(', ') + '\n\nBUILD:\n' + b.task + '\n\nApply it carefully, keep every gate + the relevant tests green, and return the structured summary.',
    { label: 'pass3:' + b.key, phase: 'Build', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
