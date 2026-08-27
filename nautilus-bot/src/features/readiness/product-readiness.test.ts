import { describe, expect, it } from "vitest";
import {
  buildProductReadinessSnapshot,
  selectReadinessForSurface,
  updateProductReadinessSnapshot,
  type ProductReadinessEvidence,
  type ReadinessAssessment,
} from "@/features/readiness/product-readiness";

function evidence(
  overrides: Partial<ProductReadinessEvidence> = {},
): ProductReadinessEvidence {
  return {
    observedAt: 100,
    loading: false,
    error: null,
    settingsLoaded: true,
    providersLoaded: true,
    microphonePermissionReady: true,
    microphoneDeviceReady: true,
    dictationRouteReady: true,
    dictationRouteReason: null,
    cursorInsertionRequired: true,
    cursorInsertionReady: true,
    meetingRouteReady: true,
    meetingRouteReason: null,
    meetingNotesRoute: "ready",
    meetingNotesRouteReason: null,
    systemAudioState: "ready",
    ...overrides,
  };
}

function expectActionable(assessment: ReadinessAssessment) {
  if (assessment.state === "ready") {
    expect(assessment.cause).toBeNull();
    return;
  }

  expect(assessment.cause).not.toBeNull();
  expect(assessment.cause?.message.length).toBeGreaterThan(0);
  expect(assessment.cause?.action.label.length).toBeGreaterThan(0);
}

