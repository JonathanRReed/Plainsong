import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { randomUUID } from "crypto";
import { getCommandTimeoutMs } from "./ipc-command-policy";
import { buildSidecarEnv } from "./sidecar-env";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: { event: string; payload: unknown };
}

type PendingRequest = {
  command: string;
  args?: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type EventCallback = (eventName: string, payload: unknown) => void;
type WindowCommandCallback = (command: string, payload: unknown) => void;
type CommandResolvedCallback = (command: string, args: unknown, result: unknown) => void;
type TerminatedCallback = (reason: string) => void;
type LocalCommandResult = { handled: boolean; result?: unknown };
type LocalCommandCallback = (
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown
) => Promise<LocalCommandResult> | LocalCommandResult;

// Renderer-initiated commands must be explicitly approved here.
const ALLOWED_RENDERER_COMMANDS = new Set<string>([
  "__emit__",
  "__window_hide__",
  "__window_set_position__",
  "__window_set_size__",
  "__window_show__",
  "__window_start_drag__",
  "analyze_recording",
  "analyze_recordings",
  "apply_global_shortcuts_now",
  "approve_dictation_correction_suggestion",
  "ask_memory",
  "benchmark_asr_providers",
  "benchmark_asr_providers_bytes",
  "capture_selected_text_for_playback",
  "check_for_updates",
  "check_system_audio_availability",
  "clear_provider_secret",
  "create_backup_default",
  "create_dictation_dictionary_entry",
  "create_dictation_snippet",
  "create_project",
  "create_settings_backup_default",
  "delete_dictation_command_preset",
  "delete_dictation_dictionary_entry",
  "delete_dictation_snippet",
  "delete_model",
  "delete_project",
  "delete_recording",
  "delete_transcript_segments",
  "dismiss_dictation_overlay",
  "dismiss_recording_overlay",
  "download_asr_models",
  "download_diarization_model",
  "download_platform_assets",
  "download_silero_vad_model",
  "download_whisper_model",
  "export_backup_archive",
  "export_dictation_dictionary_csv",
  "export_recording",
  "export_recording_v2",
  "export_with_template",
  "extract_action_items",
  "extract_action_items_grounded",
  "force_stop_dictation",
  "get_asr_provider_inventory",
  "get_asr_provider_model",
  "get_asr_provider_model_options",
  "get_asr_providers",
  "get_asr_runtime_diagnostics",
  "get_audit_log",
  "get_available_space",
  "get_backup_config",
  "get_backup_setup_report",
  "get_default_asr_provider",
  "get_dictation_audio_level",
  "get_dictation_history_details",
  "get_dictation_insights",
  "get_dictation_overlay_state",
  "get_dictation_shortcut_capability_status",
  "get_embedding_status",
  "get_loopback_device_name",
  "get_meeting_chat_messages",
  "get_meeting_consent_automation_status",
  "get_meeting_transcript_details",
  "get_ollama_status",
  "get_permission_diagnostics",
  "get_projects",
  "get_recording",
  "get_recording_overlay_state",
  "get_recording_waveform",
  "get_recordings",
  "get_relationship_memory",
  "get_security_status",
  "get_settings",
  "get_shortcut_conflicts",
  "get_speakers",
  "get_transcript",
  "get_update_channel",
  "get_update_status",
  "get_waveform_data",
  "has_provider_secret",
  "import_dictation_dictionary_csv",
  "install_update",
  "is_diarization_model_available",
  "is_silero_vad_model_downloaded",
  "learn_dictation_correction",
  "list_anthropic_models",
  "list_asr_benchmarks",
  "list_audio_input_devices",
  "list_backups",
  "list_deepseek_models",
  "list_diarization_models",
  "list_dictation_command_presets",
  "list_dictation_correction_suggestions",
  "list_dictation_dictionary_entries",
  "list_dictation_snippets",
  "list_downloaded_models",
  "list_elevenlabs_asr_models",
  "list_export_templates",
  "list_gemini_models",
  "list_ollama_cloud_models",
  "list_ollama_models",
  "list_openai_asr_models",
  "list_openai_models",
  "lock_vault",
  "migrate_to_encrypted_storage",
  "open_export_path",
  "open_installed_nautilus_app",
  "open_main_window",
  "open_main_window_to",
  "open_permission_settings",
  "open_recording_audio",
  "queue_dictation_correction_suggestion",
  "refresh_asr_runtime_probes",
  "reindex_embeddings",
  "reject_dictation_correction_suggestion",
  "rename_recording",
  "rename_speaker",
  "repair_cursor_insert_permissions",
  "repair_local_model_cache",
  "reprocess_dictation_text",
  "request_dictation_permissions",
  "reset_app_state",
  "restore_backup_default",
  "retry_meeting_auto_name",
  "run_diarization",
  "save_backup_config",
  "save_settings",
  "search_transcripts",
  "set_asr_provider_model",
  "set_default_asr_provider",
  "set_provider_secret",
  "set_recording_source_type",
  "set_update_channel",
  "smoke_test_cursor_insert",
  "start_dictation",
  "start_recording",
  "stop_dictation",
  "stop_recording",
  "summarize_recording",
  "summarize_recording_grounded",
  "sync_backup_to_cloud",
  "unlock_vault",
  "update_dictation_dictionary_entry",
  "update_dictation_snippet",
  "update_meeting_chat_messages",
  "update_recording_analysis",
  "update_recording_notes",
  "update_recording_template",
  "update_transcript_segment",
  "upsert_dictation_command_preset",
  "verify_backup_cloud_connection",
  "verify_dictation_setup",
  "verify_meeting_setup",
  "verify_system_audio_setup",
]);


export class IpcBridge {
  private sidecarPath: string;
  private process: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventCallback: EventCallback | null = null;
  private windowCommandCallback: WindowCommandCallback | null = null;
  private commandResolvedCallback: CommandResolvedCallback | null = null;
  private localCommandCallback: LocalCommandCallback | null = null;
  private terminatedCallback: TerminatedCallback | null = null;
  private shuttingDown = false;
  private restartAttempts = 0;
  private readonly maxRestarts = 5;

  constructor(sidecarPath: string) {
    this.sidecarPath = sidecarPath;
  }

  onEvent(cb: EventCallback): void {
    this.eventCallback = cb;
  }

  onWindowCommand(cb: WindowCommandCallback): void {
    this.windowCommandCallback = cb;
  }

  onCommandResolved(cb: CommandResolvedCallback): void {
    this.commandResolvedCallback = cb;
  }

  onLocalCommand(cb: LocalCommandCallback): void {
    this.localCommandCallback = cb;
  }

  /**
   * Invoked whenever the sidecar process terminates (crash or failed start),
   * before any backoff restart completes. The restarted sidecar boots Idle, so
   * callers must reset any state mirrored from sidecar events (e.g. the cached
   * dictation phase) or they will act on a phase the sidecar no longer has.
   */
  onTerminated(cb: TerminatedCallback): void {
    this.terminatedCallback = cb;
  }

  start(): void {
    this.spawnSidecar();
    this.registerIpcHandler();
  }

  private spawnSidecar(): void {
    console.log(`[sidecar] spawning: ${this.sidecarPath}`);

    this.process = spawn(this.sidecarPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSidecarEnv(process.env),
    });

    const rl = createInterface({ input: this.process.stdout! });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleSidecarMessage(msg);
      } catch (e) {
        console.warn("[sidecar] unparseable stdout:", line, e);
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[sidecar] ${chunk.toString()}`);
    });

    this.process.on("exit", (code, signal) => {
      console.warn(`[sidecar] exited: code=${code} signal=${signal}`);
      this.handleSidecarTermination(`Sidecar process exited (code=${code}, signal=${signal})`);
    });

    this.process.on("error", (err) => {
      console.error(`[sidecar] failed to start: path=${this.sidecarPath}`, err);
      this.handleSidecarTermination(
        `Sidecar process failed to start (${this.sidecarPath}): ${err.message}`
      );
    });

    this.process.on("spawn", () => {
      console.log("[sidecar] connected");
      this.restartAttempts = 0;
    });
  }

  // Shared termination path for both 'exit' and 'error': schedule a backoff
  // restart and reject all pending requests with a clear message.
  private handleSidecarTermination(reason: string): void {
    if (!this.shuttingDown && this.restartAttempts < this.maxRestarts) {
      const delay = Math.min(1000 * 2 ** this.restartAttempts, 30000);
      this.restartAttempts++;
      console.log(`[sidecar] restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestarts})`);
      setTimeout(() => this.spawnSidecar(), delay);
    } else if (this.restartAttempts >= this.maxRestarts) {
      console.error("[sidecar] max restarts reached, giving up");
    }
    // Reject all pending requests with a clear error message
    const pendingCount = this.pending.size;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    if (pendingCount > 0) {
      console.warn(`[sidecar] rejected ${pendingCount} pending request(s): ${reason}`);
    }
    this.terminatedCallback?.(reason);
  }

  private handleSidecarMessage(msg: JsonRpcResponse): void {
    if (msg.method === "event" && msg.params) {
      const { event, payload } = msg.params;
      if (event.startsWith("window:")) {
        this.windowCommandCallback?.(event.replace("window:", ""), payload);
      } else {
        this.eventCallback?.(event, payload);
      }
      return;
    }

    if (msg.id !== null && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
        this.commandResolvedCallback?.(pending.command, pending.args, msg.result);
      }
    }
  }

  private sendToSidecar(request: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("Sidecar process stdin is not writable");
    }
    this.process.stdin.write(JSON.stringify(request) + "\n");
  }

  invokeSidecar(command: string, args?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          reject(new Error(`Command timed out after ${getCommandTimeoutMs(command)}ms: ${command}`));
        }
      }, getCommandTimeoutMs(command));
      this.pending.set(id, { command, args, resolve, reject, timeout });
      try {
        this.sendToSidecar({ jsonrpc: "2.0", id, method: command, params: args ?? {} });
      } catch (e) {
        // Clear timeout before deleting to prevent race condition
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  invoke(command: string, args?: unknown): Promise<unknown> {
    return this.invokeSidecar(command, args);
  }

  private registerIpcHandler(): void {
    ipcMain.handle("sidecar:invoke", async (event, command: string, args?: unknown) => {
      if (!ALLOWED_RENDERER_COMMANDS.has(command)) {
        throw new Error(`Renderer command is not allowed: ${command}`);
      }

      if (this.localCommandCallback) {
        const local = await this.localCommandCallback(event, command, args);
        if (local.handled) {
          return local.result ?? null;
        }
      }

      return this.invokeSidecar(command, args);
    });
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.process && !this.process.killed) {
      try {
        this.sendToSidecar({ jsonrpc: "2.0", id: randomUUID(), method: "shutdown", params: {} });
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGTERM");
        }
      }, 3000);
    }
  }
}
