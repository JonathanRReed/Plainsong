# Plainsong — App Style Guide

*The brand bible, translated for the product. The marketing codex (the website) is a manuscript you read leaf by leaf; the **app** is the scriptorium's desk — where the work is actually set down. This file is the source of truth for how the desktop app looks. It distills [the Plainsong Brand & Style Guide] into a **product register**: a calm, candle-lit control room for dictation and meetings that is unmistakably Plainsong, but stays usable for long daily sessions.*

> The two ideas always travel together: **the manuscript** (warmth, ink, one thread of gold) and **the honesty** (local-first, plain text, nothing hidden). If a design decision serves one and betrays the other, it is wrong.

Companion docs: [DESIGN.md](DESIGN.md) governs register, interaction, state-design, and release discipline — all still in force. **This file governs everything visual** (color, type, motif, motion). Where they overlapped, this file wins on looks.

---

## 0. The one rule that prevents 90% of mistakes

**There are exactly two accent colors: gold and rust. No green, blue, teal, emerald, amber, indigo, violet, or purple — ever.** The stoplight convention (green = good, red = bad, amber = warn) is *forbidden*; the codex rejects it. State is carried by **gold vs rust vs neutral** and by **neume glyphs**, not by hue temperature.

| Meaning | Use |
|---|---|
| set down · local · ready · enabled · on · the live recording moment | **gold** (`text-gold-text` / `bg-gold/10` / `neume-lit` / `bg-primary` for the earned CTA) |
| rubric label · "not yet" · needs-setup · error · destructive · warning · missing | **rust** (`text-rust` / `bg-rust/10` / `neume-hollow` / `border-rust/30`) |
| neutral chrome (folders, search, generic icons, secondary text) | **neutral** (`text-muted-foreground` / `bg-muted/20`) |

Gold is a **hierarchy, not a flood.** Most gold is the quiet bronze `--gold-ambient`. Full burnished `--gold-leaf` is reserved for the **few earned marks**: the active recording/dictation "setting down" moment, the versal "P", and the single primary CTA on a surface. If everything is gilded, nothing is.

---

## 1. Color (tokens live in [src/index.css](src/index.css))

One coherent OKLCH system. **Dark (the candle-lit folio) is the default; light is vellum.** Both ship; there are no other themes.

### Brand tokens
| Token | Role |
|---|---|
| `--background` / `--foreground` | vellum/ink ground · body ink |
| `--card` / `--popover` | raised leaf surfaces |
| `--muted` / `--muted-foreground` | quiet surface · secondary & mono-label text |
| `--border` / `--paper-rule` | hairlines & chant-staff rules |
| `--primary` / `--primary-foreground` | the gilded button (gold fill, ink text) |
| `--brand-warm` | **the gold accent** (decorative — fills, borders, glyphs) |
| `--brand-warm-strong` | deeper gold / hover |
| `--brand-warm-text` | **gold for TEXT** — AA-safe on light vellum (~5.6:1) |
| `--brand-rust` / `--destructive` | the **rubric** — incipits, numerals, "not yet", errors |
| `--gold-ambient` | quieted bronze for *secondary* gold (staff rules, baseline neumes) |
| `--gold-leaf` | 7-stop gradient with a hard value-break — reflective leaf, for gilded glyphs via `background-clip:text` |
| `--bole` | bronze under-edge so gilt sits *on* the vellum |
| `--ring` | gold focus ring |

### Tailwind utilities exposed
`bg-gold` `text-gold` `border-gold` · `text-gold-text` (AA text) · `text-gold-strong` · `bg-gold-ambient` · `text-rust` `bg-rust` `border-rust` · `bg-paper-rule`. Opacity works (`bg-gold/10`, `border-rust/30`). Standard shadcn tokens (`bg-primary`, `text-destructive`, `bg-card`, …) all resolve onto this palette.

### The two gold rules that matter most
1. **Text gold = `text-gold-text`; decorative gold = `text-gold`/`bg-gold`.** `--brand-warm` (70% L) fails WCAG AA as body text on light vellum; `--brand-warm-text` (48% L) clears it. On dark both are the bright gold. **Never set gold as TEXT on a light surface with `text-gold` — use `text-gold-text`.** Gold as fill/border/glyph/ring is fine.
2. **Burnished gold is earned.** Moving/full-chroma `--gold-leaf` is only for: the active "setting down" moment, the versal-P, the primary CTA. Everything else uses the quieter `--gold-ambient`.

### Legacy semantic aliases (being retired)
`trusted/active/success/warning/info` are temporarily bridged onto gold/rust in `@theme inline`. **Do not introduce new uses.** They map: `active/success/trusted → gold`, `warning → rust`, `info → bronze`. They are a migration shim and get deleted once every call site is re-pointed to an explicit `gold`/`rust`/`muted` utility.

