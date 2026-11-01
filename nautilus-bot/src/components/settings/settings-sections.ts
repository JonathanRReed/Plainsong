import {
  Cpu,
  FileSearch,
  Keyboard,
  Mic,
  Settings2,
  Shield,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SettingsSectionId } from "@/lib/navigation";

/**
 * The Settings sections, in the order the reader sees them: the everyday
 * choices first, the tools almost nobody needs last. Each is named by what
 * you came to do, and each summary says what you will find, in the words the
 * section itself uses.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  summary: string;
  icon: LucideIcon;
}> = [
  {
    id: "general",
    label: "General",
    summary: "Appearance, your microphone and language, and updates.",
    icon: Settings2,
  },
  {
    id: "dictation",
    label: "Dictation",
    summary: "What you see and hear while you dictate, and how your words are cleaned up.",
    icon: Mic,
  },
  {
    id: "meetings",
    label: "Meetings",
    summary: "What gets recorded, how speakers are told apart, and what happens afterwards.",
    icon: Users,
  },
  {
    id: "models",
    label: "Models",
    summary: "The speech model that hears you and the AI that writes for you.",
    icon: Cpu,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    summary: "Keys and mouse buttons that work in any app. Click a shortcut and press the new keys; it saves right away.",
    icon: Keyboard,
  },
  {
    id: "ai",
    label: "Search & AI",
    summary: "API keys, saved prompts, and how Ask finds passages.",
    icon: FileSearch,
  },
  {
    id: "privacy",
    label: "Privacy & data",
    summary: "What may leave this Mac, what macOS allows, and what Plainsong keeps.",
    icon: Shield,
  },
  {
    id: "advanced",
    label: "Advanced",
    summary: "Diagnostics and tools for when something needs a closer look.",
    icon: SlidersHorizontal,
  },
];

export function settingsSectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

/** One searchable row: where it lives, what it is called, other words for it. */
export interface SettingsIndexEntry {
  /** The row's anchor (`setting-<id>` in the DOM). */
  id: string;
  section: SettingsSectionId;
  label: string;
  keywords?: string;
  /**
   * The row only renders in some states (calendar access granted, a model
   * picked that needs it). Search still lists it; the section opens either way.
   */
  conditional?: boolean;
  /** No anchor of its own: search opens the section. */
  sectionOnly?: boolean;
}

/**
 * Every setting, by the name it carries on screen. This is what settings
 * search reads, and what `settings-view-simple.test.tsx` walks to prove each
 * one is still reachable after a reorganization.
 */
