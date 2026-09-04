import { describe, expect, it } from "vitest";
import {
  resolveOnboardingGate,
  unmetOnboardingRequirements,
  type OnboardingGateInput,
} from "@/features/onboarding/onboarding-gate";
import type { OnboardingSettings } from "@/types/settings";

/**
 * The launch decision, as a table.
 *
 * The bug this replaces: a signed DMG installed onto a Mac that had ever run a
 * development build read `nautilus_onboarding_complete = true` out of the
 * shared Electron user-data directory and never showed the wizard. Rows 3 and 4
 * are that case, and they are the reason the flag alone can no longer decide
 * anything.
 */

/** A fully working Mac: mic granted, Accessibility granted, model on disk. */
const READY: Omit<OnboardingGateInput, "record" | "legacyFlagComplete"> = {
  evidenceLoaded: true,
  evidenceError: null,
  evidenceTimedOut: false,
  microphonePermissionReady: true,
  cursorInsertionRequired: true,
  cursorInsertionReady: true,
  dictationRouteReady: true,
};

const NEVER_SET_UP: OnboardingSettings = {};

const COMPLETED_IN_JUNE: OnboardingSettings = {
  completedAt: "2026-06-19T10:04:00Z",
  completedVersion: "0.9.0-beta.1",
};

describe("resolveOnboardingGate", () => {
  it("holds the splash until the install's record has loaded", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      record: null,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("wait");
  });

  it("holds the splash while readiness is still being read", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      evidenceLoaded: false,
      microphonePermissionReady: null,
      cursorInsertionReady: null,
      dictationRouteReady: null,
      record: NEVER_SET_UP,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("wait");
  });

  it("shows the wizard on an install that has recorded nothing", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      microphonePermissionReady: false,
      cursorInsertionReady: false,
      dictationRouteReady: false,
      record: NEVER_SET_UP,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
    expect(decision.mode).toBe("full");
    expect(decision.unmet).toEqual([
      "microphone_permission",
      "cursor_insertion",
      "dictation_model",
    ]);
  });

  // The reported bug, exactly.
  it("shows the wizard when only the legacy renderer flag claims setup happened and the Mac is not set up", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      microphonePermissionReady: false,
      cursorInsertionReady: false,
      dictationRouteReady: false,
      record: NEVER_SET_UP,
      legacyFlagComplete: true,
    });
    expect(decision.action).toBe("show");
    expect(decision.adoptRecord).toBe(false);
  });

  it("adopts the legacy flag instead of re-running the wizard when the Mac really is set up", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      record: NEVER_SET_UP,
      legacyFlagComplete: true,
    });
    expect(decision.action).toBe("skip");
    expect(decision.adoptRecord).toBe(true);
  });

  it("records a working install that carries neither a record nor a flag, rather than staging a wizard over it", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      record: NEVER_SET_UP,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("skip");
    expect(decision.adoptRecord).toBe(true);
  });

  it("stays out of the way when setup was completed and dictation still works", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      record: COMPLETED_IN_JUNE,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("skip");
    expect(decision.adoptRecord).toBe(false);
  });

  // Completed in June, Accessibility revoked in September.
  it("helps a completed install whose permission was revoked later", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      cursorInsertionReady: false,
      record: COMPLETED_IN_JUNE,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
    expect(decision.unmet).toEqual(["cursor_insertion"]);
    expect(decision.reason).toContain("Accessibility is not granted");
  });

  it("helps a completed install whose dictation model is gone", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      dictationRouteReady: false,
      record: COMPLETED_IN_JUNE,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
    expect(decision.unmet).toEqual(["dictation_model"]);
  });

  it("never asks for Accessibility when the configured insertion mode does not use it", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      cursorInsertionRequired: false,
      cursorInsertionReady: false,
      record: COMPLETED_IN_JUNE,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("skip");
    expect(decision.unmet).toEqual([]);
  });

  it("stays quiet about exactly what the reader deferred", () => {
    const deferred: OnboardingSettings = {
      deferredAt: "2026-09-01T09:00:00Z",
      deferredUnmet: ["dictation_model", "microphone_permission"],
    };
    const decision = resolveOnboardingGate({
      ...READY,
      microphonePermissionReady: false,
      dictationRouteReady: false,
      record: deferred,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("skip");
  });

  it("speaks up again when something the reader did not defer breaks", () => {
    const deferred: OnboardingSettings = {
      completedAt: "2026-06-19T10:04:00Z",
      deferredAt: "2026-09-01T09:00:00Z",
      deferredUnmet: ["dictation_model"],
    };
    const decision = resolveOnboardingGate({
      ...READY,
      cursorInsertionReady: false,
      dictationRouteReady: false,
      record: deferred,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
    expect(decision.unmet).toEqual(["cursor_insertion", "dictation_model"]);
  });

  it("does not interrupt a recorded install when readiness cannot be checked at all", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      evidenceLoaded: false,
      evidenceError: "The transcription engine stopped.",
      microphonePermissionReady: null,
      cursorInsertionReady: null,
      dictationRouteReady: null,
      record: COMPLETED_IN_JUNE,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("skip");
  });

  it("still opens the wizard on an unrecorded install when readiness cannot be checked", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      evidenceLoaded: false,
      evidenceError: "The transcription engine stopped.",
      microphonePermissionReady: null,
      cursorInsertionReady: null,
      dictationRouteReady: null,
      record: NEVER_SET_UP,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
  });

  it("decides rather than holding the splash forever when settings never answer", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      evidenceLoaded: false,
      evidenceTimedOut: true,
      microphonePermissionReady: null,
      cursorInsertionReady: null,
      dictationRouteReady: null,
      record: null,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
  });

  it("decides rather than holding the splash forever when readiness never answers", () => {
    const decision = resolveOnboardingGate({
      ...READY,
      evidenceLoaded: false,
      evidenceTimedOut: true,
      microphonePermissionReady: null,
      cursorInsertionReady: null,
      dictationRouteReady: null,
      record: NEVER_SET_UP,
      legacyFlagComplete: false,
    });
    expect(decision.action).toBe("show");
  });
});

describe("unmetOnboardingRequirements", () => {
  it("treats an unanswered probe as unproven, never as granted", () => {
    expect(
      unmetOnboardingRequirements({
        microphonePermissionReady: null,
        cursorInsertionRequired: true,
        cursorInsertionReady: null,
        dictationRouteReady: null,
      }),
    ).toEqual([
      "microphone_permission",
      "cursor_insertion",
      "dictation_model",
    ]);
  });
});
