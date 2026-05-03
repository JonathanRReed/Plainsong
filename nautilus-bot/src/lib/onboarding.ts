export type OnboardingMode = "full" | "dictation" | "meetings";

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
