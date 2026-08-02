export type ReadinessState =
  | "ready"
  | "degraded"
  | "needs_action"
  | "blocked"
  | "unknown";

export type ReadinessDomain =
  | "dictation"
  | "meetings"
  | "full_capture"
  | "overall";

export type ReadinessSurface =
  | "dictation"
  | "meetings"
  | "home"
  | "setup"
  | "models"
  | "sidebar";

export type ReadinessCauseId =
  | "loading"
  | "source_error"
  | "source_unavailable"
  | "microphone_permission"
  | "microphone_device"
  | "dictation_route"
  | "cursor_insertion"
  | "meeting_route"
  | "system_audio_unverified"
  | "system_audio_unavailable";

export type ReadinessActionId =
  | "retry"
  | "request_permissions"
  | "select_microphone"
  | "open_models"
  | "repair_cursor_insertion"
  | "test_system_audio"
  | "configure_system_audio";

export interface ReadinessAction {
  id: ReadinessActionId;
  label: string;
  destination: "setup" | "models" | "transcription";
}

export interface ReadinessCause {
  id: ReadinessCauseId;
  message: string;
  action: ReadinessAction;
}

export interface ReadinessAssessment {
  domain: ReadinessDomain;
  state: ReadinessState;
  cause: ReadinessCause | null;
}

export type SystemAudioReadiness =
  | "ready"
  | "unverified"
  | "unavailable"
  | "unknown";

/**
 * One observation of the authoritative readiness inputs.
 *
 * A nullable fact means the source did not return an answer. It never means
 * ready. The adapter may preserve more detailed backend data elsewhere, but
 * every product surface receives its state from this normalized record.
 */
export interface ProductReadinessEvidence {
  observedAt: number;
  loading: boolean;
  error: string | null;
  settingsLoaded: boolean;
  providersLoaded: boolean;
  microphonePermissionReady: boolean | null;
  microphoneDeviceReady: boolean | null;
  dictationRouteReady: boolean | null;
  dictationRouteReason: string | null;
  cursorInsertionRequired: boolean;
  cursorInsertionReady: boolean | null;
  meetingRouteReady: boolean | null;
  meetingRouteReason: string | null;
  systemAudioState: SystemAudioReadiness;
}

export interface ProductReadinessSnapshot {
  evidenceObservedAt: number;
  dictation: ReadinessAssessment;
  meetings: ReadinessAssessment;
  fullCapture: ReadinessAssessment;
  overall: ReadinessAssessment;
}

const ACTIONS: Record<ReadinessActionId, ReadinessAction> = {
  retry: {
    id: "retry",
    label: "Check again",
    destination: "setup",
  },
  request_permissions: {
    id: "request_permissions",
    label: "Request microphone access",
    destination: "setup",
  },
  select_microphone: {
    id: "select_microphone",
    label: "Choose a microphone",
    destination: "transcription",
  },
  open_models: {
    id: "open_models",
    label: "Review models",
    destination: "models",
  },
  repair_cursor_insertion: {
    id: "repair_cursor_insertion",
    label: "Repair text insertion",
    destination: "setup",
  },
  test_system_audio: {
    id: "test_system_audio",
    label: "Test system audio",
    destination: "transcription",
  },
  configure_system_audio: {
    id: "configure_system_audio",
    label: "Set up system audio",
    destination: "transcription",
  },
};

function cause(
  id: ReadinessCauseId,
  message: string,
  actionId: ReadinessActionId,
): ReadinessCause {
  return {
    id,
    message,
    action: ACTIONS[actionId],
  };
}

function assessment(
  domain: ReadinessDomain,
  state: ReadinessState,
  readinessCause: ReadinessCause | null,
): ReadinessAssessment {
  return {
    domain,
    state,
    cause: readinessCause,
  };
}

function ready(domain: ReadinessDomain): ReadinessAssessment {
  return assessment(domain, "ready", null);
}

function withDomain(
  source: ReadinessAssessment,
  domain: ReadinessDomain,
): ReadinessAssessment {
  return source.domain === domain
    ? source
    : assessment(domain, source.state, source.cause);
}

function unavailableEvidence(
  domain: ReadinessDomain,
  evidence: ProductReadinessEvidence,
): ReadinessAssessment | null {
  if (evidence.loading) {
    return assessment(
      domain,
      "unknown",
      cause(
        "loading",
        "Plainsong is still checking this setup.",
        "retry",
      ),
    );
  }

  if (evidence.error) {
    return assessment(
      domain,
      "blocked",
      cause("source_error", evidence.error, "retry"),
    );
  }

  if (!evidence.settingsLoaded || !evidence.providersLoaded) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm settings and transcription engines.",
        "retry",
      ),
    );
  }

  return null;
}

function microphoneAssessment(
  domain: ReadinessDomain,
  evidence: ProductReadinessEvidence,
): ReadinessAssessment | null {
  if (evidence.microphonePermissionReady === false) {
    return assessment(
      domain,
      "needs_action",
      cause(
        "microphone_permission",
        "Microphone access is required before capture can start.",
        "request_permissions",
      ),
    );
  }

  if (evidence.microphonePermissionReady === null) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm microphone permission.",
        "retry",
      ),
    );
  }

  if (evidence.microphoneDeviceReady === false) {
    return assessment(
      domain,
      "blocked",
      cause(
        "microphone_device",
        "No usable microphone is available.",
        "select_microphone",
      ),
    );
  }

  if (evidence.microphoneDeviceReady === null) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm a microphone device.",
        "retry",
      ),
    );
  }

  return null;
}

