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
  "check_for_updates",
  "check_system_audio_availability",
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
  // Sits directly in front of a user-initiated capture start: a slow registry
  // write must fail fast rather than delay the meeting behind it.
  "register_capture_admission",
]);

const EXTENDED_COMMANDS = new Set<string>([
  "analyze_recording",
  "analyze_recordings",
  "benchmark_asr_providers",
  "benchmark_asr_providers_bytes",
  "create_backup_default",
  "create_settings_backup_default",
  "download_asr_models",
  "download_diarization_model",
  "download_platform_assets",
  "download_whisper_model",
  "export_backup_archive",
  "export_recording",
  "export_recording_v2",
  "export_with_template",
  "import_dictation_dictionary_csv",
  "install_update",
  "migrate_to_encrypted_storage",
  "refresh_asr_runtime_probes",
  "reindex_embeddings",
  "repair_local_model_cache",
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

export function getCommandWorkKey(command: string, args?: unknown): string | null {
  if (command.startsWith("download_")) {
    const target =
      stringArgument(args, ["modelName", "modelId", "providerType", "assetId"]) ??
      command;
    return `${command}:${target}`;
  }
  if (command === "benchmark_asr_providers" || command === "benchmark_asr_providers_bytes") {
    return "benchmark:active";
  }
  if (ANALYSIS_COMMANDS.has(command)) {
    const target = stringArgument(args, ["runId", "recordingId"]) ?? command;
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