---

## 2. Typography (three self-hosted faces — offline-first, no CDN)

| Face | Var / class | Use |
|---|---|---|
| **Newsreader** (display serif) | `--font-headline` / `font-serif` | headings (`h1–h4` already), the wordmark, the inked/manuscript & transcript text, drop-caps/versals. The *voice* of the manuscript. |
| **IBM Plex Mono** | `--font-mono` / `font-mono` | rubrics, eyebrows, metadata, specs, keycaps/shortcuts, timestamps, status/network readouts, code-like chrome. The *apparatus* — precise, honest. |
| **IBM Plex Sans** | `--font-sans` / `font-sans` (default body) | quiet running body & long prose where neither display nor mono fits. |

**Rubric convention** — eyebrows & section labels are mono, UPPERCASE, wide tracking (~0.14–0.18em), usually rust. Use the `.rubric` (rust) / `.rubric-muted` (neutral) utilities. (`.quiet-label` is the legacy shim — migrate to `.rubric-muted`.)

**Rubric budget: one rust `.rubric` eyebrow per page.** It belongs to the page header (`ui/page-header.tsx`) only. A card or section inside that page does **not** get its own eyebrow restating what its heading/icon already say — that reads as a wall of alarmed telegrams, not hierarchy. Use `.section-heading` (below) or nothing instead. `.rubric-muted` (bronze, not rust) is still fine as a genuine secondary label — e.g. a compact status line in a sidebar rail — because it isn't competing with the page's one rust rubric for attention.

**Section heading** — the default label for a card/section inside a view: sentence case, `font-sans font-semibold`, no tracking, no uppercase (`.section-heading` utility). Reach for a `.rubric`-style eyebrow only at the true page level; everywhere else, a plain bold sentence-case label plus a one-line muted description does the job without shouting.

**Type-scale floor** — `text-xs` (12px) is for keycaps, timestamps, and true metadata only. Control labels, descriptions, and body copy inside a card use `text-sm` (14px) minimum; that includes the small print under a toggle or the caption line in a status chip. If you're tempted to reach for `text-xs` for anything a user reads as a sentence, use `text-sm`.

**Versals/drop-caps** — a Newsreader letter gilded via `.gilt-text`. It is the **real first letter of real text** — never `aria-hidden`, never content-replacement — so screen readers still read the whole word.

Radius is `0.375rem` (`--radius`). Small and restrained — this is paper, not a SaaS card.

**Surface law (flatten one level)** — a page is header → flat sections separated by whitespace and a hairline, not card-in-card. Before nesting a bordered box inside another bordered box, ask whether the inner box could be a plain row or a `border-t pt-4` group instead. Reserve real `<Card>` chrome for choice tiles (profile/mode pickers), list rows, and the one earned signature surface per view — not for every subsection of a settings page. **Never render the same title+description pair twice on one screen** (a section's own heading is enough; don't repeat it in a hero card above it) — this was a real, found-in-production bug (a triple-duplicated Settings header), not a hypothetical.

**Two or more selector grids on one view need their own headings.** If a view offers more than one "pick one of these" grid (e.g. quick style presets vs. deeper saved modes), each needs a distinct sentence-case heading and a one-line description explaining how it differs from the other — never stack two unlabeled grids back-to-back. A user seeing two tiles both called "General" and both marked "Active" with no heading between them cannot tell whether that's one system or two.

---

## 3. Motifs & the mark (utilities in [src/index.css](src/index.css))

A small, disciplined vocabulary. Use these names — they are the brand lexicon.

- **The versal "P"** — the gilded illuminated capital; the canonical mark (tab icon, masthead, OG). In-app: the sidebar wordmark's "P" may be gilded with `.gilt-text`.
- **Neumes** — gold diamonds (a rotated square). They are *notation* and the app's **state glyphs**. Utilities: `.neume` (ambient bronze), `.neume-lit` (filled `--gold-leaf` = set down / local / on), `.neume-hollow` (outline = optional / not-yet / cloud), `.neume-rust` (rust). **Replace stoplight dots and pass/fail check/cross icon pairs with neumes** where a small state glyph is wanted.
- **The chant staff** — four faint gold rules. `.staff-bg` backs the sidebar spine and the waveform; the live waveform sweeps it and resolves into gold neumes (`voice → notation → written record`).
- **Rubrication** — rust opening labels & numerals (`.rubric`).
- **Gilt as a material** — `.gilt-text` (gold-leaf clipped to text + bole under-edge), `.gilt-edge` (seated gold ring/halo). Reserve for earned marks.
- **Manuscript text** — `.manuscript` sets words in the display serif like inked text (transcripts, the "set down" line).

