# Plainsong sidebar cleanup design

Date: July 23, 2026

## Objective

Make the application sidebar feel like a calm desktop instrument instead of a
ruled notebook. Remove the repeating horizontal-line field while preserving the
small set of Plainsong motifs that communicate identity and state.

## Current problem

`Sidebar` applies the global `.staff-bg` utility to the entire navigation
scroll area. That utility draws a rule every 12 pixels with a repeating linear
gradient. The pattern runs behind labels, icons, shortcuts, selection states,
and expandable navigation. It adds visual noise without communicating
structure or state.

The active rows also combine a two-pixel gold left border, a tinted background,
and a gold neume. Those three signals compete with each other. The neume and
quiet selected-row tint already communicate the active destination.

## Approved direction

Use a clean, uninterrupted sidebar surface.

- Remove `.staff-bg` from the navigation scroll area.
- Remove the two-pixel active-item side stripe from expanded navigation rows.
- Keep a quiet selected-row background and the gold `neume-lit` state mark.
- Keep the gilt `P`, rust section labels, neutral icons, recording neume, local
  or cloud neume, and existing header and footer separators.
- Preserve the collapsed icon rail and its existing full-border selected state.
- Add `aria-current="page"` to the active navigation destination.
- Keep spacing, navigation order, shortcuts, behavior, and information
  architecture unchanged.

## Source changes

### `nautilus-bot/src/components/sidebar.tsx`

- Remove the `staff-bg` class from `ScrollArea`.
- Replace expanded-row `border-l-2` and `border-l-gold` styling with a uniform
  one-pixel border treatment.
- Keep the selected tint and trailing neume.
- Apply the same selected-row treatment to primary, secondary, and expanded
  More destinations.
- Mark the active destination with `aria-current="page"`.

### `nautilus-bot/src/index.css`

- Remove the now-unused `.staff-bg` repeating-gradient utility.
- Do not alter the separate main-surface treatment or waveform visuals.

### `nautilus-bot/STYLE.md`

- Clarify that the sidebar uses a plain neutral spine.
- Reserve staff rules for bounded signature or waveform surfaces, not the
  navigation background.

## Accessibility

- Existing button labels, tooltips, focus rings, and keyboard behavior remain.
- `aria-current="page"` provides a semantic active-state signal that does not
  depend on color or the neume.
- The active state remains visible in dark, light, and forced-color modes.

## Verification

- Update the dedicated sidebar test to assert `aria-current="page"` moves with
  the active destination.
- Run the focused sidebar test.
- Run TypeScript typecheck, lint, and the full renderer test suite.
- Rebuild the renderer and packaged application.
- Inspect expanded and collapsed sidebars in the real packaged app, including
  dark and light themes.

## Non-goals

- No navigation restructuring.
- No new components or dependencies.
- No changes to the main content background, waveform, transcript, or website.
- No new animation or decorative replacement for the removed rules.

## Acceptance criteria

1. No repeating horizontal rules appear behind sidebar navigation.
2. Expanded active rows have one calm selected treatment, not a side stripe
   plus multiple competing accents.
3. The gilt wordmark, rust labels, and neume state language remain.
4. Every active navigation destination exposes `aria-current="page"`.
5. Expanded and collapsed navigation remain functional and visually clear.
6. Focused tests, lint, typecheck, full tests, build, and packaged visual QA
   pass.
