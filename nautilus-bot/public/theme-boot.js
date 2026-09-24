// Sets the theme class before first paint, from the preference ThemeProvider
// cached on the last launch. A plain file rather than an inline script so the
// renderer CSP can stay `script-src 'self'`. Keep the key in step with
// THEME_CACHE_KEY in src/components/theme-provider.tsx.
(function () {
  try {
    var theme = localStorage.getItem("plainsong.theme");
    if (theme !== "light" && theme !== "system") return;
    var dark =
      theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } catch (error) {
    // No storage: keep the dark default index.html ships with.
  }
})();
