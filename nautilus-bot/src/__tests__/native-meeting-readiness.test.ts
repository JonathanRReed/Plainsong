import { describe, expect, it } from "vitest";
import { resolveMeetingNotesRoute } from "@/features/readiness/meeting-notes-route";
const facts = { optedOut: false, provider: "native_text", remoteProcessingEnabled: false, localRuntimeReady: true, localModelReady: true, localModelId: "native", credentialPresent: null, localExecutionReady: true };
describe("native meeting readiness", () => {
  it("does not require cloud permission or credentials", () => { expect(resolveMeetingNotesRoute({ ...facts, nativeMemoryReady: true }).state).toBe("ready"); });
  it("requires a downloaded and verified model", () => { expect(resolveMeetingNotesRoute({ ...facts, localModelReady: false, nativeMemoryReady: true }).reason).toMatch(/download the built-in text model/); });
  it("separates insufficient RAM from missing files", () => { expect(resolveMeetingNotesRoute({ ...facts, nativeMemoryReady: false }).reason).toMatch(/enough free memory/); });
  it("keeps unknown memory readiness unknown", () => { expect(resolveMeetingNotesRoute(facts).state).toBe("unknown"); });
  it("preserves a persistent pause despite verified files and enough memory", () => {
    const message = "An earlier Ollama request may still be running.";
    expect(resolveMeetingNotesRoute({ ...facts, nativeMemoryReady: true, localExecutionReady: false, localExecutionMessage: message })).toEqual({ state: "unconfigured", reason: message });
  });
  it("keeps a busy or unverified text runtime temporary", () => {
    expect(resolveMeetingNotesRoute({ ...facts, nativeMemoryReady: true, localExecutionReady: null, localExecutionMessage: "Another local text operation is running." })).toEqual({ state: "unknown", reason: "Another local text operation is running." });
    expect(resolveMeetingNotesRoute({ ...facts, nativeMemoryReady: true, localExecutionReady: undefined }).state).toBe("unknown");
  });
});

import { vi } from "vitest";
import { probeMeetingNotesRoute } from "@/hooks/use-setup-status";
import type { Settings } from "@/types/settings";
const nativeSettings = { privacy: { meetingsAi: { provider: "native_text", modelId: null }, remoteProcessingEnabled: false } } as Settings;
it("probes the owned native runtime without contacting Ollama", async () => {
  const getOllamaStatus = vi.fn();
  const getNativeTextModelStatus = vi.fn(async () => ({ provider: "native_text" as const, modelId: "native", displayName: "Native", downloadBytes: 1, bytesOnDisk: 1, ready: true, missingFiles: [], runtimePresent: true, memoryAvailableBytes: 4000000000, canLoadNow: false, qualified: false, contextTokens: 8192 }));
  const result = await probeMeetingNotesRoute(nativeSettings, { getNativeTextModelStatus, getOllamaStatus });
  expect(getNativeTextModelStatus).toHaveBeenCalledTimes(1);
  expect(getOllamaStatus).not.toHaveBeenCalled();
  expect(result.localModelReady).toBe(true);
  expect(result.nativeMemoryReady).toBe(false);
});
it("a failed native probe stays unknown", async () => {
  const result = await probeMeetingNotesRoute(nativeSettings, { getNativeTextModelStatus: vi.fn(async () => { throw new Error("Unavailable"); }) });
  expect(result.localRuntimeReady).toBeNull();
  expect(result.localModelReady).toBeNull();
});
it.each(["completion_unknown", "storage_error"] as const)("the native probe retains the %s cause", async (state) => {
  const message = "Local processing is paused for the controlled test.";
  const result = await probeMeetingNotesRoute(nativeSettings, { getNativeTextModelStatus: vi.fn(async () => ({ provider: "native_text" as const, modelId: "native", displayName: "Native", downloadBytes: 1, bytesOnDisk: 1, ready: true, missingFiles: [], runtimePresent: true, memoryAvailableBytes: 20000000000, canLoadNow: true, qualified: false, contextTokens: 8192, runtimeHealth: { state, message } })) });
  expect(result.localExecutionReady).toBe(false);
  expect(result.localExecutionMessage).toBe(message);
});

it("probes the explicitly chosen notes tier", async () => {
  const getNativeTextModelStatus = vi.fn(async () => ({ provider: "native_text" as const, modelId: "chosen", displayName: "Chosen", downloadBytes: 1, bytesOnDisk: 1, ready: true, missingFiles: [], runtimePresent: true, memoryAvailableBytes: 4_000_000_000, canLoadNow: true, qualified: false, contextTokens: 8192 }));
  const settings = { ...nativeSettings, privacy: { ...nativeSettings.privacy, meetingsAi: { provider: "native_text", modelId: "chosen" } } };
  const result = await probeMeetingNotesRoute(settings, { getNativeTextModelStatus });
  expect(getNativeTextModelStatus).toHaveBeenCalledWith("chosen");
  expect(result.localModelReady).toBe(true);
});

it("probes Apple notes without contacting Ollama", async () => {
  const getOllamaStatus = vi.fn();
  const getAppleLanguageModelAvailability = vi.fn(async () => ({ provider: "apple_language_model", displayName: "Apple on-device model", available: true, reason: null, detail: null, operatingSystemVersion: "27" }));
  const settings = { ...nativeSettings, privacy: { ...nativeSettings.privacy, meetingsAi: { provider: "apple_language_model", modelId: null } } };
  const result = await probeMeetingNotesRoute(settings, { getAppleLanguageModelAvailability, getOllamaStatus });
  expect(getOllamaStatus).not.toHaveBeenCalled();
  expect(resolveMeetingNotesRoute({ ...result, provider: "apple_language_model", remoteProcessingEnabled: false }).state).toBe("ready");
});
