import { describe, expect, it } from "vitest";
import {
  ASR_PROVIDER_TYPES,
  asrModelTier,
  describeAsrModel,
  describePauseBehavior,
  formatModelSize,
  getAsrModelCapability,
  isDictationOnlyProvider,
  isKnownAsrProvider,
  isMeetingEligibleProvider,
  isSharedMeetingCompatible,
} from "@/lib/asr-capabilities";

describe("ASR capability mappings", () => {
  it("recognises only the engines this build can still run", () => {
    expect(ASR_PROVIDER_TYPES).toHaveLength(11);
    expect(isKnownAsrProvider("whisper")).toBe(true);
    expect(isKnownAsrProvider("parakeet")).toBe(true);
    expect(isKnownAsrProvider("macos_apple_speech")).toBe(true);
  });

  it("rejects the deleted Python-backed engines a stale settings file may still name", () => {
    expect(isKnownAsrProvider("mlx_audio")).toBe(false);
    expect(isKnownAsrProvider("voxtral")).toBe(false);
    expect(isKnownAsrProvider("")).toBe(false);
    expect(isKnownAsrProvider(null)).toBe(false);
    expect(isKnownAsrProvider(undefined)).toBe(false);
  });

  it("keeps frontend provider eligibility aligned with backend meeting rules", () => {
    expect(isDictationOnlyProvider("whisper")).toBe(true);
    expect(isDictationOnlyProvider("moonshine")).toBe(true);
    expect(isDictationOnlyProvider("whisper_candle")).toBe(true);
    expect(isMeetingEligibleProvider("distil_whisper")).toBe(true);
    expect(isMeetingEligibleProvider("parakeet")).toBe(true);
    expect(isMeetingEligibleProvider("openai_cloud")).toBe(true);
    expect(isMeetingEligibleProvider("whisper_candle")).toBe(false);
    expect(isSharedMeetingCompatible("distil_whisper", "distil-large-v3.5")).toBe(true);
    expect(isSharedMeetingCompatible("parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
    expect(isSharedMeetingCompatible("whisper", "base.en")).toBe(false);
    expect(isSharedMeetingCompatible("whisper_candle", "whisper-large-v3-turbo")).toBe(false);
  });

  it("keeps the short-form legacy Parakeet export out of the meeting lane", () => {
    expect(isSharedMeetingCompatible("parakeet", "parakeet-tdt-ctc-110m")).toBe(false);
  });
});

describe("ASR model capability metadata", () => {
  it("separates the English-only builds from the multilingual ones", () => {
    expect(getAsrModelCapability("whisper", "base.en")?.languages).toEqual({
      englishOnly: true,
      count: 1,
      label: "English only",
    });
    expect(getAsrModelCapability("whisper", "base")?.languages.englishOnly).toBe(false);
    expect(getAsrModelCapability("whisper", "large-v3-turbo")?.languages.count).toBe(99);
    expect(getAsrModelCapability("parakeet", "parakeet-tdt-0.6b-v3")?.languages).toEqual({
      englishOnly: false,
      count: 25,
      label: "25 European languages",
    });
    expect(getAsrModelCapability("parakeet", "parakeet-tdt-ctc-110m")?.languages.englishOnly).toBe(
      true
    );
  });

  it("separates upstream language coverage from languages qualified in Plainsong", () => {
    expect(
      getAsrModelCapability("whisper", "base.en")?.languageEvidence,
    ).toEqual({
      basis: "plainsong_verified",
      verifiedLanguages: ["English"],
    });
    expect(
      getAsrModelCapability("whisper", "large-v3-turbo")?.languageEvidence,
    ).toEqual({
      basis: "upstream_listed",
      verifiedLanguages: [],
    });
    expect(
      getAsrModelCapability("parakeet", "parakeet-tdt-0.6b-v3")
        ?.languageEvidence,
    ).toEqual({
      basis: "upstream_listed",
      verifiedLanguages: ["English"],
    });
  });

  it("carries the real download sizes rather than placeholders", () => {
    // All MiB, matching the (misnamed) `size_mb` fields on the Rust side.
    expect(getAsrModelCapability("whisper", "base.en")?.sizeMib).toBe(142);
    expect(getAsrModelCapability("whisper", "large-v3-turbo")?.sizeMib).toBe(1620);
    expect(getAsrModelCapability("whisper", "large-v3")?.sizeMib).toBe(2900);
    expect(getAsrModelCapability("parakeet", "parakeet-tdt-0.6b-v3")?.sizeMib).toBe(639);
  });

  it("states one size for base and base.en, which are the same size on disk", () => {
    // 147,964,211 bytes each: 141.1 MiB, or 148.0 MB. Carrying one entry in
    // each unit is what made `base`'s "effectively the same size" tradeoff
    // contradict the two numbers rendered beside it.
    const base = getAsrModelCapability("whisper", "base");
    const baseEn = getAsrModelCapability("whisper", "base.en");
    expect(base?.sizeMib).toBe(baseEn?.sizeMib);
    expect(base?.tradeoff).toContain("effectively the same size");
  });

  it("promotes exactly three routes", () => {
    expect(asrModelTier("whisper", "base.en")).toBe("promoted");
    expect(asrModelTier("whisper", "large-v3-turbo")).toBe("promoted");
    expect(asrModelTier("parakeet", "parakeet-tdt-0.6b-v3")).toBe("promoted");

    for (const modelId of [
      "tiny",
      "tiny.en",
      "base",
      "small",
      "small.en",
      "medium",
      "medium.en",
      "large-v3",
    ]) {
      expect(asrModelTier("whisper", modelId)).toBe("more");
    }
    expect(asrModelTier("parakeet", "parakeet-tdt-ctc-110m")).toBe("more");
    expect(asrModelTier("moonshine", "moonshine-base")).toBe("more");
  });

  it("records the pause behaviour that differs between the two families", () => {
    expect(getAsrModelCapability("whisper", "base.en")?.pauseBehavior).toBe(
      "encoder_decoder"
    );
    expect(getAsrModelCapability("parakeet", "parakeet-tdt-0.6b-v3")?.pauseBehavior).toBe(
      "transducer"
    );
    expect(describePauseBehavior("transducer")).toContain("silence produces no text");
    expect(describePauseBehavior("encoder_decoder")).toContain("invented words");
  });

  it("renders binary units, because the stored numbers are binary units", () => {
    expect(formatModelSize(142)).toBe("142 MiB");
    expect(formatModelSize(639)).toBe("639 MiB");
    // 1620 MiB is 1.58 GiB. Dividing by 1000 and printing "1.6 GB" understated
    // the same file by ~5%, and did so for every entry in the table.
    expect(formatModelSize(1620)).toBe("1.6 GiB");
    expect(formatModelSize(2900)).toBe("2.8 GiB");
    expect(formatModelSize(1023)).toBe("1023 MiB");
    expect(formatModelSize(1024)).toBe("1.0 GiB");
    expect(formatModelSize(0)).toBe("size unknown");
  });

  it("describes a model in one sentence that names the downside", () => {
    const baseEn = describeAsrModel("whisper", "base.en");
    expect(baseEn).toContain("142 MiB");
    expect(baseEn).toContain("English only");
    expect(baseEn).toContain("English verified in Plainsong");
    expect(baseEn).toContain("Spanish");

    const turbo = describeAsrModel("whisper", "large-v3-turbo");
    expect(turbo).toContain("1.6 GiB");
    expect(turbo).toContain("listed upstream");
    expect(turbo).toContain("not yet qualified");
    expect(turbo).toContain("slower");

    const parakeet = describeAsrModel("parakeet", "parakeet-tdt-0.6b-v3");
    expect(parakeet).toContain("25 European languages listed upstream");
    expect(parakeet).toContain("English verified in Plainsong");
  });

  it("returns null rather than inventing metadata for routes it has none for", () => {
    expect(getAsrModelCapability("openai_cloud", "gpt-4o-transcribe")).toBeNull();
    expect(describeAsrModel("openai_cloud", "gpt-4o-transcribe")).toBeNull();
    expect(describeAsrModel("whisper", "not-a-real-model")).toBeNull();
  });
});
