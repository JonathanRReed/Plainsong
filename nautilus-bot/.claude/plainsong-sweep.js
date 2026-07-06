export const meta = {
  name: 'plainsong-restyle-sweep',
  description: 'Apply the Plainsong brand state-law across all UI call sites (disjoint files per agent)',
  phases: [
    { title: 'Sweep', detail: 'one editor agent per disjoint file bucket' },
  ],
}

const LAW = `
PLAINSONG BRAND STATE-LAW (the foundation is DONE — tokens/fonts/motifs already ship in src/index.css and STYLE.md).
You are RE-POINTING forbidden colors to the brand. Two accents only: GOLD and RUST. No green/blue/teal/emerald/amber/indigo/violet/purple, ever. The stoplight convention is forbidden.

CLASSIFY each site by MEANING, not by its old hue:
  • set-down / local / ready / enabled / on / the live recording-active moment  -> GOLD
  • rubric label / section eyebrow / "not yet" / needs-setup / error / destructive / warning / missing / mode+template SELECTOR controls -> RUST
  • neutral chrome (folder, search, generic icons, secondary text) -> NEUTRAL

BRAND UTILITIES (already defined, just use them):
  GOLD text -> text-gold-text   (ALWAYS use text-gold-text for gold TEXT — AA-safe on light; equals bright gold on dark)
  GOLD fill/border/ring/glyph -> bg-gold/10  border-gold/30  ring-gold  text-gold (icons only)  bg-primary (the ONE earned CTA)  neume-lit
  RUST -> text-rust  bg-rust/10  border-rust/30  neume-hollow  (destructive shadcn token is already rust)
  NEUTRAL -> text-muted-foreground  bg-muted/20
  Rubric eyebrow/section label -> the .rubric (rust) or .rubric-muted (neutral) utility (mono UPPERCASE)
  Neume state glyph -> <span class="neume neume-lit" /> (on/local) or "neume neume-hollow" (off/cloud) or "neume-rust"

RULES (keep it surgical & TypeScript-clean):
  1. Prefer the LEAST invasive change: swap the hue class to a brand class. Keep all logic, props, structure, and imports intact.
  2. Use neume glyphs ONLY to replace a plain colored status DOT (e.g. a <div class="... bg-success rounded-full"/>). RECOLOR lucide icons (CheckCircle/XCircle/AlertCircle...) to text-gold-text / text-rust — do NOT delete icon imports or swap icons for neumes (that breaks imports / TS / knip).
  3. Gold is EARNED: bg-primary / neume-lit / gold-leaf only for the live recording-active moment and the single primary CTA on a surface. Mode/template/capture SELECTOR toggles are RUBRIC controls -> RUST (border-rust/40 bg-rust/8 text-rust when selected), NOT gold.
  4. For gold TEXT always use text-gold-text. For fills/borders/icons/rings use the gold/bg-gold/border-gold/ring-gold forms.
  5. Do NOT touch the legacy semantic aliases in index.css (trusted/active/success/warning/info) — they get deleted later. But where a site uses bg-active/text-active/etc. and the MEANING is a rubric selector, change it to explicit RUST; where the meaning is the earned recording moment, change it to explicit GOLD (text-gold-text/bg-primary). Replace success/warning/info/trusted/active CLASSES with explicit gold/rust/neutral so the aliases can be removed.
  6. Don't reflow or reformat unrelated code. Only change colors/fonts/glyphs.

Return a concise structured summary of what you changed.
`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['path', 'editCount', 'changes'],
      properties: {
        path: { type: 'string' },
        editCount: { type: 'number' },
        changes: { type: 'array', items: { type: 'string' }, description: 'short bullet per change' },
        leftovers: { type: 'string', description: 'any forbidden color you could NOT resolve, or empty' },
      } } },
  },
}

