import type {
  MeetingsSettings,
  NotificationsSettings,
  Settings,
} from "@/types/settings";

/**
 * The two settings sections a sidecar may omit, resolved to what the Rust
 * side defaults them to (rust-sidecar/src/settings.rs). Every reader goes
 * through here so a missing section and a fresh install behave the same, and
 * so the defaults are pinned in exactly one place on this side of the wire.
 */

const DEFAULT_MEETINGS_SETTINGS: MeetingsSettings = {
  callDetectionEnabled: true,
  autoStopWhenCallAppQuits: true,
  autoStopAfterSilenceMinutes: 15,
  preferProviderDiarization: true,
};

const DEFAULT_NOTIFICATIONS_SETTINGS: NotificationsSettings = {
  meetingEvents: true,
  dictationFailures: true,
};

/** Longest silence auto-stop the UI offers, in minutes; mirrors the Rust cap. */
export const MEETING_AUTO_STOP_SILENCE_MINUTES_MAX = 240;

export function resolveMeetingsSettings(
  settings: Pick<Settings, "meetings"> | null | undefined,
): MeetingsSettings {
  const meetings = settings?.meetings;
  const minutes = meetings?.autoStopAfterSilenceMinutes;
  return {
    callDetectionEnabled:
      meetings?.callDetectionEnabled ?? DEFAULT_MEETINGS_SETTINGS.callDetectionEnabled,
    autoStopWhenCallAppQuits:
      meetings?.autoStopWhenCallAppQuits ?? DEFAULT_MEETINGS_SETTINGS.autoStopWhenCallAppQuits,
    autoStopAfterSilenceMinutes:
      typeof minutes === "number" && Number.isFinite(minutes)
        ? Math.min(Math.max(0, Math.round(minutes)), MEETING_AUTO_STOP_SILENCE_MINUTES_MAX)
        : DEFAULT_MEETINGS_SETTINGS.autoStopAfterSilenceMinutes,
    preferProviderDiarization:
      meetings?.preferProviderDiarization ??
      DEFAULT_MEETINGS_SETTINGS.preferProviderDiarization,
  };
}

export function resolveNotificationsSettings(
  settings: Pick<Settings, "notifications"> | null | undefined,
): NotificationsSettings {
  const notifications = settings?.notifications;
  return {
    meetingEvents:
      notifications?.meetingEvents ?? DEFAULT_NOTIFICATIONS_SETTINGS.meetingEvents,
    dictationFailures:
      notifications?.dictationFailures ?? DEFAULT_NOTIFICATIONS_SETTINGS.dictationFailures,
  };
}