App-only vs website-only: the app uses **neume, rubric, staff, gilt, versal, manuscript**. The *codex leaves / folios / catchwords / Scriptorium hero / manifesto* are website-only — do **not** import them into the product chrome.

---

## 4. Motion law

> Nothing "animates." Marks **settle**. The page **breathes**. Ink **dries**.

- Brand spring: `--ease-settle` = `cubic-bezier(0.2, 0.8, 0.2, 1)`. Use for reveals/settles (`.settle-in`, `.transition-smooth`).
- **Compositor-only** — animate `transform`/`opacity` only. Never animate `filter` or layout on scroll. Modest, functional, 150–300ms.
- **Reduced-motion is first-class.** The CSS block neutralizes transitions/animations; **JS-driven motion (the canvas waveform) must also check `matchMedia('(prefers-reduced-motion: reduce)')`** and fall to a static state.
- Don't put decorative motion on trust/failure surfaces where the user is evaluating state.

---

## 5. Component conventions

- **Button** (`ui/button.tsx`) — `default` = the gilded gold CTA (`bg-primary`, ink text) — *one earned CTA per surface*. `destructive` = rust. `outline`/`secondary`/`ghost` = neutral. `active` = gold-tinted selected state.
- **Badge** (`ui/badge.tsx`) — keep variant names; the `success`→gold, `warning`→rust, `info`→neutral internals are fixed once centrally. Prefer a leading neume for state.
- **Sidebar** (`sidebar.tsx`) — the **spine**: optional faint `.staff-bg`, section labels as `.rubric`, the active item carries a gold mark/neume (not a violet pill). Recording chip = rust pulse. Local/cloud status = `neume-lit` (local) / `neume-hollow` (cloud).
- **Page header** (`ui/page-header.tsx`) — Newsreader title; a mono UPPERCASE rust eyebrow (`.rubric`) above it.
- **Signature surfaces** (`dictation-view`, `recording-overlay`, `*-popup`, `waveform-visualizer`) — the earned gilt moments. The **active recording/dictation state** is where burnished gold belongs. But **mode/template/capture SELECTORS are rubric controls → rust**, not gold (gold there would cheapen the earned moment). Consent/ready ticks → gold + `neume-lit`.
- **Transcript** (`transcript-viewer.tsx`) — set in `.manuscript` (Newsreader); low-confidence words keep a **dotted-gold** underline (never red); active speaker → gold, others neutral.
- **Canvas** (`waveform-visualizer.tsx`, `audio-waveform.tsx`) — read `--brand-warm` / `--gold-ambient` off `getComputedStyle(documentElement)` so strokes track light/dark; provide a `forced-colors` → `CanvasText` fallback.

---

## 6. Accessibility & honesty (ship with the brand)

- Keyboard-first; real roles; visible **gold** focus rings; accessible labels on icon buttons; never hide the OS cursor over a control.
- Versals keep the real letter in the DOM (AT reads the word).
- **Forced-colors**: gold/gilt/neume/staff drop to system colors (handled in CSS; mirror it for canvas).
- **Contrast**: all gold-on-vellum *text* clears AA — use `text-gold-text` on light. Rust passes as text on vellum; verify `text-rust` on `bg-rust/10` stays ≥4.5:1.
- **Honesty contract (from the brand):** local by default, cloud opt-in & named; no absolute privacy claims ("100% offline"); say plainly what the app does *not* do; UI copy describes what the app actually does. Status surfaces show state, cause, and next action.

---

## 7. Do / Don't

**Do** — lead with one true thing · one gold accent + one rust rubric per page · reserve burnished gold for the earned moment · plain scribe voice · neumes/rubrics for state · give one idea room per view · `text-gold-text` for gold text on light · `text-sm` as the body/label floor · flatten nested cards to one level · head every selector grid so two "General, Active" tiles never sit unexplained back-to-back.

**Don't** — add a green/blue/amber status hue · use the stoplight convention · flood the page with gold · give every card its own rust eyebrow · `text-xs` for anything read as a sentence · `text-gold` as text on a light surface · `aria-hidden` a real versal letter · animate a filter on scroll · ship a near-duplicate of a window/section that already exists (check for a repeated title+description before you're done, not after a user reports it) · introduce new `success/warning/info` semantic-class uses.

---

*Plainsong is written in the open by one hand. The trust here is not a badge but a signature. Keep it that way.*

[the Plainsong Brand & Style Guide]: # "Full brand bible lives with the marketing codex; this app guide is its faithful product translation."