const buckets = [
  { key: 'shell', files: ['src/components/sidebar.tsx','src/App.tsx','src/components/ui/page-header.tsx'], kill: `
sidebar.tsx: 363,364 bg-red-500 recording pulse -> bg-rust (x2). 390 local-mode dot bg-success/bg-warning -> replace the plain dot with a neume: active -> <span class="neume neume-lit"/> , inactive -> <span class="neume neume-hollow"/>. Section labels using .quiet-label (~188,234) -> .rubric. Wordmark "Plainsong" (~159) -> font-serif; optionally gild just the leading "P" with .gilt-text (keep the real letter in the DOM). Active nav item: the selected nav Button currently uses primary tints — keep a quiet gold mark (border-gold/30 bg-gold/10 text-foreground) instead of violet/primary pill.
App.tsx: line 88 text-destructive heading is fine (rust). line 94 error "Try Again" button bg-primary text-primary-foreground -> demote (a generic retry is not an earned gold CTA): bg-secondary text-secondary-foreground hover:bg-muted.
page-header.tsx: title -> font-serif (Newsreader); any eyebrow/overline/breadcrumb -> .rubric-muted (or .rubric if it's an incipit label).` },

  { key: 'prims', files: ['src/components/ui/badge.tsx','src/components/ui/input.tsx','src/components/ui/button.tsx','src/components/ui/switch.tsx','src/components/ui/tabs.tsx','src/components/ui/animated-gradient-text.tsx','src/components/toast.tsx'], kill: `
badge.tsx (~15,22-27): variant internals success -> bg-gold/12 text-gold-text border-gold/25 ; warning -> bg-rust/12 text-rust border-rust/25 ; info -> bg-muted/30 text-muted-foreground ; destructive -> rust. KEEP the variant NAMES.
input.tsx (~39,40,64,65): success state -> gold (border-gold focus-visible:ring-gold) ; destructive/error -> rust. Focus ring -> gold (ring-ring is already gold).
button.tsx: no hex; verify default=bg-primary (earned gilt), destructive=rust. Add a one-line JSDoc above buttonVariants: "default = the earned gilt CTA; one per surface." No other change.
switch.tsx (~45): checked state -> gold (data-[state=checked]:bg-primary). tabs.tsx (~29): active tab -> keep neutral, optionally a gold underline/mark (border-b-2 border-gold or text-foreground); no forbidden hue.
animated-gradient-text.tsx (~16,17): default colorFrom="#ffaa40" -> "var(--brand-warm)" ; colorTo="#9c40ff" (violet) -> "var(--brand-warm-strong)" (keep it a gold->gold leaf shimmer, not violet). Add JSDoc: "earned/versal use only."
toast.tsx (~97-110): success emerald hex -> gold (text-gold-text, border-l-gold, bg-gold/10) ; error -> rust (text-rust, border-l-rust, bg-rust/10) ; info -> neutral muted or gold. Replace any emerald/red hex with brand classes.` },

  { key: 'sig-canvas', files: ['src/components/waveform-visualizer.tsx','src/components/ui/audio-waveform.tsx'], kill: `
waveform-visualizer.tsx: lines 16-17 and 26-27 resolveCanvasHsl hardcodes "#f97316"(active) and "#3b82f6"(trusted) and a fallback. Canvas can't use CSS classes — instead read brand colors at draw time from getComputedStyle(document.documentElement).getPropertyValue('--brand-warm') (gold, for the active/live stroke) and '--gold-ambient' (bronze, for the secondary/trusted stroke), with the ink/foreground as fallback. So strokes track light/dark + theme. The LIVE badge (~174-175) uses bg-active/text-active which already maps to gold — leave or make explicit text-gold-text/bg-gold/10. Add guards: if matchMedia('(prefers-reduced-motion: reduce)').matches, render a static bar set (no animation loop). If matchMedia('(forced-colors: active)').matches, stroke with 'CanvasText'.
audio-waveform.tsx: replace any hardcoded rgba/hex stroke or glow colors (emerald/blue) with gold derived from --brand-warm (read via getComputedStyle) or a gold rgba like 'rgba(200,149,67,0.5)'. Add the same reduced-motion / forced-colors guards if it animates. If it already only takes a glowColor prop, ensure its default is gold, not emerald/blue.` },

  { key: 'sig-overlay', files: ['src/components/recording-overlay.tsx','src/components/popups/dictation-popup.tsx','src/components/popups/recording-popup.tsx'], kill: `
recording-overlay.tsx: 86,108 capture-mode toggles "border-active bg-active/10" and 140 template selector -> these are RUBRIC SELECTORS -> RUST: when selected use border-rust/40 bg-rust/8 text-rust (unselected stays neutral border-border). 174-176 consent block emerald (emerald-500/20, emerald-500/5, text-emerald-600) -> gold: bg-gold/8 border-gold/20 + recolor the consent CheckCircle to text-gold-text (or a neume-lit if it's a plain dot). 231 "Start Meeting" CTA bg-active -> bg-primary (the earned gold CTA).
dictation-popup.tsx: 54-88 MODE_META gives each mode a different rainbow accent (cyan/emerald/amber/violet/fuchsia) -> make them UNIFORM rust rubric: text-rust border-rust/30 bg-rust/5 (these are mode selectors). 1036 bg-emerald-500/15 -> bg-gold/12 ; 1038 text-emerald-400 -> text-gold-text ; 1055 text-emerald-400 -> text-gold-text (recording phase = earned gold).
recording-popup.tsx: 523 success badge -> this is ambient status, use rust (variant/classes -> rust) OR neutral; not earned gold. 533 AnimatedGradientText colorFrom="#34d399" colorTo="#10b981" -> gold pair var(--brand-warm) -> var(--brand-warm-strong). ~577 AudioWaveform glowColor rgba(52,211,153,..)/rgba(147,197,253,..) (emerald/blue) -> gold rgba 'rgba(200,149,67,0.45)'.` },

  { key: 'dictation', files: ['src/components/views/dictation-view.tsx'], kill: `
dictation-view.tsx (largest offender, 31 sites).
Hardcoded hues: 3595 text-amber-500 -> text-rust. 4015,4039 emerald -> gold (text-gold-text / bg-gold/10). 4140-4141 emerald done-state + CheckCircle2 -> gold (recolor icon text-gold-text; if it's a plain dot use neume-lit). 4755 amber -> rust ; 4756 orange -> rust. 4778 emerald -> gold ; 4780 amber -> rust ; 4782 orange -> rust. 6773 amber banner -> rust (bg-rust/10 border-rust/30 text-rust).
Semantic *-active (20): mode/template SELECTOR toggles at ~3247, 3319-3326, 3355-3362, 3456, 3483 (bg-active/text-active-foreground/border-active) -> RUBRIC selectors -> RUST (selected: border-rust/40 bg-rust/8 text-rust). Recording-ACTIVE ring/icon at ~3958, 4013, 4037, 4086-4089, 4188, 4197, 4206, 4214 (border-active/text-active) -> the earned recording moment -> GOLD (text-gold-text / border-gold/40 / bg-gold/10). Decide each by whether it marks "you are recording now" (gold) vs "pick a mode" (rust).` },

  { key: 'settings', files: ['src/components/views/settings-view-simple.tsx'], kill: `
settings-view-simple.tsx (35 hardcoded + 2 semantic). Apply ready/enabled -> gold, warning/blocker/error -> rust, neutral chrome -> muted.
Sites: 1313-1314 readiness chip emerald/amber -> gold/rust. 2044-2047 bg-red-500/bg-yellow-500/bg-emerald-500 status dots -> rust/rust/gold (or neume glyphs if plain dots). 2192 text-green-500/text-amber-500 -> gold/rust. 2296,2302 amber -> rust. 3149,3155 emerald ready -> gold. 3275-3336 emerald ready badges -> gold. 3506,3695,3784,4388,5232 amber SECTION LABELS -> use .rubric (rust mono). 4870,4884-4885,4902,4904,4965 emerald/amber pass-fail -> gold/rust (recolor icons text-gold-text/text-rust). 5041-5157 amber alert containers -> rust (bg-rust/10 border-rust/30 text-rust). 5272 text-blue-600 -> text-muted-foreground. Semantic: ~261 Badge success/warning -> gold/rust ; 306,343 text-success -> text-gold-text.
ALSO: the color-scheme picker section (search for THEME_SCHEMES / normalizeThemeScheme / "colorScheme", around 3560-3600) now lists only one option ("Plainsong"). Remove that now-redundant scheme picker block (keep the light/dark/system theme control intact). Leave the colorScheme persistence plumbing alone; just remove the dead single-option radio UI and its surrounding label/description.` },

  { key: 'asr', files: ['src/components/asr-provider-manager.tsx','src/components/asr-route-combobox.tsx'], kill: `
asr-provider-manager.tsx (23 hardcoded + 4 semantic): 800,1506,1595,1701 bg-green-600 "ready/installed" -> bg-gold (or neume-lit dot). 944,1672,2039,2046,2054 text-amber -> text-rust. 1523-1568 and 2034-2046 amber WARNING banners -> rust (bg-rust/10 border-rust/30 text-rust). border-trusted (1230) -> border-gold/30. border-trusted ring-trusted (1774) -> border-gold/40 ring-gold. Any remaining *-active -> classify (selected route highlight = gold border-gold/40 bg-gold/10).
asr-route-combobox.tsx: verify badges/states use brand tokens; recolor any green/amber/blue to gold(ready)/rust(warn)/neutral. The selected route -> gold accent.` },

  { key: 'setup', files: ['src/components/views/setup-view.tsx','src/components/first-run-wizard.tsx'], kill: `
setup-view.tsx (19): 48-49 statusTone map (emerald "ready" / amber "not-ready") -> gold / rust. 59 emerald Ready badge -> gold. 70,81 amber -> rust. 230 amber error banner -> rust. 298,462 amber blockers -> rust. 712,714,716,730,732,734 emerald/amber recovery cards -> gold/rust (recolor icons text-gold-text/text-rust; plain dots -> neume).
first-run-wizard.tsx (13): 765-766 amber DMG warning -> rust. 882 emerald CheckCircle -> text-gold-text. 885 amber XCircle -> text-rust. 961 emerald success -> gold. 1164 emerald -> gold. 1166,1169 amber -> rust. 1196 emerald -> gold. 1200 amber -> rust. 1208 emerald Monitor icon -> text-gold-text. 1210 amber AlertCircle -> text-rust. (The wizard already renders well in gold; just kill the green/amber.)` },

  { key: 'recordings', files: ['src/components/views/recordings-view.tsx'], kill: `
recordings-view.tsx (9 hardcoded + ~20 semantic): 498 emerald good -> gold. 500 amber warn -> rust. 2328,2332 amber diarization card + label -> rust (label via .rubric). 2486 emerald ready -> gold. 3288 amber -> rust. 3927 amber block -> rust. 3957 text-green-700 -> text-gold-text. 4077 amber -> rust. For the ~20 semantic (*-success/-warning/-active/-trusted) tokens: audit each — ready/done/local -> gold (text-gold-text/bg-gold/10), warn/missing/processing-error -> rust, generic selected-row highlight -> gold border. Replace the semantic classes with explicit gold/rust so aliases can be removed.` },

  { key: 'smallviews', files: ['src/components/views/dashboard-view.tsx','src/components/views/projects-view.tsx','src/components/views/exports-view.tsx'], kill: `
dashboard-view.tsx (4 hardcoded + 2 semantic): 551-552 bg-blue-500/10 text-blue-500 (Search icon chip) -> NEUTRAL bg-muted/20 text-muted-foreground. 635 border-l-blue-500/40 -> border-l-gold/40 (or border-l-border if not a highlight). 714-715 bg-blue-500/10 text-blue-500 (Folder chip) -> neutral. ~261 Badge success/warning -> gold/rust. 306,343 text-success -> text-gold-text.
projects-view.tsx (1): 98-100 folder chip bg-primary/10 text-primary -> NEUTRAL bg-muted/20 text-muted-foreground (a folder is neutral chrome, not an earned gold moment).
exports-view.tsx (2): 297-299 emerald-500 + text-emerald-500 + CheckCircle2 "done" -> gold (bg-gold/10, recolor CheckCircle2 to text-gold-text; or neume-lit if a plain dot).` },

  { key: 'content', files: ['src/components/transcript-viewer.tsx','src/components/ai-analysis-panel.tsx','src/components/update/UpdateStatusWidget.tsx','src/components/update/BetaChannelToggle.tsx'], kill: `
transcript-viewer.tsx: the transcript body text should read as inked manuscript — add the .manuscript class (Newsreader) to the transcript text container/words (keep timestamps/labels in mono). 81 bg-trusted/10 text-trusted speaker badge -> active speaker gold (bg-gold/10 text-gold-text), others neutral. 227 border-active textarea focus -> gold (border-gold focus-visible:ring-gold). 255 current/low-confidence word bg-yellow-200/50 dark:bg-yellow-900/30 -> a dotted-GOLD underline (text stays ink): e.g. underline decoration-dotted decoration-gold underline-offset-2 (NOT a yellow highlight, NOT red).
ai-analysis-panel.tsx: 518,609 text-trusted -> text-gold-text. 539 bg-amber-500/10 text-amber-700 -> rust (bg-rust/10 text-rust) and if it's a label use .rubric.
update/UpdateStatusWidget.tsx: 51 bg-blue-100 text-blue-800 (update available) -> gold (bg-gold/10 text-gold-text). 92 bg-red-50 text-red-800 (error) -> rust (bg-rust/10 text-rust).
update/BetaChannelToggle.tsx: 44 text-amber-600 -> text-rust.` },
]

phase('Sweep')
const results = await parallel(buckets.map((b) => () =>
  agent(
    `${LAW}\n\nYOUR FILES (edit these in place, no others): ${b.files.join(', ')}\n\nYOUR KILL-LIST (line numbers are approximate — read each file and find the real sites; do not miss any forbidden color in these files):\n${b.kill}\n\nRead each file, apply every change, and ALSO grep your own files for any remaining forbidden hue (emerald|amber|green|blue|teal|sky|cyan|indigo|violet|purple|fuchsia|yellow|orange|rose|#hex) and fix those too. Then return the structured summary.`,
    { label: `sweep:${b.key}`, phase: 'Sweep', schema: SCHEMA, effort: 'high' }
  ).then((r) => ({ bucket: b.key, ...r }))
))

return { results: results.filter(Boolean) }
