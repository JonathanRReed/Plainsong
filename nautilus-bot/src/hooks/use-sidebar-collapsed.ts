import { useCallback, useEffect, useState } from "react";

/** The reader's own collapse choice, kept across launches. */
const SIDEBAR_COLLAPSED_KEY = "plainsong.sidebarCollapsed";

/** Below this window width the sidebar collapses on its own. */
const NARROW_WINDOW_QUERY = "(max-width: 999px)";

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // The choice holds for this launch; the next one opens expanded.
  }
}

function matchNarrowWindow(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_WINDOW_QUERY)
    : null;
}

/**
 * Whether the sidebar is collapsed.
 *
 * On a wide window it follows the reader's saved choice. On a narrow one it
 * collapses so the workspace keeps its room; expanding it there lasts until
 * the window is wide again and does not overwrite the saved choice.
 */
export function useSidebarCollapsed(): {
  collapsed: boolean;
  toggle(): void;
} {
  const [savedCollapsed, setSavedCollapsed] = useState(readStoredCollapsed);
  const [narrow, setNarrow] = useState(() => matchNarrowWindow()?.matches ?? false);
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false);

  useEffect(() => {
    const query = matchNarrowWindow();
    if (!query) return;
    const handleChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      setExpandedWhileNarrow(false);
    };
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const toggle = useCallback(() => {
    if (narrow) {
      setExpandedWhileNarrow((expanded) => !expanded);
      return;
    }
    setSavedCollapsed((collapsed) => {
      storeCollapsed(!collapsed);
      return !collapsed;
    });
  }, [narrow]);

  return {
    collapsed: narrow ? !expandedWhileNarrow : savedCollapsed,
    toggle,
  };
}
