/** Conference links accepted for an explicit calendar join action. */
export function calendarConferenceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname;
    const domain = (name: string) => host === name || host.endsWith(`.${name}`);
    const supported =
      ((domain("zoom.us") || domain("zoomgov.com")) && /^\/(j|wc\/join)\/\d+\/?$/.test(url.pathname)) ||
      (host === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) ||
      ((host === "teams.microsoft.com" || host === "teams.live.com") && /^\/(l\/meetup-join|meet)\/[^/]+/.test(url.pathname));
    return supported ? url.href : null;
  } catch {
    return null;
  }
}

export function firstCalendarConferenceUrl(values: readonly unknown[]): string | null {
  for (const value of values) {
    const url = calendarConferenceUrl(value);
    if (url) return url;
  }
  return null;
}
