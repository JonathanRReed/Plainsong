export const MEETING_CONSENT_NOTICE_TEXT =
  "Heads up: I’m recording and transcribing this meeting with Plainsong for my notes. Please let me know now if you want me to stop.";

interface MeetingConsentStateLike {
  consentPromptShown?: boolean | null;
  consentNoticeMode?: string | null;
  consentNoticeMessage?: string | null;
}

interface MeetingConsentDescriptor {
  label: string;
  shareLabel: string;
  message: string | null;
  tracked: boolean;
  needsManualNotice: boolean;
}

export function describeMeetingConsent(
  state: MeetingConsentStateLike | null | undefined,
  fallbackPromptShown = false
): MeetingConsentDescriptor {
  const promptShown = Boolean(state?.consentPromptShown) || fallbackPromptShown;
  const mode = state?.consentNoticeMode ?? null;
  const message = state?.consentNoticeMessage?.trim() ? state.consentNoticeMessage : null;

  if (mode === "sent") {
    return {
      label: "Notice sent",
      shareLabel: "Notice sent",
      message,
      tracked: true,
      needsManualNotice: false,
    };
  }

  if (mode) {
    return {
      label: "Manual reminder required",
      shareLabel: "Manual reminder required",
      message,
      tracked: true,
      needsManualNotice: true,
    };
  }

  if (promptShown) {
    return {
      label: "Prompt shown",
      shareLabel: "Prompt shown",
      message,
      tracked: true,
      needsManualNotice: true,
    };
  }

  return {
    label: "Not tracked",
    shareLabel: "Not tracked",
    message,
    tracked: false,
    needsManualNotice: false,
  };
}
