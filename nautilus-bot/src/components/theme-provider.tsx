import React, { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@/lib/electron";
import { normalizeThemeScheme } from "@/lib/theme-schemes";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
  colorScheme: string;
  setColorScheme: (scheme: string) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Dark (the candle-lit folio) is Plainsong's default.
  const [theme, setThemeState] = useState<Theme>("dark");
  const [isDark, setIsDark] = useState(false);
  const [colorScheme, setColorSchemeState] = useState<string>("default");

  const applyColorScheme = (scheme: string) => {
    const root = window.document.documentElement;
    if (scheme === "default") {
      root.removeAttribute("data-theme");
      return;
    }
    root.setAttribute("data-theme", scheme);
  };

  // Load theme from settings on mount
  useEffect(() => {
    const loadTheme = async () => {
      try {
        const settings = await invoke<Record<string, unknown>>("get_settings");
        const savedTheme = (settings.theme as Theme) || "dark";
        const ui = (settings.ui as Record<string, unknown> | undefined) ?? {};
        const rawColorScheme = typeof ui.colorScheme === "string" ? ui.colorScheme : "default";
        const savedColorScheme = normalizeThemeScheme(rawColorScheme);
        setThemeState(savedTheme);
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
        // If settings not available, default to the candle-lit folio.
        setThemeState("dark");
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
    applyColorScheme(colorScheme);
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
    applyColorScheme(normalized);

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
