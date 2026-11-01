import { appReceiptMatchesBinding } from "./app-receipt-binding.ts";

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
  return Object.fromEntries(Object.entries(input));
}

/** Converts the measured microphone portion, without accepting the footprint gate. */
export function microphoneReceiptFromFootprint({ footprint, capture, appBundleSha256 }: {
  footprint: unknown; capture: unknown; appBundleSha256: string;
}) {
  const raw = object(footprint);
  const frame = object(capture);
  const binding = object(frame.binding);
  if (!appReceiptMatchesBinding(raw, { appBundleSha256 }) || binding.appBundleSha256 !== appBundleSha256) {
    throw new Error("Raw capture does not match the unchanged candidate app");
  }
  const meeting = object(raw.meeting);
  const overlay = object(frame.overlay);
  const microphone = object(overlay.microphoneInput);
  const states: unknown[] = Array.isArray(raw.states) ? raw.states : [];
  const measuredMeeting = states.map(object).find((state) => state.state === "meeting");
  const checks = {
    captureBeforeStop: frame.phase === "before-meeting-stop",
    recordingIdentity: typeof frame.recordingId === "string" && frame.recordingId.length > 0 &&
      overlay.recordingId === frame.recordingId,
    enteredRecording: overlay.phase === "recording" && meeting.overlayPhase === "recording",
    microphoneResolved: typeof raw.fixtureDevice === "string" && raw.fixtureDevice.length > 0 &&
      microphone.requestedName === raw.fixtureDevice && microphone.resolvedName === raw.fixtureDevice &&
      microphone.usedFallback === false,
    microphoneIncluded: meeting.captureMode === "me_and_them" || meeting.captureMode === "mic_only",
    liveTranscription: typeof meeting.liveEvents === "number" && meeting.liveEvents > 0 &&
      typeof frame.liveEvents === "number" && frame.liveEvents > 0,
    transcriptCompleted: meeting.status === "completed" &&
      typeof meeting.transcriptChars === "number" && meeting.transcriptChars > 0 &&
      typeof meeting.fixtureCoverage === "number" && meeting.fixtureCoverage >= 0.8,
    captureExercised: measuredMeeting?.exercised === true &&
      typeof measuredMeeting.samples === "number" && measuredMeeting.samples > 0,
    noCaptureError: raw.error === null,
  };
  return {
    schemaVersion: 1, generatedAt: raw.generatedAt,
    pass: Object.values(checks).every(Boolean), checks,
    candidateIdentity: raw.candidateIdentity, candidateAppUnchanged: true,
    recordingId: frame.recordingId, meeting,
    scope: "Packaged microphone capture through the named virtual input. Does not prove physical microphone quality, known-tone system audio, lifecycle recovery or footprint budgets.",
    measurementPass: raw.pass,
  };
}

export function retainedFootprintReceipt(input: unknown, appBundleSha256: string) {
  if (!appReceiptMatchesBinding(input, { appBundleSha256 })) {
    throw new Error("Raw footprint does not match the unchanged candidate app");
  }
  return object(input);
}
