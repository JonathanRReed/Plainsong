import { describe, expect, it } from "vitest";
import { buildAsrRouteCatalog } from "@/lib/asr-route-catalog";
import {
  defaultMeetingChoice,
  groupSpeechChoices,
  recommendedSpeechRoute,
  speechChoicesForLane,
} from "@/lib/speech-model-choices";
import { onnxParakeetLanes, withParakeetUpgrade } from "@/lib/parakeet-upgrade";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";

function provider(
  providerType: string,
  modelOptions: string[],
  extra: Partial<AsrProviderInventory> = {},
): AsrProviderInventory {
  return {
    providerType,
    name: providerType,
    description: "",
    isAvailable: true,
    inferenceEnabled: true,
    selectedModelId: modelOptions[0],
    modelOptions: modelOptions.map((id) => ({ id, label: id })),
    downloadStatus: "NotDownloaded",
    ...extra,
  } as unknown as AsrProviderInventory;
}

const ONNX = provider("parakeet", [
  "parakeet-tdt-0.6b-v3",
  "parakeet-tdt-0.6b-v2",
  "parakeet-tdt-ctc-110m",
]);
const WHISPER = provider("whisper", [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v3-turbo",
  "large-v3",
]);
const GGUF = provider("transcribe_cpp", [
  "parakeet-tdt-0.6b-v3-q8_0",
  "fluid-speech-mini-q8_0",
  "underdog-bark-3.0-pro-q8_0",
  "parakeet-unified-en-0.6b-q8_0",
  "moonshine-streaming-medium-q8_0",
]);
const MOONSHINE = provider("moonshine", ["moonshine-tiny", "moonshine-base"]);
const DEEPGRAM = provider("deepgram", ["nova-3"]);

const BANNED = /Compatible|graphics chip|processor|GGUF|ONNX|GPU|CPU|Metal|transcribe\.cpp/i;

