interface ThemeSchemeOption {
  value: string;
  label: string;
}

// Plainsong ships one palette — vellum + ink, one gold accent, one rust
// rubric, no other hues. Light/dark is the candle-lit-folio vs vellum toggle
// handled by the theme provider; there are no alternate color schemes.
const THEME_SCHEMES: ThemeSchemeOption[] = [
  { value: "default", label: "Plainsong" },
];

export function normalizeThemeScheme(value: string): string {
  return THEME_SCHEMES.some((scheme) => scheme.value === value) ? value : "default";
}
