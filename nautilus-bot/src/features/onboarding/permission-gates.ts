import type { CalendarAuthorization } from "@/lib/calendar-events";
import type {
  PermissionDiagnostics,
  PermissionSettingsSection,
} from "@/lib/backend/settings";
import type { SystemAudioCapability } from "@/lib/backend/recordings";

/**
 * Every macOS permission Plainsong asks for, in one place, each with the
 * sentence that says what it is for and the sentence that says what stops
 * working without it.
 *
 * The reader who hit this wrote that they "had to find and grant every
 * permission themselves". A list of switch names would not have helped them;
 * knowing which feature dies without each one would have. So `consequence` is
 * not optional here — a row without one is a demand, not an explanation.
 *
 * Kept out of the wizard component so the copy can be asserted in a test and
 * reused by any other surface that needs the same list.
 */

export type PermissionGateKey =
  | "microphone"
  | "accessibility"
  | "keyboard_fallback"
  | "system_audio"
  | "speech"
  | "calendar"
  | "notifications";

/** Where a row's fix button goes. */
export type PermissionGateDestination =
  | { kind: "settings_pane"; section: PermissionSettingsSection }
  /** Calendar has its own gesture-gated command; see `openCalendarPrivacySettings`. */
  | { kind: "calendar_pane" };

/**
 * What the renderer has observed. Every field is nullable: an unanswered probe
 * is "not observed", which a row must never render as "denied".
 */
export interface PermissionGateObservations {
  permissions: PermissionDiagnostics | null;
  systemAudio: SystemAudioCapability | null;
  calendarAuthorization: CalendarAuthorization | null;
}

export interface PermissionGate {
  key: PermissionGateKey;
  label: string;
  /** What Plainsong does with the grant. One sentence, present tense. */
  purpose: string;
  /** What stops working without it. One sentence. Never a threat. */
  consequence: string;
  /** The macOS switch this row is about, by the name macOS gives it. */
  settingsLabel: string;
  destination: PermissionGateDestination;
  /**
   * True when the feature this unlocks is one Plainsong offers rather than one
   * it needs. An optional row is never drawn as an error.
   */
  optional: boolean;
  /**
   * `undefined` means Plainsong cannot see the answer — not that it is denied.
   * `readableState` says whether that is expected.
   */
  ready(observations: PermissionGateObservations): boolean | undefined;
  /**
   * False for a grant macOS gives Plainsong no way to read. The row then says
   * so instead of showing a state it made up.
   */
  observable: boolean;
}

/**
 * Ordered the way the reader meets them: the two that dictation cannot work
 * without, then the ones that unlock a specific feature.
 */
export const PERMISSION_GATES: PermissionGate[] = [
  {
    key: "microphone",
    label: "Microphone",
    purpose: "Plainsong hears what you say, on this Mac.",
    consequence:
      "Without it nothing can be dictated or recorded — this is the one permission everything else depends on.",
    settingsLabel: "Microphone",
    destination: { kind: "settings_pane", section: "microphone" },
    optional: false,
    observable: true,
    ready: ({ permissions }) =>
      permissions?.microphonePermissionReady ?? permissions?.microphoneReady,
  },
  {
    key: "accessibility",
    label: "Accessibility",
    purpose:
      "Plainsong puts your dictated words into whatever app you are typing in.",
    consequence:
      "Without it dictation still transcribes, but the words can only be copied to the clipboard for you to paste.",
    settingsLabel: "Accessibility",
    destination: { kind: "settings_pane", section: "accessibility" },
    optional: false,
    observable: true,
    ready: ({ permissions }) => permissions?.accessibilityReady,
  },
  {
    key: "keyboard_fallback",
    label: "Keyboard fallback",
    purpose:
      "Plainsong types the words in when an app refuses direct insertion.",
    consequence:
      "Without it dictation into apps that reject direct insertion falls back to copying instead of typing. It is granted from the same Accessibility list as the row above.",
    settingsLabel: "Accessibility",
    destination: { kind: "settings_pane", section: "accessibility" },
    optional: false,
    observable: true,
    // Tracked by CGPreflightPostEventAccess, which is a separate grant from
    // AXIsProcessTrusted even though both are switched on in the same pane.
    ready: ({ permissions }) => permissions?.postEventReady,
  },
  {
    key: "system_audio",
    label: "Screen & System Audio",
    purpose:
      "Meetings capture the other side of a call — what comes out of your speakers.",
    consequence:
      "Without it meetings still record, from your microphone only, so the people on the call are not in the transcript.",
    settingsLabel: "Screen & System Audio Recording",
    destination: { kind: "settings_pane", section: "system_audio" },
    optional: true,
    observable: true,
    ready: ({ systemAudio }) =>
      systemAudio ? systemAudio.backend !== "none" && systemAudio.ready : undefined,
  },
  {
    key: "speech",
    label: "Speech Recognition",
    purpose:
      "Records your consent to macOS transcribing on this Mac, for the Apple Speech route only. Nothing is sent to Apple: both engines run here with the server fallback switched off.",
    consequence:
      "Without it the Apple Speech route refuses to transcribe. Every other dictation route is unaffected, and Plainsong never falls back to this one on its own.",
    settingsLabel: "Speech Recognition",
    destination: { kind: "settings_pane", section: "speech" },
    optional: true,
    observable: true,
    ready: ({ permissions }) => permissions?.speechRecognitionReady,
  },
  {
    key: "calendar",
    label: "Calendar",
    purpose:
      "Meetings reads what is on your calendar so a recording arrives already named, with its attendees.",
    consequence:
      "Without it nothing is read from Calendar and you name meetings yourself. Nothing is sent anywhere either way.",
    settingsLabel: "Calendars",
    destination: { kind: "calendar_pane" },
    optional: true,
    observable: true,
    ready: ({ calendarAuthorization }) =>
      calendarAuthorization === null || calendarAuthorization === "unknown"
        ? undefined
        : calendarAuthorization === "authorized",
  },
  {
    key: "notifications",
    label: "Notifications",
    purpose:
      "Plainsong tells you a call started, or that a long transcription finished, while you are in another app.",
    consequence:
      "Without it those messages appear only inside Plainsong's own windows; nothing is lost, you just have to be looking.",
    settingsLabel: "Notifications",
    destination: { kind: "settings_pane", section: "notifications" },
    optional: true,
    // macOS answers this the first time Plainsong shows a notification, and
    // gives the app no way to read the answer back. Saying "not granted" here
    // would be a guess; the row says it cannot tell instead.
    observable: false,
    ready: () => undefined,
  },
];
