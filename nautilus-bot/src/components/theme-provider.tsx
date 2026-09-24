import React, { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@/lib/electron";
import { applyThemeScheme, normalizeThemeScheme } from "@/lib/theme-schemes";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
  colorScheme: string;
  setColorScheme: (scheme: string) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * The last theme preference settings reported, so the next launch paints in
 * it before `get_settings` answers. public/theme-boot.js reads the same key to
 * set the class ahead of first paint. Settings stay the source of truth: this
 * is only ever a copy of what they said last time.
 */
const THEME_CACHE_KEY = "plainsong.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readCachedTheme(): Theme | null {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    return isTheme(cached) ? cached : null;
  } catch {
    return null;
  }
}

function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Costs one launch in the default theme, nothing more.
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Dark (the candle-lit folio) is Plainsong's default.
  const [theme, setThemeState] = useState<Theme>(() => readCachedTheme() ?? "dark");
  const [isDark, setIsDark] = useState(() =>
    window.document.documentElement.classList.contains("dark"),
  );
  const [colorScheme, setColorSchemeState] = useState<string>("default");

  // Load theme from settings on mount
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const settings = await invoke<Record<string, unknown>>("get_settings");
        const savedTheme = isTheme(settings.theme) ? settings.theme : "dark";
        const ui = (settings.ui as Record<string, unknown> | undefined) ?? {};
        const rawColorScheme = typeof ui.colorScheme === "string" ? ui.colorScheme : "default";
        const savedColorScheme = normalizeThemeScheme(rawColorScheme);
        setThemeState(savedTheme);
        cacheTheme(savedTheme);
        setColorSchemeState(savedColorScheme);
        if (savedColorScheme !== rawColorScheme) {
          await invoke("save_settings", {
            settings: {
              ...settings,
              ui: {
                ...ui,
                colorScheme: savedColorScheme,
              },
            },
          });
        }
      } catch {
        // If settings not available, keep what the last launch cached, or
        // default to the candle-lit folio.
        setThemeState(readCachedTheme() ?? "dark");
        setColorSchemeState("default");
      }
    };
    loadTheme();
  }, []);

  // Apply theme class to document
  useEffect(() => {
    const root = window.document.documentElement;
    
    if (theme === "system") {
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setIsDark(systemDark);
      root.classList.toggle("dark", systemDark);
    } else {
      setIsDark(theme === "dark");
      root.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  useEffect(() => {
    applyThemeScheme(colorScheme);
  }, [colorScheme]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (theme !== "system") return;
    
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      setIsDark(e.matches);
      window.document.documentElement.classList.toggle("dark", e.matches);
    };
    
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = async (newTheme: Theme) => {
    setThemeState(newTheme);
    cacheTheme(newTheme);
    
    // Save to settings
    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      await invoke("save_settings", {
        settings: {
          ...settings,
          theme: newTheme,
        },
      });
    } catch {
      // Ignore save errors
    }
  };

  const setColorScheme = async (scheme: string) => {
    const normalized = normalizeThemeScheme(scheme);
    setColorSchemeState(normalized);
    applyThemeScheme(normalized);

    try {
      const settings = await invoke<Record<string, unknown>>("get_settings");
      const ui = (settings.ui as Record<string, unknown> | undefined) ?? {};
      await invoke("save_settings", {
        settings: {
          ...settings,
          ui: {
            ...ui,
            colorScheme: normalized,
          },
        },
      });
    } catch {
      // Ignore save errors
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isDark, colorScheme, setColorScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
