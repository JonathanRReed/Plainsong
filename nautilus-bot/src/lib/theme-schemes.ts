interface ThemeSchemeOption {
  value: string;
  label: string;
}

export const THEME_SCHEMES: ThemeSchemeOption[] = [
  { value: "default", label: "Default" },
  { value: "rose-pine", label: "Rose Pine Night" },
  { value: "rose-pine-dawn", label: "Rose Pine Dawn" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "dracula", label: "Dracula" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "gruvbox", label: "Gruvbox Dark" },
  { value: "nord", label: "Nord" },
  { value: "rose-pine-moon", label: "Rose Pine Moon" },
  { value: "catppuccin", label: "Catppuccin Mocha" },
];

export function normalizeThemeScheme(value: string): string {
  return THEME_SCHEMES.some((scheme) => scheme.value === value) ? value : "default";
}
