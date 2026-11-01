import { describe, expect, it } from "vitest";
import { buildDownloadedModelIndex, isModelOnDisk } from "@/components/models/downloaded-models";
import { getAsrModelCapability, isKnownAsrProvider, isDownloadableProvider, isMeetingEligibleProvider, providerHostingPreference, resolveAsrLanguageBoundary } from "@/lib/asr-capabilities";
import { buildSnapshot } from "@/hooks/use-setup-status";
import type { AsrProviderInfo } from "@/types";
import type { Settings } from "@/types/settings";

const file = (name: string, sizeBytes = 10) => ({ name, provider: "whistle", path: `/models/whistle/whistle-2.0.0/${name}`, sizeBytes });

describe("Whistle experimental route", () => {
  it("stays local, downloadable, short-dictation-only and unqualified", () => {
    expect(isKnownAsrProvider("whistle")).toBe(true);
    expect(isDownloadableProvider("whistle")).toBe(true);
    expect(providerHostingPreference("whistle")).toBe("local");
    expect(isMeetingEligibleProvider("whistle")).toBe(false);
    const cap = getAsrModelCapability("whistle", "whistle-2.0.0");
    expect(cap?.tier).toBe("more");
    expect(cap?.languageEvidence.verifiedLanguages).toEqual([]);
    expect(cap?.tradeoff).toContain("30 seconds");
    const boundary = resolveAsrLanguageBoundary("whistle", "whistle-2.0.0");
    expect(boundary.kind).toBe("enumerated");
    if (boundary.kind === "enumerated") expect(boundary.codes).toEqual(["en", "de", "fr", "es", "it", "nl", "pl"]);
  });

  it("does not mark either partial artifact as a complete installation", () => {
    for (const files of [[file("whistle.cact")], [file("needle")], [file("whistle.cact"), file("needle.part")], [file("whistle.cact"), file("needle", 0)]]) {
      expect(isModelOnDisk(buildDownloadedModelIndex(files), "whistle", "whistle-2.0.0")).toBe(false);
    }
    expect(isModelOnDisk(buildDownloadedModelIndex([file("whistle.cact"), file("needle")]), "whistle", "whistle-2.0.0")).toBe(true);
  });

  it("does not override the runtime's missing or untrusted artifact finding", () => {
    const settings = { transcription: { useSharedAsrSelection: false, dictationProvider: "whistle", dictationModelId: "whistle-2.0.0", dictationInsertionMode: "clipboard_only" }, privacy: { remoteProcessingEnabled: false } } as Settings;
    const providers = [{ providerType: "whistle", name: "Whistle", inferenceEnabled: true, runtimeStatus: "missing_model", selectedModelId: "whistle-2.0.0", modelOptions: [{ id: "whistle-2.0.0", label: "Whistle" }] }] as AsrProviderInfo[];
    const snapshot = buildSnapshot(settings, providers, null, false, null, null, {}, buildDownloadedModelIndex([file("whistle.cact"), file("needle")]));
    expect(snapshot.dictationRoute.ready).toBe(false);
  });
});
