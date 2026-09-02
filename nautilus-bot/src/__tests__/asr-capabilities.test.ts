import { describe, expect, it } from "vitest";
import {
  ASR_LANGUAGE_NAMES,
  ASR_PROVIDER_TYPES,
  asrLanguageName,
  asrLanguageOptions,
  asrModelTier,
  describeAsrModel,
  describePauseBehavior,
  formatModelSize,
  getAsrModelCapability,
  isDictationOnlyProvider,
  isKnownAsrProvider,
  isMeetingEligibleModel,
  isMeetingEligibleProvider,
  isSharedMeetingCompatible,
  resolveAsrLanguageBoundary,
} from "@/lib/asr-capabilities";

describe("ASR capability mappings", () => {
  it("recognises only the engines this build can still run", () => {
    // 12 shipped engines plus `transcribe_cpp`, which only a sidecar built
    // with `--features asr-transcribe-cpp` ever reports. The renderer keeps a
    // name for it so a developer build's route renders instead of silently
    // vanishing from the picker; nothing in a release build sends it.
    expect(ASR_PROVIDER_TYPES).toHaveLength(13);
    expect(isKnownAsrProvider("whisper")).toBe(true);
    expect(isKnownAsrProvider("parakeet")).toBe(true);
    expect(isKnownAsrProvider("macos_apple_speech")).toBe(true);
    expect(isKnownAsrProvider("transcribe_cpp")).toBe(true);
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

  it("resolves the openai_cloud meeting lane to whisper-1 only, for its timestamps", () => {
    // Only whisper-1 requests verbose_json from OpenAI's transcriptions
    // endpoint (openai_cloud.rs's uses_verbose_json()), which is what
    // actually returns segment timestamps. gpt-transcribe (the dictation
    // default) and the gpt-4o-*-transcribe models return a single un-timed
    // block, which would break seek/timeline/diarization alignment for a
    // meeting, so they must stay out of the meeting lane.
    expect(isMeetingEligibleModel("openai_cloud", "whisper-1")).toBe(true);
    expect(isMeetingEligibleModel("openai_cloud", "gpt-transcribe")).toBe(false);
    expect(isMeetingEligibleModel("openai_cloud", "gpt-4o-transcribe")).toBe(false);
    expect(isMeetingEligibleModel("openai_cloud", "gpt-4o-mini-transcribe")).toBe(false);
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
    expect(getAsrModelCapability("distil_whisper", "distil-large-v3.5")?.sizeMib).toBe(2888);
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

  it("carries Qwen3-ASR metadata with the correct download size and language coverage", () => {
    const cap = getAsrModelCapability("qwen3_asr", "qwen3-asr-0.6b");
    expect(cap).not.toBeNull();
    expect(cap?.languages.englishOnly).toBe(false);
    expect(cap?.languages.count).toBe(52);
    expect(cap?.sizeMib).toBe(1927);
    expect(cap?.pauseBehavior).toBe("encoder_decoder");
    expect(cap?.tier).toBe("more");
    // English is the only language exercised with real audio in Plainsong;
    // the copy must say so and must name the CPU cost, not hide it.
    expect(cap?.languageEvidence.verifiedLanguages).toEqual(["English"]);
    const summary = describeAsrModel("qwen3_asr", "qwen3-asr-0.6b");
    expect(summary).toContain("English verified in Plainsong");
    expect(summary).toContain("experimental");
    expect(summary).toContain("real time");
    expect(summary).not.toContain("gated");
  });

  it("treats Qwen3-ASR as meeting-eligible to match the Rust side", () => {
    expect(isMeetingEligibleProvider("qwen3_asr")).toBe(true);
    expect(isSharedMeetingCompatible("qwen3_asr", "qwen3-asr-0.6b")).toBe(true);
  });
});

describe("language boundaries", () => {
  it("gives a multilingual Whisper route its whole set", () => {
    const boundary = resolveAsrLanguageBoundary("whisper", "large-v3-turbo");

    expect(boundary.kind).toBe("enumerated");
    if (boundary.kind !== "enumerated") return;
    // ux-6: the picker offered seven against a model that accepts ~100.
    expect(boundary.codes.length).toBeGreaterThan(90);
    expect(boundary.codes).toContain("uk");
    expect(boundary.codes).toContain("sw");
    // Cantonese arrives with large-v3, and only there.
    expect(boundary.codes).toContain("yue");
    const base = resolveAsrLanguageBoundary("whisper", "base");
    expect(base.kind).toBe("enumerated");
    if (base.kind !== "enumerated") return;
    expect(base.codes).not.toContain("yue");
  });

  it("stops at Parakeet v3's 25 European languages", () => {
    const boundary = resolveAsrLanguageBoundary(
      "parakeet",
      "parakeet-tdt-0.6b-v3",
    );

    expect(boundary.kind).toBe("enumerated");
    if (boundary.kind !== "enumerated") return;
    expect(boundary.codes).toHaveLength(25);
    expect(boundary.codes).toContain("uk");
    // The route's own tradeoff says these are absent; the picker must agree.
    expect(boundary.codes).not.toContain("zh");
    expect(boundary.codes).not.toContain("hi");
    expect(boundary.codes).not.toContain("ar");
  });

  it("reports an English-only model as a boundary, not a one-item list", () => {
    for (const [provider, model] of [
      ["whisper", "base.en"],
      ["distil_whisper", "distil-large-v3.5"],
      ["moonshine", "moonshine-base"],
      ["parakeet", "parakeet-tdt-ctc-110m"],
    ] as const) {
      const boundary = resolveAsrLanguageBoundary(provider, model);
      expect(boundary.kind).toBe("english_only");
      expect(asrLanguageOptions(boundary)).toEqual([]);
    }
  });

  it("gives a hosted Whisper release its own published coverage", () => {
    expect(getAsrModelCapability("openai_cloud", "whisper-1")).toBeNull();

    const whisper1 = resolveAsrLanguageBoundary("openai_cloud", "whisper-1");
    expect(whisper1.kind).toBe("enumerated");
    if (whisper1.kind !== "enumerated") return;
    // whisper-1 is the hosted large-v2 checkpoint, so it predates Cantonese.
    expect(whisper1.codes).not.toContain("yue");
    expect(whisper1.codes).toContain("uk");

    const groq = resolveAsrLanguageBoundary("groq", "whisper-large-v3");
    expect(groq.kind).toBe("enumerated");
    if (groq.kind !== "enumerated") return;
    expect(groq.codes).toContain("yue");
  });

  it("does not lend Whisper's list to a cloud model that never claimed it", () => {
    // Keying by provider gave every openai_cloud model Whisper's ~100
    // languages, including the GPT-4o transcribe family this file already
    // documents as behaving differently, and ElevenLabs' own Scribe model.
    for (const [provider, model] of [
      ["openai_cloud", "gpt-transcribe"],
      ["openai_cloud", "gpt-4o-transcribe"],
      ["openai_cloud", "gpt-4o-mini-transcribe"],
      ["elevenlabs_scribe", "scribe_v2"],
      ["elevenlabs_scribe", "scribe_v2_experimental"],
      ["cohere_transcribe", "cohere-transcribe"],
      ["groq", "some-future-groq-model"],
    ] as const) {
      expect(
        resolveAsrLanguageBoundary(provider, model).kind,
        `${provider}:${model} should not inherit a language list`,
      ).toBe("unenumerated");
    }
  });

  it("says so rather than guessing when the set is not known", () => {
    expect(resolveAsrLanguageBoundary("elevenlabs_scribe", "scribe_v2").kind).toBe(
      "unenumerated",
    );
    expect(resolveAsrLanguageBoundary(null, null).kind).toBe("unenumerated");
  });

  it("names Qwen3-ASR's 30 languages, including Chinese, Japanese and Korean", () => {
    const boundary = resolveAsrLanguageBoundary("qwen3_asr", "qwen3-asr-0.6b");
    expect(boundary.kind).toBe("enumerated");
    if (boundary.kind !== "enumerated") {
      throw new Error("expected an enumerated boundary");
    }
    expect(boundary.codes).toHaveLength(30);
    for (const code of ["en", "zh", "ja", "ko", "yue", "fil"]) {
      expect(boundary.codes).toContain(code);
    }
    expect(boundary.label).toBe("30 languages + 22 Chinese dialects");
    const labels = asrLanguageOptions(boundary).map((option) => option.label);
    expect(labels).toContain("Filipino");
    expect(labels).toContain("Cantonese");
  });

  it("names and sorts the options it hands the picker", () => {
    const options = asrLanguageOptions(
      resolveAsrLanguageBoundary("parakeet", "parakeet-tdt-0.6b-v3"),
    );

    expect(options).toHaveLength(25);
    expect(options[0].label.localeCompare(options[1].label)).toBeLessThanOrEqual(0);
    expect(options).toContainEqual({ value: "uk", label: "Ukrainian" });
    expect(asrLanguageName("yue")).toBe("Cantonese");
    // An unnamed code degrades to itself rather than to a blank row.
    expect(asrLanguageName("zz")).toBe("zz");
  });

  it("can name every language code it offers", () => {
    for (const [provider, model] of [
      ["whisper", "large-v3-turbo"],
      ["parakeet", "parakeet-tdt-0.6b-v3"],
    ] as const) {
      const boundary = resolveAsrLanguageBoundary(provider, model);
      if (boundary.kind !== "enumerated") {
        throw new Error(`${provider}:${model} should enumerate its languages`);
      }
      for (const code of boundary.codes) {
        expect(ASR_LANGUAGE_NAMES[code], `missing name for ${code}`).toBeTruthy();
      }
    }
  });
});
