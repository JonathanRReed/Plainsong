export const meta = {
  name: 'plainsong-elegance-polish',
  description: 'Refine every surface for elegance, restraint, and intuitiveness — measured, on-brand, behavior-preserving',
  phases: [{ title: 'Refine', detail: 'one refiner per disjoint surface, tight elegance rubric' }],
}

const RUBRIC = `
You are REFINING an already on-brand Plainsong surface (vellum/ink + one gold accent + one rust rubric; Newsreader serif / IBM Plex Mono rubrics / IBM Plex Sans body). The color sweep is DONE. Now make it ELEGANT, SLEEK, and INTUITIVE without getting in the user's way. Read STYLE.md first (nautilus-bot/STYLE.md).

MAKE MEASURED IMPROVEMENTS, NOT A REDESIGN. Preserve all behavior, logic, copy text, props, data flow, and accessibility. The build, typecheck, tests and knip must stay green — do NOT remove used imports or add unused ones, do NOT add dependencies, do NOT change component APIs/exports, do NOT alter test-asserted text/labels/roles.

ELEGANCE PRINCIPLES (apply where they fit your files):
1. GOLD HIERARCHY / RESTRAINT (most important): gold is EARNED. Per surface allow at most ONE burnished/earned gold moment — the primary CTA or the live "set down"/recording state. Demote competing golds: when several items each carry gold text/labels (e.g. a row of cards that ALL have a gold caption), keep gold only on the ACTIVE/selected/primary one and make the rest text-muted-foreground. Never gold-flood. (text-gold-text only for gold TEXT; bg-gold/border-gold/ring-gold for fills.)
2. RUBRIC HEADERS: a view/section header should read: a small mono UPPERCASE rust eyebrow, then a Newsreader title, then muted supporting copy. Eyebrow pattern (use verbatim, pick a short true label): <p className="rubric mb-1.5">DICTATION</p> above the serif <h1>. Titles/headed sections use font-serif. Use the existing PageHeader component if the view already imports it.
3. PANEL RHYTHM: prefer panels + spacing over nested cards. Avoid card-in-card-in-card (3+ nesting). Flatten an inner card to a bordered/spaced region (border-t border-border pt-4, or surface-panel) when it is nested inside another card/panel.
4. QUIET STATES: empty / loading / error states are calm manuscript moments — a centered neume or small serif line + one muted guidance sentence, not loud blocks. (e.g. a <span class="neume neume-hollow"/> or a gilded glyph + serif headline + muted line.)
5. SPACING & TYPE: consistent vertical rhythm (gap-2/3/4/6, p-4/5/6); clear scale — serif headings, sans body, mono for rubric/metadata/timestamps/specs/keycaps; generous but not sparse; tabular-nums for figures.
6. MOTION: reveals/hovers use .transition-smooth / --ease-settle; never add always-on motion to trust/failure surfaces; respect reduced-motion.
7. INTUITIVE: one obvious primary action (the gold CTA); secondary actions quiet (ghost/outline/secondary). Dense areas stay scannable via rust .rubric section labels. Don't make the user hunt; don't block their flow.
8. A11y: keep AA contrast, focus-visible gold rings, accessible labels, real letters in versals.

Return a concise structured summary of the measured refinements you made.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['path', 'refinements'],
      properties: {
        path: { type: 'string' },
        refinements: { type: 'array', items: { type: 'string' } },
        risk: { type: 'string', description: 'anything a human should re-check, or empty' },
      } } },
  },
}

const buckets = [
  { key: 'shell', files: ['src/components/sidebar.tsx','src/components/ui/page-header.tsx','src/App.tsx'], focus: `
sidebar.tsx: refine the active-nav mark into a quiet manuscript cue — keep the gold-tint but add a thin gold left rule or a small neume marker on the active item (intuitive "you are here"); ensure inactive items are calm neutral. Tidy the footer (Theme / Local-only chips) into one calm row with consistent height. Optionally back the nav region with a very faint .staff-bg (keep it barely-there). Keep the gilded "P" wordmark. Don't gold-flood — only the active item + the local neume are gold.
page-header.tsx: support a rust rubric eyebrow above the serif title (an optional 'eyebrow' prop rendered as <p className="rubric mb-1.5">). Keep the existing API working (eyebrow optional). Title stays font-serif.
App.tsx: the Suspense fallback "Loading workspace..." -> a calm centered manuscript moment (a small neume or gilded glyph + a quiet serif line). The ErrorBoundary card: refine to an elegant centered panel (serif heading already rust, muted body, quiet secondary "Try Again").` },

  { key: 'dictation', files: ['src/components/views/dictation-view.tsx'], focus: `
