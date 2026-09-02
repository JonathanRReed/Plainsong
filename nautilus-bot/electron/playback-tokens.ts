/**
 * The main-process half of in-app audio playback.
 *
 * The sidecar prepares a recording for playback and answers with a token and
 * a filesystem path. The path stops here: it is kept in this map and the
 * renderer is handed only the token, which it turns into
 * `plainsong://playback/<token>`. The protocol handler resolves the token
 * back to the path at request time. A renderer that never sees a path cannot
 * ask for one it should not have, and a token it did not receive from a
 * successful prepare resolves to nothing.
 *
 * Pure so it can be unit-tested; main.ts owns the single live instance.
 */

/** 32 lowercase hex characters: the sidecar's `PlaybackRegistry::new_token`. */
export const PLAYBACK_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export type PlaybackProtection = "plaintext" | "decrypted";

export interface PlaybackEntry {
  path: string;
  recordingId: string;
  protection: PlaybackProtection;
}

/** What the sidecar answers to `prepare_recording_playback`. */
export interface PreparedPlayback extends PlaybackEntry {
  token: string;
  durationSeconds: number;
}

export function isPlaybackToken(value: unknown): value is string {
  return typeof value === "string" && PLAYBACK_TOKEN_PATTERN.test(value);
}

/**
 * Validate the sidecar's answer before trusting any field of it. The sidecar
 * is ours, but the shape is checked anyway: a malformed answer must fail here,
 * where it is one clear error, rather than as an undefined path handed to the
 * protocol handler later.
 */
export function parsePreparedPlayback(value: unknown): PreparedPlayback {
  if (!value || typeof value !== "object") {
    throw new Error("Playback preparation returned no result");
  }
  const raw = value as Record<string, unknown>;
  if (!isPlaybackToken(raw.token)) {
    throw new Error("Playback preparation returned an invalid token");
  }
  if (typeof raw.path !== "string" || raw.path.length === 0 || raw.path.includes("\0")) {
    throw new Error("Playback preparation returned an invalid path");
  }
  if (typeof raw.recordingId !== "string" || raw.recordingId.length === 0) {
    throw new Error("Playback preparation returned no recording id");
  }
  if (raw.protection !== "plaintext" && raw.protection !== "decrypted") {
    throw new Error("Playback preparation returned an unknown protection level");
  }
  const durationSeconds =
    typeof raw.durationSeconds === "number" && Number.isFinite(raw.durationSeconds)
      ? Math.max(0, raw.durationSeconds)
      : 0;
  return {
    token: raw.token,
    path: raw.path,
    recordingId: raw.recordingId,
    protection: raw.protection,
    durationSeconds,
  };
}

export class PlaybackTokenMap {
  private readonly entries = new Map<string, PlaybackEntry>();

  register(token: string, entry: PlaybackEntry): void {
    if (!isPlaybackToken(token)) {
      throw new Error("Refusing to register a malformed playback token");
    }
    if (this.entries.has(token)) {
      throw new Error("Playback token is already registered");
    }
    this.entries.set(token, { ...entry });
  }

  /** The entry for a token, or null for anything unknown or malformed. */
  resolve(token: unknown): PlaybackEntry | null {
    if (!isPlaybackToken(token)) {
      return null;
    }
    const entry = this.entries.get(token);
    return entry ? { ...entry } : null;
  }

  /** Forget a token. Returns what was registered, or null if nothing was. */
  release(token: unknown): PlaybackEntry | null {
    if (!isPlaybackToken(token)) {
      return null;
    }
    const entry = this.entries.get(token);
    if (!entry) {
      return null;
    }
    this.entries.delete(token);
    return entry;
  }

  /** Forget every token, returning them so their sidecar side can be released. */
  drain(): Array<{ token: string; entry: PlaybackEntry }> {
    const drained = [...this.entries.entries()].map(([token, entry]) => ({ token, entry }));
    this.entries.clear();
    return drained;
  }

  get size(): number {
    return this.entries.size;
  }
}
