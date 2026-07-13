import type { MainViewId } from "@/lib/navigation";
import { isMacPlatform } from "@/lib/shortcuts";

/**
 * Single source of truth for the in-app view-navigation shortcuts shown in the
 * sidebar, the command palette, and handled in App.tsx.
 *
 * Home and Meetings require Shift because plain Cmd+H / Cmd+M are consumed by
 * the OS-level Hide / Minimize accelerators (macOS app menu, Windows window
 * menu) before the renderer ever sees them.
 */
interface NavShortcutSpec {
  view: MainViewId;
  /** KeyboardEvent.key, lowercase. */
  key: string;
  shift: boolean;
}

const NAV_SHORTCUTS: NavShortcutSpec[] = [
  { view: "dashboard", key: "h", shift: true },
  { view: "dictation", key: "d", shift: false },
  { view: "recordings", key: "m", shift: true },
  { view: "projects", key: "p", shift: false },
  { view: "settings", key: ",", shift: false },
];

/** Individual keycap labels for a view's shortcut, e.g. ["⌘", "⇧", "H"] or ["Ctrl", "Shift", "H"]. */
export function navShortcutKeys(view: MainViewId, isMac = isMacPlatform()): string[] | null {
  const spec = NAV_SHORTCUTS.find((entry) => entry.view === view);
  if (!spec) {
    return null;
  }
  const parts = [isMac ? "⌘" : "Ctrl"];
  if (spec.shift) {
    parts.push(isMac ? "⇧" : "Shift");
  }
  parts.push(spec.key.length === 1 ? spec.key.toUpperCase() : spec.key);
  return parts;
}

/** Compact display label, e.g. "⌘⇧H" on macOS or "Ctrl+Shift+H" elsewhere. */
export function formatNavShortcut(view: MainViewId, isMac = isMacPlatform()): string | null {
  const keys = navShortcutKeys(view, isMac);
  if (!keys) {
    return null;
  }
  return isMac ? keys.join("") : keys.join("+");
}

/**
 * Returns the view a keydown event navigates to, or null. The primary
 * modifier is ⌘ on macOS and Ctrl elsewhere.
 */
export function matchNavShortcut(event: KeyboardEvent, isMac = isMacPlatform()): MainViewId | null {
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const strayModifier = isMac ? event.ctrlKey : event.metaKey;
  if (!primary || strayModifier || event.altKey) {
    return null;
  }
  const key = event.key.toLowerCase();
  const spec = NAV_SHORTCUTS.find(
    (entry) => entry.key === key && entry.shift === event.shiftKey
  );
  return spec?.view ?? null;
}