describe("product readiness", () => {
  it("reports every domain ready from one complete evidence snapshot", () => {
    const snapshot = buildProductReadinessSnapshot(evidence());

    expect(snapshot.dictation.state).toBe("ready");
    expect(snapshot.meetings.state).toBe("ready");
    expect(snapshot.fullCapture.state).toBe("ready");
    expect(snapshot.overall.state).toBe("ready");
    expect(snapshot.overall.cause).toBeNull();
  });

  it("keeps mic-only meetings ready while full capture is degraded", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({ systemAudioState: "unverified" }),
    );

    expect(snapshot.meetings.state).toBe("ready");
    expect(snapshot.fullCapture.state).toBe("degraded");
    expect(snapshot.fullCapture.cause?.id).toBe("system_audio_unverified");
    expect(snapshot.fullCapture.cause?.action.id).toBe("test_system_audio");
    expect(snapshot.overall.state).toBe("degraded");
  });

  it("uses one precedence order when several facts are missing", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({
        microphonePermissionReady: false,
        microphoneDeviceReady: false,
        dictationRouteReady: false,
        dictationRouteReason: "The selected model is missing.",
        cursorInsertionReady: false,
      }),
    );

    expect(snapshot.dictation.state).toBe("needs_action");
    expect(snapshot.dictation.cause?.id).toBe("microphone_permission");
    expect(snapshot.dictation.cause?.action.id).toBe("request_permissions");
  });

  it("never turns missing authoritative evidence into ready", () => {
    const loading = buildProductReadinessSnapshot(
      evidence({
        loading: true,
        settingsLoaded: false,
        providersLoaded: false,
        microphonePermissionReady: null,
        microphoneDeviceReady: null,
        dictationRouteReady: null,
        cursorInsertionReady: null,
        meetingRouteReady: null,
        systemAudioState: "unknown",
      }),
    );
    const failed = buildProductReadinessSnapshot(
      evidence({ error: "The sidecar did not answer." }),
    );

    expect(loading.overall.state).toBe("unknown");
    expect(loading.overall.cause?.id).toBe("loading");
    expect(failed.overall.state).toBe("blocked");
    expect(failed.overall.cause?.id).toBe("source_error");
    expect(failed.overall.cause?.action.id).toBe("retry");
  });

  it("gives every non-ready state one actionable cause", () => {
    const snapshots = [
      buildProductReadinessSnapshot(
        evidence({ systemAudioState: "unavailable" }),
      ),
      buildProductReadinessSnapshot(
        evidence({ microphonePermissionReady: false }),
      ),
      buildProductReadinessSnapshot(
        evidence({
          microphoneDeviceReady: false,
          microphonePermissionReady: true,
        }),
      ),
      buildProductReadinessSnapshot(
        evidence({
          dictationRouteReady: false,
          dictationRouteReason: "Download the selected model.",
        }),
      ),
      buildProductReadinessSnapshot(
        evidence({
          cursorInsertionReady: false,
          cursorInsertionRequired: true,
        }),
      ),
      buildProductReadinessSnapshot(
        evidence({
          meetingRouteReady: false,
          meetingRouteReason: "Choose a meeting engine.",
        }),
      ),
      buildProductReadinessSnapshot(
        evidence({ settingsLoaded: false }),
      ),
      buildProductReadinessSnapshot(
        evidence({
          meetingNotesRoute: "unconfigured",
          meetingNotesRouteReason: "Ollama on this machine is not running.",
        }),
      ),
    ];

    for (const snapshot of snapshots) {
      for (const assessment of [
        snapshot.dictation,
        snapshot.meetings,
        snapshot.fullCapture,
        snapshot.overall,
      ]) {
        expectActionable(assessment);
      }
    }
  });

  it("degrades meetings when the AI lane cannot write notes", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({
        meetingNotesRoute: "unconfigured",
        meetingNotesRouteReason: "Ollama on this machine is not running.",
      }),
    );

    expect(snapshot.meetings.state).toBe("degraded");
    expect(snapshot.meetings.cause?.id).toBe("ai_route");
    expect(snapshot.meetings.cause?.message).toContain("Notes unavailable");
    expect(snapshot.meetings.cause?.message).toContain(
      "Ollama on this machine is not running.",
    );
    expect(snapshot.meetings.cause?.action.id).toBe("open_ai_settings");
    expect(snapshot.meetings.cause?.action.destination).toBe("ai");
    // Capture is the fact Me + Them depends on, so the notes lane must not
    // become the stated reason system audio is unavailable.
    expect(snapshot.fullCapture.state).toBe("ready");
  });

  it("respects a remembered transcripts-only choice", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({
        meetingNotesRoute: "opted_out",
        meetingNotesRouteReason:
          "Meeting notes are off. Plainsong keeps transcripts only.",
      }),
    );

    expect(snapshot.meetings.state).toBe("ready");
    expect(snapshot.meetings.cause).toBeNull();
  });

  it("never lets an unanswered AI probe read as ready", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({ meetingNotesRoute: "unknown" }),
    );

    expect(snapshot.meetings.state).toBe("degraded");
    expect(snapshot.meetings.cause?.id).toBe("ai_route");
  });

  it("keeps a capture blocker ahead of a missing AI route", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({
        microphonePermissionReady: false,
        meetingNotesRoute: "unconfigured",
        meetingNotesRouteReason: "Ollama on this machine is not running.",
      }),
    );

    expect(snapshot.meetings.state).toBe("needs_action");
    expect(snapshot.meetings.cause?.id).toBe("microphone_permission");
  });

  it("does not let stale evidence replace a newer snapshot", () => {
    const current = buildProductReadinessSnapshot(
      evidence({ observedAt: 200 }),
    );
    const stale = evidence({
      observedAt: 199,
      microphonePermissionReady: false,
    });

    expect(updateProductReadinessSnapshot(current, stale)).toBe(current);
  });

  it("selects the same canonical assessment for every surface", () => {
    const snapshot = buildProductReadinessSnapshot(
      evidence({
        dictationRouteReady: false,
        dictationRouteReason: "Download the dictation model.",
      }),
    );

    expect(selectReadinessForSurface(snapshot, "dictation")).toBe(
      snapshot.dictation,
    );
    expect(selectReadinessForSurface(snapshot, "meetings")).toBe(
      snapshot.meetings,
    );
    expect(selectReadinessForSurface(snapshot, "home")).toBe(snapshot.overall);
    expect(selectReadinessForSurface(snapshot, "setup")).toBe(snapshot.overall);
    expect(selectReadinessForSurface(snapshot, "sidebar")).toBe(
      snapshot.overall,
    );
    expect(selectReadinessForSurface(snapshot, "models").cause?.id).toBe(
      "dictation_route",
    );
  });
});
