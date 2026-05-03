type ThemeAccessLevel = "basic" | "pro" | "friends";

interface ThemeSchemeOption {
  value: string;
  label: string;
}

const BASIC_SCHEMES: ThemeSchemeOption[] = [{ value: "default", label: "Default" }];

const PRO_SCHEMES: ThemeSchemeOption[] = [
  { value: "rose-pine", label: "Rose Pine Night (Pro)" },
  { value: "rose-pine-dawn", label: "Rose Pine Dawn (Pro)" },
  { value: "solarized-dark", label: "Solarized Dark (Pro)" },
  { value: "solarized-light", label: "Solarized Light (Pro)" },
];

const FRIENDS_SCHEMES: ThemeSchemeOption[] = [
  { value: "dracula", label: "Dracula" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "gruvbox", label: "Gruvbox Dark" },
  { value: "nord", label: "Nord" },
  { value: "rose-pine-moon", label: "Rose Pine Moon" },
  { value: "catppuccin", label: "Catppuccin Mocha" },
];

export function themeSchemesForAccess(level: ThemeAccessLevel): ThemeSchemeOption[] {
  if (level === "friends") {
    return [...BASIC_SCHEMES, ...PRO_SCHEMES, ...FRIENDS_SCHEMES];
  }
  if (level === "pro") {
    return [...BASIC_SCHEMES, ...PRO_SCHEMES];
  }
  return [...BASIC_SCHEMES];
}

function isKnownThemeScheme(value: string): boolean {
  if (value === "default") {
    return true;
  }
  return [...PRO_SCHEMES, ...FRIENDS_SCHEMES].some((scheme) => scheme.value === value);
}

export function normalizeThemeSchemeForAccess(value: string, level: ThemeAccessLevel): string {
  const normalized = isKnownThemeScheme(value) ? value : "default";
  const allowed = new Set(themeSchemesForAccess(level).map((scheme) => scheme.value));
  return allowed.has(normalized) ? normalized : "default";
}
