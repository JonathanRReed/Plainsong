import type { OnboardingMode } from "@/lib/onboarding";
import type { OnboardingSettings } from "@/types/settings";

/**
 * Whether to open the first-run wizard, decided from what the app can actually
 * do rather than from a stored boolean.
 *
 * The boolean is what broke. `nautilus_onboarding_complete` lived in the
 * renderer's localStorage, which lives in the Electron user-data directory,
 * which every development build shares with the packaged app. A signed DMG
 * installed onto a Mac that had ever run Plainsong inherited "already
 * onboarded" and skipped setup in silence, leaving the reader to find every
 * macOS permission themselves.
 *
 * A flag would have gone stale eventually anyway. Permissions get revoked,
 * models get deleted, a Mac gets restored from a backup. So the durable record
 * (`settings.onboarding`) says what happened and when, and this function says
 * what to do about it — by asking whether dictation can run right now.
 */

/** One thing the app needs before it can dictate at all. */
export type OnboardingRequirementId =
  | "microphone_permission"
  | "cursor_insertion"
  | "dictation_model";

export type OnboardingGateAction =
  /** Not enough is known yet. Hold the splash rather than flash a workspace. */
  | "wait"
  /** Open the wizard. */
  | "show"
  /** Stay out of the way. */
  | "skip";

export interface OnboardingGateInput {
  /**
   * The install's record. `null` means settings have not been read yet, which
   * is not the same as an install that has never been set up.
   */
  record: OnboardingSettings | null;
  /** The retired renderer flag, if this profile still carries one. */
  legacyFlagComplete: boolean;
  /** True once settings, providers and permissions have all answered once. */
  evidenceLoaded: boolean;
  /** Non-null when readiness could not be established (a dead sidecar, say). */
  evidenceError: string | null;
  /**
   * True once the launch has waited longer than it is willing to for readiness.
   * Treated exactly like an error: the splash must not become the app.
   */
  evidenceTimedOut: boolean;
  /** `null` is "not observed", never "granted". */
  microphonePermissionReady: boolean | null;
  /** False when the configured insertion mode is clipboard-only. */
  cursorInsertionRequired: boolean;
  cursorInsertionReady: boolean | null;
  /** Whether the selected dictation route is genuinely usable — model on disk. */
  dictationRouteReady: boolean | null;
}

export interface OnboardingGateDecision {
  action: OnboardingGateAction;
  mode: OnboardingMode;
  /** What is missing right now, in the order the wizard addresses it. */
  unmet: OnboardingRequirementId[];
  /**
   * Whether to write the durable record now because the app is demonstrably
   * working but nothing on disk says setup ever happened.
   */
  adoptRecord: boolean;
  /** One plain sentence. Safe to log: it names state, never content. */
  reason: string;
}

const REQUIREMENT_SUMMARIES: Record<OnboardingRequirementId, string> = {
  microphone_permission: "Microphone permission is not granted",
  cursor_insertion:
    "Accessibility is not granted, and the current insertion mode needs it",
  dictation_model: "No dictation model is ready on this Mac",
};

/** One plain sentence naming what a requirement is missing. */
function describeOnboardingRequirement(
  id: OnboardingRequirementId,
): string {
  return REQUIREMENT_SUMMARIES[id];
}

/**
 * What stands between this Mac and a working dictation.
 *
 * Accessibility only counts when the configured insertion mode actually needs
 * it: telling someone a permission is required when their mode never uses it
 * is the kind of claim this product does not make.
 */
export function unmetOnboardingRequirements(
  input: Pick<
    OnboardingGateInput,
    | "microphonePermissionReady"
    | "cursorInsertionRequired"
    | "cursorInsertionReady"
    | "dictationRouteReady"
  >,
): OnboardingRequirementId[] {
  const unmet: OnboardingRequirementId[] = [];
  if (input.microphonePermissionReady !== true) {
    unmet.push("microphone_permission");
  }
  if (input.cursorInsertionRequired && input.cursorInsertionReady !== true) {
    unmet.push("cursor_insertion");
  }
  if (input.dictationRouteReady !== true) {
    unmet.push("dictation_model");
  }
  return unmet;
}

/**
 * Whether a recorded deferral already answers everything that is unmet now.
 *
 * "Skip setup for now" has to mean something, or the wizard becomes a modal
 * the reader fights on every launch. It suppresses exactly what they saw and
 * declined; anything new that breaks brings the wizard back.
 */
function deferralCovers(
  record: OnboardingSettings,
  unmet: OnboardingRequirementId[],
): boolean {
  if (!record.deferredAt) {
    return false;
  }
  const deferred = new Set(record.deferredUnmet ?? []);
  return unmet.every((id) => deferred.has(id));
}

function decision(
  action: OnboardingGateAction,
  reason: string,
  unmet: OnboardingRequirementId[] = [],
  adoptRecord = false,
): OnboardingGateDecision {
  return { action, mode: "full", unmet, adoptRecord, reason };
}

/**
 * The whole first-run policy, as a pure function over
 * (record, legacy flag, readiness).
 */
export function resolveOnboardingGate(
  input: OnboardingGateInput,
): OnboardingGateDecision {
  const { record } = input;
  const stopWaiting = Boolean(input.evidenceError) || input.evidenceTimedOut;
  if (!record) {
    if (!stopWaiting) {
      return decision("wait", "The install's onboarding record has not loaded yet.");
    }
    // Settings never answered. Nothing is known about this install, so it is
    // treated as one that has never been set up — offering setup to someone
    // who did not need it costs a dismissal; a splash that never resolves
    // costs them the app.
    return decision(
      "show",
      "The install's onboarding record could not be read, so setup has not been established.",
    );
  }

  const completed = Boolean(record.completedAt);
  const deferred = Boolean(record.deferredAt);
  const anythingRecorded = completed || deferred || input.legacyFlagComplete;

  if (!input.evidenceLoaded) {
    if (stopWaiting) {
      // Readiness could not be established, so "is this Mac working" has no
      // answer. An install that has never recorded anything is a first run
      // whether or not the check succeeded; one that has is left alone rather
      // than interrupted over a probe failure it cannot fix from a wizard.
      return anythingRecorded
        ? decision(
            "skip",
            "Setup state could not be checked, and this install has a setup record already.",
          )
        : decision(
            "show",
            "This install has no setup record, and setup state could not be checked.",
          );
    }
    return decision("wait", "Waiting for permissions, models and settings to report.");
  }

  const unmet = unmetOnboardingRequirements(input);

  if (unmet.length === 0) {
    if (completed) {
      return decision("skip", "Setup was completed, and dictation is ready on this Mac.");
    }
    // Working, but nothing on disk says setup ever happened: a profile carrying
    // the old renderer flag, or an install restored from a backup. Record it
    // rather than staging a wizard over an app that already works.
    return decision(
      "skip",
      input.legacyFlagComplete
        ? "Dictation is ready and this profile carries the old renderer flag, so the record was written to settings."
        : "Dictation is ready on this Mac, so setup was recorded without running the wizard.",
      [],
      true,
    );
  }

  if (deferralCovers(record, unmet)) {
    return decision(
      "skip",
      "Setup is incomplete, but the reader already deferred everything that is missing.",
      unmet,
    );
  }

  if (completed) {
    return decision(
      "show",
      `Setup was completed before, but dictation cannot run now: ${unmet
        .map(describeOnboardingRequirement)
        .join("; ")}.`,
      unmet,
    );
  }

  return decision(
    "show",
    `Setup has not been completed on this install: ${unmet
      .map(describeOnboardingRequirement)
      .join("; ")}.`,
    unmet,
  );
}
