import { describe, expect, it } from "vitest";
import {
  isDictationOnlyProvider,
  isMeetingEligibleProvider,
  isSharedMeetingCompatible,
  mlxMappedModelId,
  modelSupportsMlxAcceleration,
  visibleRouteForMlxModel,
} from "@/lib/asr-capabilities";

describe("ASR capability mappings", () => {
  it("maps exact Whisper and Moonshine models to MLX routes", () => {
    expect(mlxMappedModelId("whisper", "base.en")).toBe(
      "mlx-community/whisper-base.en-asr-fp16"
    );
    expect(mlxMappedModelId("moonshine", "moonshine-base")).toBe(
      "UsefulSensors/moonshine-base"
    );
  });

  it("claims MLX acceleration only for model/provider pairs that have direct mapped routes", () => {
    expect(modelSupportsMlxAcceleration("parakeet", "parakeet-ctc-0.6b")).toBe(true);
    expect(modelSupportsMlxAcceleration("voxtral", "voxtral-local")).toBe(true);
    expect(modelSupportsMlxAcceleration("whisper", "not-a-real-model")).toBe(false);
  });

  it("maps overlapping MLX routes back to visible provider selections", () => {
    expect(visibleRouteForMlxModel("UsefulSensors/moonshine-tiny")).toEqual({
      providerType: "moonshine",
      modelId: "moonshine-tiny",
    });
    expect(
      visibleRouteForMlxModel("mlx-community/whisper-large-v3-turbo-asr-fp16")
    ).toEqual({
      providerType: "whisper",
      modelId: "large-v3-turbo",
    });
  });

  it("keeps frontend provider eligibility aligned with backend meeting rules", () => {
    expect(isDictationOnlyProvider("whisper")).toBe(true);
    expect(isDictationOnlyProvider("moonshine")).toBe(true);
    expect(isDictationOnlyProvider("whisper_candle")).toBe(true);
    expect(isMeetingEligibleProvider("distil_whisper")).toBe(true);
    expect(isMeetingEligibleProvider("parakeet")).toBe(true);
    expect(isMeetingEligibleProvider("voxtral")).toBe(true);
    expect(isMeetingEligibleProvider("openai_cloud")).toBe(true);
    expect(isMeetingEligibleProvider("whisper_candle")).toBe(false);
    expect(isSharedMeetingCompatible("distil_whisper", "distil-large-v3.5")).toBe(true);
    expect(isSharedMeetingCompatible("parakeet", "parakeet-ctc-0.6b")).toBe(true);
    expect(isSharedMeetingCompatible("voxtral", "voxtral-local")).toBe(true);
    expect(isSharedMeetingCompatible("whisper", "base.en")).toBe(false);
    expect(isSharedMeetingCompatible("whisper_candle", "whisper-large-v3-turbo")).toBe(false);
  });
});
