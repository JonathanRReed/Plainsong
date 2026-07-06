export const meta = {
  name: 'plainsong-audit-fixes',
  description: 'Apply the capstone STYLE-audit fix-list: purge slate/white from popups + scattered brand/a11y fixes',
  phases: [{ title: 'Fix', detail: 'disjoint-file fixers applying the prioritized audit list' }],
}

const BASE = `
You are applying targeted fixes to the Plainsong desktop app (already brand-restyled; contract = nautilus-bot/STYLE.md — read it). Two accents only: gold + rust; vellum/ink warm-neutral grounds; NO cool neutrals (slate/gray/zinc/stone) and NO raw white/black/navy — use the warm brand tokens. Make MINIMAL, surgical edits: only the changes listed. Preserve all behavior, copy, props, logic, and any test-asserted text/labels/roles. Keep build, typecheck, tests, and knip green (don't orphan or add imports). Return a concise structured summary.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['path', 'edits'],
      properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } },
  },
}

const POPUP_MAP = `
OFF-PALETTE -> BRAND TOKEN MAPPING (apply to EVERY occurrence; these are theme-adaptive and preserve the dark-glass look since these popovers render on the ink/popover ground):
  text-slate-100  -> text-foreground
  text-slate-200  -> text-foreground
  text-slate-300  -> text-muted-foreground
  text-slate-400  -> text-muted-foreground
  text-slate-500  -> text-muted-foreground
  text-slate-600  -> text-muted-foreground
  hover:text-slate-200 -> hover:text-foreground
  text-white      -> text-foreground   (these are body/label text on the glass panel)
  bg-white/N      -> bg-foreground/N    (keep the same N; a foreground-tint is the theme-adaptive equivalent of a subtle white raise — e.g. bg-white/5 -> bg-foreground/5)
  border-white/8  -> border-foreground/10
  border-white/10 -> border-foreground/10
  border-white/12 -> border-foreground/15
  bg-slate-950/92 -> bg-popover/95
  bg-slate-950/90 -> bg-popover/95
  bg-black/80     -> bg-popover/95
  shadow rgba(2,6,23,A)  -> rgba(28,22,14,A)   (warm ink instead of cool navy; keep the same alpha A)
After editing, grep your files to confirm ZERO remaining: slate-, -white, -black, gray-, zinc-, stone-, neutral-[0-9], and rgba(2,6,23. The MODE_META rust accents and the gold live-capture moment must remain unchanged.
`

const buckets = [
  { key: 'popups', files: ['src/components/popups/dictation-popup.tsx','src/components/popups/recording-popup.tsx'], task: `
PURGE the cool-neutral/white palette from both floating HUD popups (~68 in dictation-popup, ~13 in recording-popup). ${POPUP_MAP}
recording-popup.tsx already uses bg-background/95 + text-foreground + border-border/80 at its root — make the inner chips consistent with that via the mapping. Keep the rust status pill, the gold live-recording 'set down' moment (mic gilt-edge + gold waveform), and the neume glyphs as they are.` },

  { key: 'cards-dialog-settings', files: ['src/components/ui/card.tsx','src/components/ui/dialog.tsx','src/components/views/settings-view-simple.tsx'], task: `
1) ui/card.tsx (~line 45): CardTitle base className lacks font-serif — add font-serif so all card headings are Newsreader (e.g. "font-serif text-2xl font-semibold leading-none tracking-tight"). This is a global typography win.
2) ui/dialog.tsx: replace the 1 cool-neutral/white class with the warm token equivalent (text-white->text-foreground, bg-white/N->bg-foreground/N, *-slate-*->foreground/muted-foreground, border-white->border-border).
3) settings-view-simple.tsx: (a) line ~2669 h2 "Overview" -> add font-serif. (b) replace the 2 cool-neutral/white classes with warm tokens. (c) the five <h3 className="rubric"> "Power user" eyebrows (lines ~3504,3655,3744,4348,5192): change the element from <h3> to <p> for honest semantics (keep the .rubric class). Do NOT change any label text or roles asserted by tests.` },

  { key: 'recordings-asr-gold', files: ['src/components/views/recordings-view.tsx','src/components/asr-provider-manager.tsx'], task: `
GOLD RESTRAINT (gold is a hierarchy, not a flood) + icon-button a11y.
recordings-view.tsx: (a) line ~2476 "Live meeting" badge and ~2846 detail-sidebar "Live meeting" badge are gold the same row/area as the gold "Consent confirmed" (~2487) badge -> DEMOTE both "Live meeting" badges to neutral (border-border bg-muted/30 text-foreground) with a leading <span class="neume neume-lit"/> to mark liveness; keep gold ONLY on "Consent confirmed". (b) add aria-label to the icon-only Play button (~2684, aria-label="Play audio recording") and MoreHorizontal button (~2698, aria-label="Recording options").
asr-provider-manager.tsx: per-row readiness badge (~1595) currently gets bg-gold when row.ready -> multiple peers flood gold. Replace the per-row gold badge with a neume state glyph: ready -> <span class="neume neume-lit"/>, not-ready -> <span class="neume neume-hollow"/>; keep gold ONLY on the single overall/overallReady badge (~1506).` },

  { key: 'a11y-dictview', files: ['src/components/transcript-viewer.tsx','src/components/views/projects-view.tsx','src/components/views/dictation-view.tsx'], task: `
transcript-viewer.tsx: add aria-label to the two icon-only buttons — the Check button (~68, aria-label="Save speaker name") and the Edit2 button (~94, aria-label="Edit speaker name").
projects-view.tsx: the MoreHorizontal icon-only button (~108) needs aria-label={\`Options for \${project.name}\`} (or a static "Project options" if name isn't in scope).
dictation-view.tsx: (a) the 1 remaining quiet-label (~4279) -> rubric-muted. (b) the 3 text-white on bg-rust (~3332,3375,3496) -> text-destructive-foreground. (c) replace any other cool-neutral/white (slate/gray/zinc/white) with warm tokens (text-foreground / text-muted-foreground / bg-foreground/N).` },

  { key: 'motion-overlay-wizard', files: ['src/components/toast.tsx','src/components/recording-overlay.tsx','src/components/first-run-wizard.tsx'], task: `
toast.tsx (~124-136): the JS progress bar sets bar.style.transition = "width ...ms linear" inline; inline JS motion is NOT caught by the global CSS reduced-motion block. Guard it: if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) skip the width animation (set transition='none', leave the bar static), else keep existing behavior.
recording-overlay.tsx (~174-177): the consent reminder is an informational (non-earned) surface using border-gold/20 bg-gold/8 text-gold-text -> demote: border-gold/20->border-border, bg-gold/8->bg-muted/10, text-gold-text->text-foreground; keep the consent CheckCircle/neume but neutral.
first-run-wizard.tsx (~727,737): the recommended ChoiceCard is a SELECTOR, not the earned moment -> bg-gold/10->bg-muted/20, text-gold-text->text-foreground, and mark "recommended" with a leading <span class="neume neume-lit"/> instead of gold text.` },
]

phase('Fix')
const results = await parallel(buckets.map((b) => () =>
  agent(
    `${BASE}\n\nYOUR FILES (edit only these): ${b.files.join(', ')}\n\nFIXES TO APPLY:\n${b.task}\n\nApply exactly these, verify with a grep of your own files, and return the structured summary.`,
    { label: `fix:${b.key}`, phase: 'Fix', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