THE flagship view. (a) GOLD RESTRAINT: the profile/"Flow Profiles" cards currently each show a gold "Best for ..." caption — keep gold ONLY on the Active profile's caption; make every other card's caption text-muted-foreground. Audit the whole view for any other gold flood and demote to muted except the active/primary/live element. (b) Add a rust .rubric eyebrow above the "Dictation" title. (c) PANEL RHYTHM: the "Flow Profiles" panel wraps a "Solo lanes" card wrapping the profile cards — de-nest one level (make "Solo lanes" a spaced/bordered region, not a nested card). (d) The live dictation/"set down" moment is the one earned gold. Keep it tasteful and intuitive.` },

  { key: 'home-small', files: ['src/components/views/dashboard-view.tsx','src/components/views/projects-view.tsx','src/components/views/exports-view.tsx'], focus: `
Each view: rust .rubric eyebrow + serif title header. GOLD RESTRAINT (one earned gold per view max). Make empty states calm manuscript moments (neume + serif line + one muted sentence). Neutral chrome icons stay muted. Consistent card/panel rhythm; avoid nested-card stacks. Keep stat/figure readouts in mono tabular-nums.` },

  { key: 'recordings', files: ['src/components/views/recordings-view.tsx'], focus: `
Meetings/recordings list + detail. Rust .rubric eyebrow + serif title. GOLD RESTRAINT (active/selected recording = gold; the rest neutral). Refine the list row rhythm (consistent spacing, mono timestamps/durations, quiet metadata). Empty state = calm manuscript moment. De-nest cards where stacked. Keep it scannable and fast.` },

  { key: 'settings', files: ['src/components/views/settings-view-simple.tsx'], focus: `
Dense settings — keep it usable and SCANNABLE; do NOT restructure logic or change any labels/roles asserted by tests. Apply ONLY: (a) section headings as rust .rubric labels (mono uppercase) so groups are scannable; (b) GOLD RESTRAINT — demote any gold-flooded readouts to muted, keep gold only on genuine enabled/ready states; (c) a rust .rubric eyebrow + serif title on the top header; (d) consistent vertical rhythm/spacing between groups. No nested-card overload. Surgical changes only.` },

  { key: 'setup', files: ['src/components/views/setup-view.tsx','src/components/first-run-wizard.tsx'], focus: `
Onboarding/setup — the user's FIRST impression; make it elegant and reassuring, never in the way. Rust .rubric step/eyebrow labels, serif titles, calm muted guidance. GOLD RESTRAINT — the single "ready/continue" primary action is the one gold CTA; checks/steps use neume glyphs (neume-lit done / neume-hollow pending) or muted text, not gold-flood. Generous spacing, clear one-action-per-step flow.` },

  { key: 'quiet-prims', files: ['src/components/ui/empty-state.tsx','src/components/ui/card.tsx','src/components/ui/badge.tsx','src/components/toast.tsx','src/components/ui/separator.tsx'], focus: `
empty-state.tsx: make THE canonical calm manuscript empty state — a centered neume (or gilded glyph) + serif (font-serif) headline + one muted sentence + optional quiet action. This is reused everywhere, so make it lovely and restrained.
card.tsx: refine default radius/border/shadow to feel like paper (subtle), consistent padding rhythm.
badge.tsx: refine sizing/tracking so badges read as small rubrics (mono, tight). Keep variant names + colors.
toast.tsx: refine to a calm slide-in with a leading neume/icon; keep gold(success)/rust(error)/neutral(info).
separator.tsx: ensure it reads as a faint paper rule.` },

  { key: 'signature', files: ['src/components/recording-overlay.tsx','src/components/popups/dictation-popup.tsx','src/components/popups/recording-popup.tsx','src/components/waveform-visualizer.tsx'], focus: `
THE earned gilt moments (voice -> notation -> written record). Make the live recording/dictation "set down" state feel special but never noisy: the waveform reads as the chant staff resolving into gold neumes; the live state is the ONE burnished gold per surface; mode/template SELECTORS stay rust rubric (already). Refine spacing, the LIVE/timer readout in mono tabular-nums, neume state glyphs, and calm settle motion (respect reduced-motion). Keep popups compact and legible. Don't gold-flood — selectors and chrome stay neutral/rust; only the live capture is gold.` },

  { key: 'content', files: ['src/components/transcript-viewer.tsx','src/components/ai-analysis-panel.tsx','src/components/asr-provider-manager.tsx'], focus: `
transcript-viewer.tsx: the transcript should READ like an inked manuscript — Newsreader (.manuscript) body, comfortable measure/line-height, mono timestamps + speaker labels as quiet rubrics, low-confidence words a dotted-gold underline (already). Active speaker gold, others neutral — restraint.
ai-analysis-panel.tsx: rust .rubric section labels, serif headings, muted body, one gold accent max; calm empty/loading.
asr-provider-manager.tsx: keep it scannable — rust .rubric group labels, gold only on installed/ready, neutral chrome; consistent row rhythm; avoid nested-card overload.` },
]

phase('Refine')
const results = await parallel(buckets.map((b) => () =>
  agent(
    `${RUBRIC}\n\nYOUR FILES (edit only these): ${b.files.join(', ')}\n\nFOCUS FOR YOUR SURFACE:\n${b.focus}\n\nApply the measured refinements, then return the structured summary. Keep every gate green.`,
    { label: `polish:${b.key}`, phase: 'Refine', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
