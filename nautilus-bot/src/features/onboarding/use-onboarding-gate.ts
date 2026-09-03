import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordOnboardingState } from "@/lib/backend/settings";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import {
  MEETING_ONBOARDING_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
} from "@/lib/onboarding";
import {
  resolveOnboardingGate,
  type OnboardingGateDecision,
} from "@/features/onboarding/onboarding-gate";

/**
 * Read the retired renderer flag, if this Electron profile still has one.
 *
 * It is evidence, not an answer: `resolveOnboardingGate` only ever lets it
 * settle a case the world has already settled. A profile where storage throws
 * is treated as carrying no flag, which is the conservative reading — the gate
 * then falls back to what the app can actually do.
 */
function readLegacyOnboardingFlag(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Drop the retired renderer flags once the durable record exists.
 *
 * Best-effort by design: the record in settings.json is what decides from here
 * on, so a profile that refuses the removal is merely untidy, not wrong.
 */
function clearLegacyOnboardingFlags(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    localStorage.removeItem(MEETING_ONBOARDING_STORAGE_KEY);
  } catch {
    // Nothing reads them any more.
  }
}

/**
 * How long a launch will hold the "Checking your setup" splash before deciding
 * without a complete readiness answer.
 *
 * The splash exists so a stale-looking workspace never flashes in front of
 * someone whose setup state is unknown. It is not allowed to become the app: a
 * sidecar that answers slowly (or never) must still produce a screen.
 *
 * Longer than it looks like it needs to be, on purpose. `get_settings` carries
 * a 15-second IPC timeout (electron/ipc-command-policy.ts), so a sidecar that
 * cannot answer reports an *error* well before this fires, and the gate
 * decides on that instead. This only backstops the case where no answer and no
 * error ever arrive. An earlier 6-second value was measured firing on a busy
 * Mac during the packaged capture -- which would have flashed a first-run
 * wizard at someone who was already set up, for the two seconds it took
 * settings to arrive.
 *
 * Exported so a test can assert this stays longer than the `get_settings`
 * timeout rather than the two drifting apart silently. See
 * `src/__tests__/use-onboarding-gate.test.ts`.
 */
export const READINESS_PATIENCE_MS = 20_000;

/**
 * The launch-time first-run decision, wired to live readiness.
 *
 * `useSetupStatus` already re-reads permissions, models and settings whenever
 * the window regains focus or the sidecar says something changed, so a
 * permission granted in System Settings updates this without a relaunch.
 */
export function useOnboardingGate(): {
  decision: OnboardingGateDecision;
  /** Record a finished wizard run. */
  recordCompleted(meetingsCompleted: boolean): Promise<void>;
  /** Record a wizard the reader closed with setup unfinished. */
  recordDeferred(): Promise<void>;
} {
  const readiness = useProductReadinessStatus();
  const [legacyFlagComplete] = useState(readLegacyOnboardingFlag);
  const [evidenceTimedOut, setEvidenceTimedOut] = useState(false);
  // One adoption per launch. The write emits `settings-changed`, which
  // refreshes readiness, which re-runs the gate — without this the same
  // decision would queue a second write behind the first.
  const adoptionRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setEvidenceTimedOut(true), READINESS_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, []);

  const record = readiness.settings?.onboarding ?? null;
  const evidenceLoaded = Boolean(
    !readiness.loading &&
      readiness.error === null &&
      readiness.settings !== null &&
      readiness.providers.length > 0 &&
      readiness.permissions !== null,
  );
  const cursorInsertionRequired =
    (readiness.settings?.transcription.dictationInsertionMode ?? "auto") !==
    "clipboard_only";

  const decision = useMemo(
    () =>
      resolveOnboardingGate({
        // `settings` is the whole document; a loaded document with no
        // `onboarding` key is an install that has never recorded anything,
        // which is a real answer and not "still loading".
        record: readiness.settings ? (record ?? {}) : null,
        legacyFlagComplete,
        evidenceLoaded,
        evidenceError: readiness.error,
        evidenceTimedOut,
        microphonePermissionReady:
          readiness.permissions?.microphonePermissionReady ??
          readiness.permissions?.microphoneReady ??
          null,
        cursorInsertionRequired,
        cursorInsertionReady:
          readiness.permissions?.cursorInsertionReady ??
          readiness.permissions?.accessibilityReady ??
          null,
        dictationRouteReady: evidenceLoaded ? readiness.dictationRoute.ready : null,
      }),
    [
      cursorInsertionRequired,
      evidenceLoaded,
      evidenceTimedOut,
      legacyFlagComplete,
      readiness.dictationRoute.ready,
      readiness.error,
      readiness.permissions,
      readiness.settings,
      record,
    ],
  );

  useEffect(() => {
    if (!decision.adoptRecord || adoptionRef.current) {
      return;
    }
    adoptionRef.current = true;
    void recordOnboardingState({ event: "migrated" })
      .then(() => {
        clearLegacyOnboardingFlags();
      })
      .catch((error) => {
        // The gate reached "skip" from live evidence, so a failed write costs
        // a repeat of this same adoption next launch, not a wrong screen.
        console.warn("[onboarding] could not record the migrated setup state:", error);
        adoptionRef.current = false;
      });
  }, [decision.adoptRecord]);

  const unmetRef = useRef(decision.unmet);
  unmetRef.current = decision.unmet;

  const recordCompleted = useCallback(async (meetingsCompleted: boolean) => {
    await recordOnboardingState({ event: "completed", meetingsCompleted });
    clearLegacyOnboardingFlags();
  }, []);

  const recordDeferred = useCallback(async () => {
    await recordOnboardingState({ event: "deferred", unmet: unmetRef.current });
  }, []);

  return { decision, recordCompleted, recordDeferred };
}