function dictationAssessment(
  evidence: ProductReadinessEvidence,
): ReadinessAssessment {
  const domain: ReadinessDomain = "dictation";
  const unavailable = unavailableEvidence(domain, evidence);
  if (unavailable) {
    return unavailable;
  }

  const microphone = microphoneAssessment(domain, evidence);
  if (microphone) {
    return microphone;
  }

  if (evidence.dictationRouteReady === false) {
    return assessment(
      domain,
      "blocked",
      cause(
        "dictation_route",
        evidence.dictationRouteReason ??
          "The selected dictation engine is not ready.",
        "open_models",
      ),
    );
  }

  if (evidence.dictationRouteReady === null) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm the dictation engine.",
        "retry",
      ),
    );
  }

  if (
    evidence.cursorInsertionRequired &&
    evidence.cursorInsertionReady === false
  ) {
    return assessment(
      domain,
      "needs_action",
      cause(
        "cursor_insertion",
        "Text insertion needs Accessibility access for the current mode.",
        "repair_cursor_insertion",
      ),
    );
  }

  if (
    evidence.cursorInsertionRequired &&
    evidence.cursorInsertionReady === null
  ) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm text insertion access.",
        "retry",
      ),
    );
  }

  return ready(domain);
}

function meetingsAssessment(
  evidence: ProductReadinessEvidence,
): ReadinessAssessment {
  const domain: ReadinessDomain = "meetings";
  const unavailable = unavailableEvidence(domain, evidence);
  if (unavailable) {
    return unavailable;
  }

  const microphone = microphoneAssessment(domain, evidence);
  if (microphone) {
    return microphone;
  }

  if (evidence.meetingRouteReady === false) {
    return assessment(
      domain,
      "blocked",
      cause(
        "meeting_route",
        evidence.meetingRouteReason ??
          "The selected meeting engine is not ready.",
        "open_models",
      ),
    );
  }

  if (evidence.meetingRouteReady === null) {
    return assessment(
      domain,
      "unknown",
      cause(
        "source_unavailable",
        "Plainsong could not confirm the meeting engine.",
        "retry",
      ),
    );
  }

  return ready(domain);
}

function fullCaptureAssessment(
  meetings: ReadinessAssessment,
  evidence: ProductReadinessEvidence,
): ReadinessAssessment {
  const domain: ReadinessDomain = "full_capture";
  if (meetings.state !== "ready") {
    return withDomain(meetings, domain);
  }

  switch (evidence.systemAudioState) {
    case "ready":
      return ready(domain);
    case "unverified":
      return assessment(
        domain,
        "degraded",
        cause(
          "system_audio_unverified",
          "Mic-only meetings are ready. Test system audio before recording everyone on the call.",
          "test_system_audio",
        ),
      );
    case "unavailable":
      return assessment(
        domain,
        "degraded",
        cause(
          "system_audio_unavailable",
          "Mic-only meetings are ready, but system audio is not configured.",
          "configure_system_audio",
        ),
      );
    case "unknown":
      return assessment(
        domain,
        "unknown",
        cause(
          "source_unavailable",
          "Plainsong could not confirm the system-audio route.",
          "retry",
        ),
      );
  }
}

const STATE_PRIORITY: Record<ReadinessState, number> = {
  ready: 0,
  degraded: 1,
  unknown: 2,
  needs_action: 3,
  blocked: 4,
};

function overallAssessment(
  assessments: readonly ReadinessAssessment[],
): ReadinessAssessment {
  const mostSevere = assessments.reduce((current, candidate) =>
    STATE_PRIORITY[candidate.state] > STATE_PRIORITY[current.state]
      ? candidate
      : current,
  );
  return withDomain(mostSevere, "overall");
}

export function buildProductReadinessSnapshot(
  evidence: ProductReadinessEvidence,
): ProductReadinessSnapshot {
  const dictation = dictationAssessment(evidence);
  const meetings = meetingsAssessment(evidence);
  const fullCapture = fullCaptureAssessment(meetings, evidence);
  const overall = overallAssessment([dictation, meetings, fullCapture]);

  return {
    evidenceObservedAt: evidence.observedAt,
    dictation,
    meetings,
    fullCapture,
    overall,
  };
}

export function updateProductReadinessSnapshot(
  current: ProductReadinessSnapshot,
  evidence: ProductReadinessEvidence,
): ProductReadinessSnapshot {
  if (evidence.observedAt < current.evidenceObservedAt) {
    return current;
  }

  return buildProductReadinessSnapshot(evidence);
}

export function selectReadinessForSurface(
  snapshot: ProductReadinessSnapshot,
  surface: ReadinessSurface,
): ReadinessAssessment {
  if (surface === "dictation") {
    return snapshot.dictation;
  }
  if (surface === "meetings") {
    return snapshot.meetings;
  }
  if (surface === "models") {
    if (snapshot.dictation.cause?.id === "dictation_route") {
      return snapshot.dictation;
    }
    if (snapshot.meetings.cause?.id === "meeting_route") {
      return snapshot.meetings;
    }
  }

  return snapshot.overall;
}
