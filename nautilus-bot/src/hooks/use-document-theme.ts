import { useEffect, useState } from "react";

export type DocumentTheme = "dark" | "light";

function readDocumentTheme(): DocumentTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Plainsong's own light/dark choice, from the `.dark` class ThemeProvider and
 * theme-boot.js put on <html>. For canvas effects that would otherwise follow
 * the macOS appearance instead of the app's setting, and that also render in
 * overlay windows with no ThemeProvider above them.
 */
export function useDocumentTheme(): DocumentTheme {
  const [theme, setTheme] = useState<DocumentTheme>(readDocumentTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    setTheme(readDocumentTheme());
    return () => observer.disconnect();
  }, []);

  return theme;
}
