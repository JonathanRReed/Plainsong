export const meta = {
  name: 'plainsong-style-audit',
  description: 'Adversarial STYLE.md-compliance audit across all surfaces; returns a prioritized defect list',
  phases: [
    { title: 'Audit', detail: 'cross-cutting lenses over the whole UI' },
    { title: 'Synthesize', detail: 'dedupe into one prioritized fix-list' },
  ],
}

const CONTEXT = `
Plainsong desktop app (Electron + React + shadcn, Tailwind v4). It was just restyled to the Plainsong manuscript brand. The contract is nautilus-bot/STYLE.md (READ IT FIRST). Quick recap:
- Two accents ONLY: gold + rust. No green/blue/teal/amber/indigo/violet/purple, no stoplight convention.
- Gold is EARNED and a hierarchy: at most ONE burnished/earned gold moment per surface (the primary CTA or the live "set down"/recording state). Most gold is quiet bronze (--gold-ambient). text-gold-text for gold TEXT (AA on light vellum); text-gold/bg-gold/border-gold for fills/icons/rings; rust for rubric labels / "not yet" / errors / mode+template SELECTORS.
- Fonts: Newsreader serif (headings/wordmark/manuscript+transcript text/versals), IBM Plex Mono (rubrics/eyebrows/metadata/specs/keycaps/timestamps), IBM Plex Sans (body). Rubric = .rubric/.rubric-muted (mono UPPERCASE). Neumes = state glyphs (.neume / .neume-lit / .neume-hollow / .neume-rust). Headers: rust .rubric eyebrow -> serif title -> muted copy.
- Motion: marks settle (--ease-settle), compositor-only, reduced-motion first-class, no always-on motion on trust/failure surfaces. forced-colors fallbacks for gilt/neume/staff/canvas.
- a11y: AA contrast, gold focus rings, accessible labels, real letters in versals.
You are reviewing the CURRENT on-disk source under nautilus-bot/src (read it; it has already been restyled). Find what still falls short of the contract. Do NOT edit files — REPORT precise defects.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['defects'],
  properties: {
    defects: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'line', 'issue', 'fix', 'severity'],
      properties: {
        file: { type: 'string', description: 'path relative to nautilus-bot/' },
        line: { type: 'string', description: 'line number or range' },
        issue: { type: 'string', description: 'what violates the contract / hurts elegance' },
        fix: { type: 'string', description: 'concrete, minimal fix (exact class/token/pattern)' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      } } },
    summary: { type: 'string', description: 'overall read of this lens — is the surface largely compliant?' },
  },
}

const lenses = [
  { key: 'gold-restraint', focus: `GOLD HIERARCHY / RESTRAINT. Read every view, popup, overlay, and the sidebar. Find any surface with MORE THAN ONE earned/burnished gold moment, competing always-on golds, rows where multiple peers each carry gold (should be only the active/primary one), or gold used on neutral chrome. Also flag any decorative always-on gold animation. For each: which single element should stay gold and which to demote to muted/rust.` },
  { key: 'type-rubric', focus: `TYPOGRAPHY & RUBRIC CONSISTENCY. Check every view/section header follows: rust .rubric eyebrow -> Newsreader (font-serif) title -> muted body. Flag headers missing the eyebrow, titles NOT in font-serif, metadata/timestamps/specs/keycaps NOT in mono, body using serif where it should be sans (or vice-versa), inconsistent rubric casing/tracking, and transcript text not set as .manuscript serif. Flag .quiet-label legacy shim still in use (should be .rubric-muted).` },
  { key: 'color-purity', focus: `COLOR PURITY & CONTRAST. Grep/read for ANY forbidden hue in ANY form: tailwind hue classes (emerald/amber/green/blue/teal/sky/cyan/indigo/violet/purple/fuchsia/yellow/orange/rose/lime/pink), hex literals, rgb/rgba/hsl literals, and inline style colors — in tsx/ts AND any canvas drawing code. Also flag gold-as-TEXT using text-gold instead of text-gold-text on any surface that can render on light vellum (icons may use text-gold). Flag rust-on-rust or gold-on-gold combos below AA.` },
  { key: 'layout-intuitive', focus: `LAYOUT, RHYTHM & INTUITIVENESS. Flag nested-card overload (card-in-card-in-card / 3+), inconsistent spacing/padding rhythm, cramped or overly-sparse regions, unclear primary action (no obvious single CTA, or several competing), secondary actions that are too loud, empty/loading/error states that are loud blocks instead of calm manuscript moments (neume + serif line + muted guidance), and anything that gets in the user's way (modal-happy, hidden affordances, dense unscannable settings without rust section rubrics).` },
  { key: 'motion-a11y', focus: `MOTION & ACCESSIBILITY. Flag always-on animation on trust/failure/status surfaces, JS/canvas animations without a prefers-reduced-motion guard, missing forced-colors fallbacks for gilt/neume/staff/canvas strokes, transitions that animate layout/filter instead of transform/opacity, missing focus-visible gold rings on interactive elements, icon buttons without accessible labels, and versals/drop-caps that hide the real letter from AT.` },
]

phase('Audit')
const audits = await parallel(lenses.map((l) => () =>
  agent(
    `${CONTEXT}\n\nYOUR LENS: ${l.focus}\n\nRead broadly across nautilus-bot/src/components (views, popups, overlay, ui primitives, sidebar) and src/index.css. Report every concrete defect with a real file path, line ref, the precise issue, and a minimal concrete fix. Be adversarial but precise — only report real contract violations or clear elegance defects, not preferences. Return ONLY the structured object.`,
    { label: `audit:${l.key}`, phase: 'Audit', schema: SCHEMA, agentType: 'Explore' }
  ).then((r) => ({ lens: l.key, ...r }))
))

const ok = audits.filter(Boolean)
phase('Synthesize')
const blob = ok.map((a) => `### LENS ${a.lens} — ${a.summary || ''}\n${JSON.stringify(a.defects || [], null, 1)}`).join('\n\n')
const synth = await agent(
  `You are the design-system lead. Consolidate these STYLE.md-audit findings into ONE prioritized, de-duplicated fix-list for the Plainsong app. Drop duplicates and non-issues; merge overlapping reports. Group by severity (high -> medium -> low). For each: file, line, the issue in one line, and the exact minimal fix. End with a one-paragraph verdict: is the UI now substantially polished and brand-compliant, and what (if anything) is genuinely worth fixing before calling it done?\n\nFINDINGS:\n${blob}`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' }
)

return { perLens: ok, fixList: synth }
