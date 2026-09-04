const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const FAST_COMMAND_TIMEOUT_MS = 15_000;
const LONG_COMMAND_TIMEOUT_MS = 5 * 60_000;
const EXTENDED_COMMAND_TIMEOUT_MS = 15 * 60_000;
const ANALYSIS_COMMAND_TIMEOUT_MS = 50 * 60_000;

const ANALYSIS_COMMANDS = new Set<string>([
  "analyze_recording",
  "analyze_recordings",
  "ask_memory",
  "extract_action_items",
  "extract_action_items_grounded",
  "prepare_meeting_brief",
  // Re-runs the whole meeting analysis pass (summary, action items, title), so
  // it needs the analysis timeout. Membership here also gives it a
  // recordingId-scoped work key, which is what stops a second retry from
  // running concurrently against the same meeting.
  "retry_meeting_analysis",
  "summarize_recording",
  "summarize_recording_grounded",
]);

const FAST_COMMANDS = new Set<string>([
  "acknowledge_incomplete_transcript",
  "cancel_analysis_run",
  // Sets one flag on an in-flight language install; the reader who pressed
  // Cancel is watching the button.
  "cancel_apple_speech_language_install",
  "check_for_updates",
  "check_system_audio_availability",
  // Flips one flag on the call detector; the cue that sent it is waiting to
  // disappear.
  "dismiss_detected_call",
  "get_asr_provider_model",
  "get_available_space",
  "get_backup_config",
  // Spawns a local helper that prints JSON and exits. If that is slow, the Mac
  // is in trouble; the Meetings header should show nothing rather than sit on
  // a pending request.
  "get_calendar_snapshot",
  "get_default_asr_provider",
  "get_dictation_audio_level",
  "get_dictation_overlay_state",
  "get_dictation_shortcut_capability_status",
  "get_loopback_device_name",
  // Reads the detector's in-memory state; the Meetings header polls it.
  "get_meeting_call_status",
  "get_system_audio_capability",
  "get_permission_diagnostics",
  "get_recording_overlay_state",
  "get_security_status",
  "get_settings",
  "get_shortcut_conflicts",
  "get_update_channel",
  "get_update_status",
  "has_provider_secret",
  "is_diarization_model_available",
  "list_audio_input_devices",
  "list_diarization_models",
  // Flip an atomic on the live capture session and record the span. Pause is
  // pressed mid-sentence; a slow answer here reads as a stuck button.
  "pause_meeting_capture",
  "pause_recording",
  // Sits directly in front of a user-initiated capture start: a slow registry
  // write must fail fast rather than delay the meeting behind it.
  "register_capture_admission",
  // One small settings write plus a preflight permission read. It sits in
  // front of the first-run wizard opening or closing, so a slow answer is a
  // visibly stuck launch.
  "record_onboarding_state",
  "resume_meeting_capture",
  "resume_recording",
]);

const EXTENDED_COMMANDS = new Set<string>([
  "analyze_recording",
  "analyze_recordings",
  "benchmark_asr_providers",
  "benchmark_asr_providers_bytes",
  "create_backup_default",
  "create_settings_backup_default",
  "download_asr_models",
  "download_bundled_cleanup_model",
  "download_diarization_model",
  "download_platform_assets",
  "download_whisper_model",
  "export_backup_archive",
  "export_recording",
  "export_recording_v2",
  "export_with_template",
  // Decodes a picked audio file with macOS' converter before it returns; a
  // multi-hour source needs more than the default minute.
  "import_audio_file",
  "import_dictation_dictionary_csv",
  // Asks macOS to download a whole speech language pack. The size is Apple's,
  // not this app's, so it gets the same headroom as a model download.
  "install_apple_speech_language",
  "install_update",
  "migrate_to_encrypted_storage",
  "refresh_asr_runtime_probes",
  "reindex_embeddings",
  "repair_local_model_cache",
  // Re-runs ASR (and possibly an LLM pass) over a saved dictation's kept
  // audio; a ten-minute dictation on a cold model needs the extended budget.
  "reprocess_dictation",
  "restore_backup_default",
  "run_diarization",
  "summarize_recording",
  "summarize_recording_grounded",
  "sync_backup_to_cloud",
]);

const LONG_COMMANDS = new Set<string>([
  "apply_global_shortcuts_now",
  "ask_memory",
  "capture_selected_text_for_playback",
  "extract_action_items",
  "extract_action_items_grounded",
  "force_stop_dictation",
  "open_installed_nautilus_app",
  "open_permission_settings",
  "repair_cursor_insert_permissions",
  "reprocess_dictation_text",
  "request_apple_speech_permission",
  // Decrypts a whole meeting's audio into the runtime directory before the
  // first byte can play; a long, vault-protected meeting on a busy machine
  // takes real time.
  "prepare_recording_playback",
  // Blocks on a macOS permission dialog the reader has to read and answer, so
  // it gets the long timeout every other TCC prompt here gets.
  "request_calendar_access",
  "request_dictation_permissions",
  "reset_app_state",
  "retry_meeting_auto_name",
  // Re-hashes every owned audio file for one meeting; a long meeting's WAV
  // bundle takes real time to read end to end.
  "revalidate_recording_audio",
  "smoke_test_cursor_insert",
  "start_dictation",
  "start_recording",
  "stop_dictation",
  "stop_recording",
  "test_system_audio_capture",
  "unlock_vault",
  "verify_backup_cloud_connection",
  "verify_dictation_setup",
  "verify_meeting_setup",
  "verify_system_audio_setup",
]);

export function getCommandTimeoutMs(command: string): number {
  if (ANALYSIS_COMMANDS.has(command)) {
    return ANALYSIS_COMMAND_TIMEOUT_MS;
  }
  if (EXTENDED_COMMANDS.has(command)) {
    return EXTENDED_COMMAND_TIMEOUT_MS;
  }
  if (LONG_COMMANDS.has(command)) {
    return LONG_COMMAND_TIMEOUT_MS;
  }
  if (FAST_COMMANDS.has(command)) {
    return FAST_COMMAND_TIMEOUT_MS;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

function stringArgument(args: unknown, names: string[]): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function canonicalLocaleWorkKey(locale: string): string {
  return locale.toLowerCase().replace(/-/g, "_");
}

export function getCommandWorkKey(command: string, args?: unknown): string | null {
  if (command === "install_apple_speech_language") {
    const locale = stringArgument(args, ["locale"]) ?? command;
    return `${command}:${canonicalLocaleWorkKey(locale)}`;
  }
  if (command.startsWith("download_")) {
    const target =
      stringArgument(args, ["modelName", "modelId", "providerType", "assetId"]) ??
      command;
    return `${command}:${target}`;
  }
  if (command === "benchmark_asr_providers" || command === "benchmark_asr_providers_bytes") {
    return "benchmark:active";
  }
  if (command === "reprocess_dictation") {
    // One re-run per saved dictation at a time; a second click on the same
    // entry is refused instead of queued behind the first.
    return `reprocess_dictation:${stringArgument(args, ["historyId"]) ?? command}`;
  }
  if (ANALYSIS_COMMANDS.has(command)) {
    const target = stringArgument(args, ["runId", "recordingId", "eventId"]) ?? command;
    return `${command}:${target}`;
  }
  if (
    command === "create_backup_default" ||
    command === "create_settings_backup_default" ||
    command === "restore_backup_default" ||
    command === "sync_backup_to_cloud"
  ) {
    return `backup:${stringArgument(args, ["backupId"]) ?? command}`;
  }
  return null;
}
