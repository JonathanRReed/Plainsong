import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { resolveDictationBindings } from "../../electron/dictation-bindings";
import { describeTrayStatus } from "../../electron/tray-status";
import { dictationSessionCanCancel } from "../../electron/native-macos-shortcut";
import { updaterInstallBlockedByActiveMeeting } from "../../electron/updater-channel";

const main = readFileSync(process.env.PLAINSONG_TEST_MAIN_SOURCE ?? "electron/main.ts", "utf8");

function functionSource(name: string): string {
  const start = main.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = main.indexOf("\n}", start) + 2;
  return main.slice(start, end);
}

function evaluate(source: string, name: string, dependencies: Record<string, unknown>) {
  const code = stripTypeScriptTypes(source);
  return new Function(...Object.keys(dependencies), `${code}\nreturn ${name};`)(...Object.values(dependencies));
}

describe("main-process lifecycle handoffs", () => {
  it("P1: routes a deferred helper's release using its original settings", async () => {
    const original = { shortcuts: { dictationBindings: [{ id: "held", trigger: { kind: "key", accelerator: "Ctrl+Shift+D" }, action: { kind: "dictation", behavior: "hold", modeId: null } }] } };
    const latest = { shortcuts: { dictationBindings: [] } };
    let options: { onEvent: (event: unknown) => void } | undefined;
    const transitions = vi.fn();
    const handleNative = evaluate(functionSource("handleNativeDictationShortcutEvent"), "handleNativeDictationShortcutEvent", {
      qaLog: () => {}, dictationPhase: "recording", nativeShortcutAvailable: true,
      shouldHandleDictationShortcutSource: () => true, nativeShortcutDownBindings: new Set(["held"]),
      trackNativeShortcutDownBindings: () => new Set(), applyDeferredNativeShortcutConfig: () => {},
      normalizeNativeShortcutEvent: () => ({ signal: "released", bindingId: "held" }),
      resolveDictationBindings, handleDictationBindingTransition: transitions,
    });
    const start = evaluate(functionSource("startNativeShortcutControllerIfNeeded"), "startNativeShortcutControllerIfNeeded", {
      registrableDictationBindings: (bindings: unknown) => bindings, resolveDictationBindings,
      buildNativeHelperBindingTable: () => [], normalizeNativeShortcutHelperShortcut: (value: string) => value,
      resolveDictationShortcutBehavior: () => "hold_to_talk",
      appliedNativeShortcutConfig: null, nativeShortcutController: null, dictationPhase: "idle",
      nativeShortcutDownBindings: new Set(), resolveNativeHelperConfigApplication: () => ({ action: "apply" }),
      pendingNativeShortcutSettings: null, cancelNativeShortcutOwner: () => {}, disposeNativeShortcutController: () => {},
      startNativeMacosShortcutController: (input: typeof options) => {
        options = input;
        return { status: { available: true }, setSessionActive: () => {} };
      },
      process: { platform: "darwin" }, getNativeShortcutHelperPath: () => "/fake/helper",
      latestShortcutSettings: latest, handleNativeDictationShortcutEvent: handleNative,
      surfaceDictationShortcutFailure: vi.fn(), dictationSessionCanCancel,
      dictationSessionId: null, setNativeShortcutAvailable: () => {},
    });
    start(original);
    expect(options).toBeDefined();
    options!.onEvent({ event: "up", bindingId: "held" });
    await Promise.resolve();
    expect(transitions).toHaveBeenCalledWith(original, original.shortcuts.dictationBindings[0], "up", { event: "up", bindingId: "held" });
  });

  it("P1: refuses an update restart while dictation is recording", async () => {
    const start = main.indexOf("prepareToQuit: async () => {");
    expect(start).toBeGreaterThan(0);
    const bodyStart = main.indexOf("{", start) + 1;
    const bodyEnd = main.indexOf("\n    },", bodyStart);
    const prepare = evaluate(`async function prepare() {${main.slice(bodyStart, bodyEnd)}\n}`, "prepare", {
      activeMeetingRecordingId: null, updaterInstallBlockedByActiveMeeting,
      dictationPhase: "recording", dictationSessionCanCancel,
      flushRendererDraftsBeforeQuit: async () => true,
    });
    await expect(prepare()).rejects.toThrow(/dictation/i);
  });

  it("P2: shows unavailable audio instead of Ready after a sidecar crash", () => {
    const status = evaluate(functionSource("currentTrayStatus"), "currentTrayStatus", {
      activeMeetingRecordingId: null, trayMeetingId: null, trayMeetingStartedAt: null,
      trayMeetingPausedSince: null, trayMeetingClosedPausedMs: 0, activeMeetingPhase: null,
      dictationPhase: "idle", dictationLiveSince: null, describeTrayStatus,
      ipcBridge: { getRuntimeStatus: () => ({ ready: false, reason: "crash" }) },
    });
    expect(status()).toMatchObject({ statusLine: "Audio service unavailable", ticking: false, meetingControl: "busy" });
  });
});
