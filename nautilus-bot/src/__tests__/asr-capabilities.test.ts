import { describe, expect, it } from "vitest";
import {
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

  it("does not claim MLX acceleration for unsupported provider/model pairs", () => {
    expect(modelSupportsMlxAcceleration("parakeet", "parakeet-ctc-0.6b")).toBe(false);
    expect(modelSupportsMlxAcceleration("voxtral", "voxtral-local")).toBe(false);
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
});