describe("speech model choices", () => {
  it("offers one Parakeet v3 where the GGUF build runs: that build, recommended, first", () => {
    const routes = buildAsrRouteCatalog([ONNX, WHISPER, GGUF, MOONSHINE, DEEPGRAM], "prefer_local");
    const choices = speechChoicesForLane(routes, "dictation");

    expect(choices[0].recommended).toBe(true);
    expect(choices[0].route.routeId).toBe("transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0");
    expect(choices.filter((choice) => choice.recommended)).toHaveLength(1);
    expect(choices.filter((choice) => choice.route.label === "Parakeet v3")).toHaveLength(1);
    expect(choices.some((choice) => choice.route.providerType === "parakeet")).toBe(false);

    // Every distinct finished model, each once; no experimental model, no cloud.
    const labels = choices.map((choice) => choice.route.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([
      "Parakeet v3",
      "Whisper Tiny",
      "Whisper Tiny (English)",
      "Moonshine Tiny (English)",
      "Whisper Base",
      "Whisper Base (English)",
      "Moonshine Base (English)",
      "Whisper Small",
      "Whisper Small (English)",
      "Fluid Speech Mini by FluidVoice",
      "Underdog Bark 3.0 Pro by Conway Research",
      "Whisper Medium",
      "Whisper Medium (English)",
      "Whisper Large Turbo",
      "Whisper Large",
    ]);
    for (const choice of choices) {
      expect(choice.note.length).toBeGreaterThan(0);
      expect(`${choice.route.label} ${choice.note}`).not.toMatch(BANNED);
    }
    const note = (label: string) => choices.find((choice) => choice.route.label === label)?.note;
    // Whether a model also does meetings is said by its section, not its note.
    expect(note("Whisper Tiny (English)")).toBe("Smallest download, English only");
    expect(note("Fluid Speech Mini by FluidVoice")).toBe("English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.");
    expect(note("Underdog Bark 3.0 Pro by Conway Research")).toBe("English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.");
    expect(note("Whisper Large Turbo")).toBe("About 100 languages, larger download");
  });

  it("lists only meeting-capable models for meetings, with the same recommendation", () => {
    const routes = buildAsrRouteCatalog([ONNX, WHISPER, GGUF, MOONSHINE], "prefer_local");
    const labels = speechChoicesForLane(routes, "meeting").map((choice) => choice.route.label);
    expect(labels[0]).toBe("Parakeet v3");
    expect(labels).not.toContain("Whisper Base (English)");
    expect(labels).not.toContain("Moonshine Tiny (English)");
    expect(labels).toContain("Underdog Bark 3.0 Pro by Conway Research");
    expect(labels.filter((label) => label === "Parakeet v3")).toHaveLength(1);
  });

  it("recommends ONNX Parakeet, named plainly, where the GGUF build can't run", () => {
    for (const providers of [
      [ONNX, WHISPER],
      [ONNX, WHISPER, { ...GGUF, inferenceEnabled: false }],
    ]) {
      const routes = buildAsrRouteCatalog(providers, "prefer_local");
      expect(recommendedSpeechRoute(routes)?.routeId).toBe("parakeet:parakeet-tdt-0.6b-v3");
      const choices = speechChoicesForLane(routes, "dictation");
      expect(choices[0].route.label).toBe("Parakeet v3");
      expect(choices[0].recommended).toBe(true);
      expect(choices.some((choice) => choice.route.providerType === "transcribe_cpp")).toBe(false);
    }
  });
});

describe("grouping the dictation list by what each model covers", () => {
  it("puts meeting-capable models first, recommended at the top, and the rest under dictation only", () => {
    const routes = buildAsrRouteCatalog([ONNX, WHISPER, GGUF], "prefer_local");
    const { dictationAndMeetings, dictationOnly } = groupSpeechChoices(
      speechChoicesForLane(routes, "dictation"),
    );
    expect(dictationAndMeetings[0].recommended).toBe(true);
    expect(dictationAndMeetings.map((choice) => choice.route.label)).toEqual([
      "Parakeet v3",
      "Whisper Small",
      "Fluid Speech Mini by FluidVoice",
      "Underdog Bark 3.0 Pro by Conway Research",
      "Whisper Medium",
      "Whisper Large Turbo",
      "Whisper Large",
    ]);
    expect(dictationOnly.map((choice) => choice.route.label)).toEqual([
      "Whisper Tiny",
      "Whisper Tiny (English)",
      "Whisper Base",
      "Whisper Base (English)",
      "Whisper Small (English)",
      "Whisper Medium (English)",
    ]);
    // The grouping is the catalog's own meeting answer, the one the meetings
    // list is built from.
    const meetingIds = new Set(
      speechChoicesForLane(routes, "meeting").map((choice) => choice.route.routeId),
    );
    expect(dictationAndMeetings.every((choice) => meetingIds.has(choice.route.routeId))).toBe(true);
    expect(dictationOnly.some((choice) => meetingIds.has(choice.route.routeId))).toBe(false);
  });
});

describe("the meetings model offered beside a dictation-only model", () => {
  const routes = buildAsrRouteCatalog([ONNX, WHISPER, GGUF], "prefer_local");
  const meetingChoices = speechChoicesForLane(routes, "meeting");
  const GGUF_ID = "transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0";
  const onDisk = (...ids: string[]) => (route: { routeId: string }) => ids.includes(route.routeId);

  it("is the recommended model when nothing is on this Mac", () => {
    expect(defaultMeetingChoice(meetingChoices, onDisk(), GGUF_ID)?.route.routeId).toBe(GGUF_ID);
    expect(defaultMeetingChoice(meetingChoices, onDisk(), null)?.route.routeId).toBe(GGUF_ID);
  });

  it("prefers a meetings model already on this Mac over a download", () => {
    expect(defaultMeetingChoice(meetingChoices, onDisk("whisper:small"), GGUF_ID)?.route.routeId)
      .toBe("whisper:small");
    // The recommended one wins among models already here.
    expect(
      defaultMeetingChoice(meetingChoices, onDisk("whisper:small", GGUF_ID), null)?.route.routeId,
    ).toBe(GGUF_ID);
  });

  it("keeps the model meetings already use when it is here", () => {
    expect(
      defaultMeetingChoice(meetingChoices, onDisk("whisper:small", GGUF_ID), "whisper:small")?.route
        .routeId,
    ).toBe("whisper:small");
    // Named but not downloaded, with nothing else here: still the one named.
    expect(defaultMeetingChoice(meetingChoices, onDisk(), "whisper:large-v3")?.route.routeId)
      .toBe("whisper:large-v3");
  });

  it("is nothing when no model can transcribe meetings", () => {
    expect(defaultMeetingChoice([], onDisk(), null)).toBeNull();
  });
});

function transcription(fields: Partial<Settings["transcription"]>): Settings {
  return {
    transcription: {
      defaultProvider: "parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      useSharedAsrSelection: true,
      dictationProvider: "parakeet",
      dictationModelId: "parakeet-tdt-0.6b-v3",
      meetingProvider: "parakeet",
      meetingModelId: "parakeet-tdt-0.6b-v3",
      ...fields,
    },
  } as unknown as Settings;
}

describe("the Parakeet v3 upgrade", () => {
  it("moves a shared ONNX Parakeet install to GGUF in both lanes and keeps the ONNX fallback", () => {
    const before = transcription({});
    expect(onnxParakeetLanes(before.transcription)).toEqual({ dictation: true, meeting: true });
    const after = withParakeetUpgrade(before).transcription;
    expect(after).toMatchObject({
      useSharedAsrSelection: false,
      defaultProvider: "parakeet",
      selectedModelId: "parakeet-tdt-0.6b-v3",
      dictationProvider: "transcribe_cpp",
      dictationModelId: "parakeet-tdt-0.6b-v3-q8_0",
      meetingProvider: "transcribe_cpp",
      meetingModelId: "parakeet-tdt-0.6b-v3-q8_0",
      parakeetUpgradeApplied: true,
      parakeetUpgradeNoticePending: false,
    });
  });

  it("moves only the lanes on ONNX Parakeet and leaves other choices alone", () => {
    const before = transcription({
      useSharedAsrSelection: false,
      dictationProvider: "whisper",
      dictationModelId: "small.en",
    });
    const after = withParakeetUpgrade(before).transcription;
    expect(after.dictationProvider).toBe("whisper");
    expect(after.dictationModelId).toBe("small.en");
    expect(after.meetingProvider).toBe("transcribe_cpp");

    const elsewhere = transcription({
      defaultProvider: "whisper",
      selectedModelId: "large-v3-turbo",
    });
    expect(withParakeetUpgrade(elsewhere)).toBe(elsewhere);
  });
});
