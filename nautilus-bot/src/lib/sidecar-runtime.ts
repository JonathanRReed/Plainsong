/**
 * The renderer half of the sidecar-lifecycle notification.
 *
 * What users were shown when the transcription engine died was the Electron
 * bridge's own log line — "Sidecar process exited (code=1, signal=null)" —
 * and only on the Setup view, which nobody is looking at while they dictate.
 * The bridge now sends a typed `reason`; this maps it to something a person can
 * read, and keeps the raw line out of the UI entirely.
 */

export const SIDECAR_RUNTIME_EVENT = "sidecar-runtime-changed";

export type SidecarExitReason =
  | "crash"
  | "killed"
  | "spawn_failed"
  | "unresponsive";

const REASONS: readonly SidecarExitReason[] = [
  "crash",
  "killed",
  "spawn_failed",
  "unresponsive",
];

export interface SidecarRuntimeEvent {
  ready: boolean;
  /** The typed reason, when the bridge sent one. */
  reason: SidecarExitReason | null;
  /** The bridge's own wording. Kept for logs; never rendered. */
  detail: string | null;
}

function readReason(value: unknown): SidecarExitReason | null {
  return typeof value === "string" && REASONS.includes(value as SidecarExitReason)
    ? (value as SidecarExitReason)
    : null;
}

/**
 * Read one lifecycle payload.
 *
 * `reason` is where the bridge puts the typed value; the same key used to hold
 * a free-form sentence, and older builds still send that. A string that is not
 * one of the four codes is therefore treated as detail, not as a reason — which
 * is also what keeps this working before the bridge half lands.
 */
export function parseSidecarRuntimeEvent(
  payload: unknown,
): SidecarRuntimeEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.ready !== "boolean") {
    return null;
  }

  const typedReason = readReason(record.reason) ?? readReason(record.code);
  const detailCandidates = [record.message, record.detail, record.reason];
  let detail: string | null = null;
  for (const candidate of detailCandidates) {
    if (typeof candidate === "string" && candidate.trim() && candidate !== typedReason) {
      detail = candidate.trim();
      break;
    }
  }

  return { ready: record.ready, reason: typedReason, detail };
}

export interface SidecarLossNotice {
  title: string;
  message: string;
  /** True while Plainsong is bringing it back on its own. */
  recovering: boolean;
}

const LOSS_COPY: Record<SidecarExitReason, SidecarLossNotice> = {
  crash: {
    title: "The local transcription engine stopped",
    message:
      "Plainsong is restarting it now. Dictation and meeting capture will not record until it answers.",
    recovering: true,
  },
  killed: {
    title: "The local transcription engine was shut down",
    message:
      "Plainsong is restarting it now. Dictation and meeting capture will not record until it answers.",
    recovering: true,
  },
  unresponsive: {
    title: "The local transcription engine stopped answering",
    message:
      "Plainsong is restarting it now. Dictation and meeting capture will not record until it answers.",
    recovering: true,
  },
  spawn_failed: {
    title: "The local transcription engine could not start",
    message:
      "Nothing can be transcribed until it does. Restarting Plainsong is the next thing to try.",
    recovering: false,
  },
};

const UNKNOWN_LOSS: SidecarLossNotice = {
  title: "The local transcription engine stopped",
  message:
    "Plainsong is restarting it now. Dictation and meeting capture will not record until it answers.",
  recovering: true,
};

/** Human copy for a lost engine. Never the bridge's log line. */
export function describeSidecarLoss(
  reason: SidecarExitReason | null,
): SidecarLossNotice {
  return reason ? LOSS_COPY[reason] : UNKNOWN_LOSS;
}