export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  // General
  { id: "appearance", section: "general", label: "Appearance", keywords: "theme dark light mode system colour color" },
  { id: "menu-bar", section: "general", label: "Keep running in the menu bar", keywords: "close window tray minimize background quit" },
  { id: "always-on-top", section: "general", label: "Keep the window on top", keywords: "float above other apps always on top" },
  { id: "microphone", section: "general", label: "Microphone", keywords: "input device mic audio headset bluetooth" },
  { id: "microphone-test", section: "general", label: "Test your microphone", keywords: "level playback hear check mic" },
  { id: "microphone-overrides", section: "general", label: "Different microphones for dictation and meetings", keywords: "override input device per activity" },
  { id: "language", section: "general", label: "Language you speak", keywords: "transcription language auto-detect english spanish" },
  { id: "dictation-languages", section: "general", label: "Languages you dictate in", keywords: "auto-detect narrow language list", conditional: true },
  { id: "updates", section: "general", label: "Updates", keywords: "check version new release install" },
  { id: "beta-updates", section: "general", label: "Beta updates", keywords: "channel early release feed" },
  { id: "setup", section: "general", label: "Setup guide", keywords: "onboarding run setup again permissions walkthrough" },
  // Dictation
  { id: "dictation-pill", section: "dictation", label: "Show the dictation pill", keywords: "mini window popup overlay floating" },
  { id: "pill-size", section: "dictation", label: "Pill size", keywords: "dictation pill bigger smaller" },
  { id: "pill-position", section: "dictation", label: "Pill position", keywords: "dock edge bottom left right" },
  { id: "dictation-sounds", section: "dictation", label: "Dictation sounds", keywords: "tick pop tone audio feedback earcon" },
  { id: "mute-media", section: "dictation", label: "Mute other audio while dictating", keywords: "music calls silence output" },
  { id: "dictation-failure-notifications", section: "dictation", label: "Notify me when a dictation fails", keywords: "notification error insert failed" },
  { id: "remove-fillers", section: "dictation", label: "Remove filler words", keywords: "um uh disfluencies repeated words corrections" },
  { id: "ai-cleanup", section: "dictation", label: "AI cleanup", keywords: "smart format grammar punctuation tidy rewrite" },
  { id: "nearby-spelling", section: "dictation", label: "Spell names from nearby text", keywords: "names identifiers screen context spelling accessibility" },
  { id: "calendar-names", section: "dictation", label: "Spell names from calendar", keywords: "names attendees organizer spelling calendar contacts", conditional: true },
  { id: "contact-names", section: "dictation", label: "Spell names from Contacts", keywords: "names people address book spelling", conditional: true },
  { id: "match-surrounding", section: "dictation", label: "Match surrounding text", keywords: "spacing lowercase capitalisation names context" },
  { id: "translate", section: "dictation", label: "Translate to English", keywords: "translation language" },
  { id: "copy-to-clipboard", section: "dictation", label: "Also copy to the clipboard", keywords: "paste clipboard copy" },
  { id: "spoken-commands", section: "dictation", label: "Spoken commands", keywords: "voice commands undo command mode" },
  { id: "command-word", section: "dictation", label: "Command word", keywords: "spoken command prefix trigger word" },
  { id: "snippets", section: "dictation", label: "Snippets", keywords: "abbreviations expand text replacement" },
  { id: "learn-in-plainsong", section: "dictation", label: "Suggest corrections from edits in Plainsong", keywords: "dictionary learn corrections word list" },
  { id: "learn-other-apps", section: "dictation", label: "Learn from corrections in other apps", keywords: "dictionary learn corrections external" },
  { id: "cleanup-instructions", section: "dictation", label: "Your own AI cleanup instructions", keywords: "prompt custom instructions smart format" },
  { id: "dictation-page", section: "dictation", label: "Word list, snippets and profiles", keywords: "vocabulary dictionary profiles open dictation" },
  { id: "fix-dictation", section: "dictation", label: "Fix dictation setup", keywords: "repair permissions onboarding" },
  // Meetings
  { id: "system-audio", section: "meetings", label: "Mac audio", keywords: "meeting audio system audio other side of the call headphones permission check speakers loopback blackhole" },
  { id: "call-detection", section: "meetings", label: "Offer to record calls", keywords: "zoom teams meet detect call" },
  { id: "meeting-window", section: "meetings", label: "Show the meeting window", keywords: "mini window popup recording overlay" },
  { id: "meeting-notifications", section: "meetings", label: "Meeting notifications", keywords: "notification started stopped ready" },
  { id: "calendar", section: "meetings", label: "Calendar", keywords: "calendar events suggest meetings", conditional: true },
  { id: "speakers", section: "meetings", label: "Tell speakers apart", keywords: "diarization speaker labels who spoke" },
  { id: "speaker-model", section: "meetings", label: "Speaker model", keywords: "diarization model download" },
  { id: "remembered-voices", section: "meetings", label: "Remembered voices", keywords: "remember voices voice signature recognize speakers names forget" },
  { id: "auto-summary", section: "meetings", label: "Summarize every meeting automatically", keywords: "summary notes action items analysis" },
  { id: "auto-name", section: "meetings", label: "Name meetings for me", keywords: "title automatic name" },
  { id: "stop-on-call-quit", section: "meetings", label: "Stop when the call app quits", keywords: "auto stop end meeting" },
  { id: "stop-after-silence", section: "meetings", label: "Stop after minutes of silence", keywords: "auto stop quiet timeout" },
  { id: "max-length", section: "meetings", label: "Longest meeting", keywords: "maximum length limit minutes" },
  { id: "cloud-speakers", section: "meetings", label: "Keep speaker labels from cloud services", keywords: "deepgram gemini diarization" },
  { id: "title-model", section: "meetings", label: "AI model for meeting titles", keywords: "title model name" },
  { id: "summary-instructions", section: "meetings", label: "Your own summary instructions", keywords: "prompt custom summary" },
  { id: "setup-meetings", section: "meetings", label: "Set up meetings", keywords: "onboarding guide" },
  // Models
  { id: "speech-models", section: "models", label: "Speech model", keywords: "transcription whisper parakeet download dictation meetings preset", sectionOnly: true },
  { id: "ai-cleanup-model", section: "models", label: "Who cleans up dictation", keywords: "ai cleanup model ollama openai built-in text model", sectionOnly: true },
  { id: "model-presets", section: "models", label: "Start from a preset", keywords: "preset recommended light widest languages largest models" },
  { id: "summary-model", section: "models", label: "Who writes summaries", keywords: "summary model ollama openai anthropic chatgpt", sectionOnly: true },
  // Shortcuts
  { id: "shortcut-behavior", section: "shortcuts", label: "How the dictation shortcut works", keywords: "hold push to talk toggle hands-free tap lock" },
  { id: "dictation-bindings", section: "shortcuts", label: "Dictation shortcuts", keywords: "binding hotkey key mouse button fn profile" },
  { id: "other-shortcuts", section: "shortcuts", label: "Paste last result, copy last result, open window", keywords: "repaste recopy window hotkey" },
  // Search & AI
  { id: "ai-writers", section: "ai", label: "Who writes for you", keywords: "summary cleanup service" },
  { id: "api-keys", section: "ai", label: "API keys", keywords: "openai anthropic gemini deepseek deepgram mistral elevenlabs groq cohere key keychain" },
  { id: "cloud-check", section: "ai", label: "Check cloud setup", keywords: "cloud readiness key missing" },
  { id: "saved-prompts", section: "ai", label: "Saved prompts", keywords: "prompt library slash" },
  { id: "search", section: "ai", label: "How Ask finds passages", keywords: "search recording meaning search model embedding index memory" },
  // Privacy & data
  { id: "cloud-ai", section: "privacy", label: "Allow cloud AI processing", keywords: "remote cloud privacy send openai" },
  { id: "permissions", section: "privacy", label: "macOS permissions", keywords: "accessibility microphone speech recognition system settings repair text insertion" },
  { id: "ask-permissions", section: "privacy", label: "Ask macOS for permission when needed", keywords: "prompt permission request" },
  { id: "retention", section: "privacy", label: "Auto-delete dictations", keywords: "retention delete history keep" },
  { id: "meeting-audio", section: "privacy", label: "Meeting audio", keywords: "keep delete audio file storage" },
  { id: "meeting-retention", section: "privacy", label: "Delete meeting audio after", keywords: "retention delete weeks months storage compression prune" },
  { id: "meeting-delete-mode", section: "privacy", label: "What auto-delete removes", keywords: "transcript audio retention" },
  { id: "export-folder", section: "privacy", label: "Export folder", keywords: "exports location folder" },
  { id: "backups", section: "privacy", label: "Backups", keywords: "backup restore snapshot cloud rclone icloud onedrive google drive" },
  { id: "encryption", section: "privacy", label: "Encryption", keywords: "vault password encrypt lock unlock" },
  { id: "reset", section: "privacy", label: "Reset everything on this device", keywords: "erase delete all start over factory" },
  // Advanced
  { id: "speech-diagnostics", section: "advanced", label: "Speech model status and diagnostics", keywords: "benchmark repair downloads readiness" },
  { id: "speech-detection", section: "advanced", label: "Skip silence", keywords: "speech detection silero loudness quiet" },
  { id: "local-tools", section: "advanced", label: "Command line and MCP access", keywords: "cli terminal plainsong command mcp assistant links" },
  { id: "support-bundle", section: "advanced", label: "Diagnostics bundle", keywords: "logs support report bug" },
];

/** Index entries matching every word of the query, best label matches first. */
export function searchSettings(query: string): SettingsIndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ entry: SettingsIndexEntry; score: number }> = [];
  for (const entry of SETTINGS_INDEX) {
    const label = entry.label.toLowerCase();
    const haystack = `${label} ${entry.keywords ?? ""} ${settingsSectionLabel(entry.section)}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    const score = words.reduce(
      (total, word) => total + (label.startsWith(word) ? 3 : label.includes(word) ? 2 : 0),
      0,
    );
    scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}
