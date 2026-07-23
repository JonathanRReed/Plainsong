# Plainsong sidebar cleanup implementation plan

Design: `docs/superpowers/specs/2026-07-23-plainsong-sidebar-cleanup-design.md`

## Task 1: Add focused regression coverage

Files:

- Modify `nautilus-bot/src/__tests__/sidebar.test.tsx`

Steps:

1. Render the expanded sidebar with a known active destination.
2. Assert the active button exposes `aria-current="page"`.
3. Rerender with another active destination and assert the semantic current
   state moves.
4. Assert the navigation region no longer contains `.staff-bg`.
5. Run the focused test before implementation and confirm it fails for the
   expected missing semantic state and ruled background.

## Task 2: Simplify the sidebar surface

Files:

- Modify `nautilus-bot/src/components/sidebar.tsx`
- Modify `nautilus-bot/src/index.css`

Steps:

1. Remove `staff-bg` from the navigation `ScrollArea`.
2. Remove expanded navigation rows' two-pixel left border.
3. Use one uniform border, quiet tint, foreground text, and trailing neume for
   expanded active rows.
4. Preserve the compact icon rail's full-border gold selected state.
5. Apply `aria-current="page"` to active primary, secondary, Setup, and Exports
   destinations in both expanded and collapsed layouts.
6. Remove the unused `.staff-bg` CSS utility.
7. Re-run the focused sidebar test.

## Task 3: Keep the style guide aligned

Files:

- Modify `nautilus-bot/STYLE.md`

Steps:

1. Describe the sidebar as a clean neutral spine.
2. Reserve staff rules for bounded waveform or signature surfaces.
3. Preserve the gilt wordmark, rust rubrics, neumes, and state language.

## Task 4: Verify source behavior

Commands:

- `bun run test src/__tests__/sidebar.test.tsx`
- `bun run lint`
- `bun run test`
- `bun run build:renderer`
- `git diff --check`

Checks:

- No new dependency or generated source file.
- No navigation, collapse, shortcut, tooltip, theme, or status behavior changes.
- No `staff-bg`, `border-l-2`, or `border-l-gold` remains in `sidebar.tsx`.

## Task 5: Verify the real packaged application

Steps:

1. Rebuild the macOS package without publishing.
2. Launch the fresh packaged app.
3. Inspect expanded and collapsed sidebars in dark and light themes.
4. Verify every destination remains reachable.
5. Capture a fresh authentic screenshot showing the cleaned sidebar.
6. Re-run package size, updater metadata, component smoke, and trust evidence.

## Change control

- Use `apply_patch`.
- Use Bun for package commands.
- Add no dependency.
- Do not commit, push, tag, notarize, publish, deploy, or change repository
  visibility.
