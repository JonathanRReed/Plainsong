export type OnboardingMode = "full" | "dictation" | "meetings";

/**
 * The two retired first-run flags, kept only so a profile that still carries
 * them can be read once and then cleaned up.
 *
 * They lived in the renderer's localStorage, which lives in the Electron
 * user-data directory, which every development build shares with the packaged
 * app. A signed DMG installed onto a Mac that had ever run Plainsong therefore
 * inherited "already onboarded" from months of dev runs and skipped the wizard
 * in silence — the reader had to find and grant every macOS permission
 * themselves.
 *
 * Nothing writes them any more. The durable record is `settings.onboarding`
 * (see rust-sidecar/src/settings.rs), and what to do about it is decided by
 * `src/features/onboarding/onboarding-gate.ts` from live readiness rather than
 * from any stored boolean.
 */
export const ONBOARDING_STORAGE_KEY = "nautilus_onboarding_complete";
export const MEETING_ONBOARDING_STORAGE_KEY = "nautilus_meeting_onboarding_complete";
export const OPEN_ONBOARDING_EVENT = "nautilus-open-onboarding";

interface OpenOnboardingDetail {
  mode?: OnboardingMode;
}

export function requestOnboarding(mode: OnboardingMode = "full") {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<OpenOnboardingDetail>(OPEN_ONBOARDING_EVENT, {
      detail: { mode },
    })
  );
}
