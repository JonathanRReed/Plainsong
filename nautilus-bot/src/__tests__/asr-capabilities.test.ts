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
  providerReturnsSpeakerLabels,
  resolveAsrLanguageBoundary,
} from "@/lib/asr-capabilities";
import { compareStrings } from "@/lib/format-locale";

describe("ASR capability mappings", () => {
  it("keeps Moonshine Streaming Medium experimental and English dictation only", () => {
    const id = "moonshine-streaming-medium-q8_0";
    expect(isMeetingEligibleModel("transcribe_cpp", id)).toBe(false);
    expect(asrModelTier("transcribe_cpp", id)).toBe("more");
    expect(resolveAsrLanguageBoundary("transcribe_cpp", id).kind).toBe("english_only");
    expect(getAsrModelCapability("transcribe_cpp", id)?.tradeoff).toMatch(/check numbers/i);
  });


  it("recognises only the engines this build can still run", () => {
    // 12 engines that shipped before September 2026, plus Deepgram, Gemini
    // Transcribe, Mistral Voxtral, xAI Grok and the offline Cohere Transcribe
    // route, plus `transcribe_cpp`, which only a sidecar built with
    // `--features asr-transcribe-cpp` ever reports. The renderer keeps a name
    // for that one so a developer build's route renders instead of silently
    // vanishing from the picker; nothing in a release build sends it.
    expect(ASR_PROVIDER_TYPES).toHaveLength(19);
    expect(isKnownAsrProvider("whisper")).toBe(true);
    expect(isKnownAsrProvider("parakeet")).toBe(true);
    expect(isKnownAsrProvider("macos_apple_speech")).toBe(true);
    expect(isKnownAsrProvider("deepgram")).toBe(true);
    expect(isKnownAsrProvider("gemini_transcribe")).toBe(true);
    expect(isKnownAsrProvider("mistral_voxtral")).toBe(true);
    expect(isKnownAsrProvider("xai_stt")).toBe(true);
    expect(isKnownAsrProvider("transcribe_cpp")).toBe(true);
    // The removed paid-tier route (name built from parts so a repository
    // search for it stays empty) is unknown, like any retired engine.
    expect(isKnownAsrProvider(["plainsong", "plus"].join("_"))).toBe(false);
    expect(isKnownAsrProvider("cohere_local")).toBe(true);
  });

  it("names only the providers that actually return speaker labels", () => {
    // This set is what decides whether a meeting keeps the provider's speakers
    // or pays for a local diarization pass, so a provider must not appear here
    // on the strength of being a cloud route. None of the four cloud providers
    // that shipped before September 2026 returns labels at all.
    expect(providerReturnsSpeakerLabels("deepgram")).toBe(true);
    expect(providerReturnsSpeakerLabels("gemini_transcribe")).toBe(true);
    expect(providerReturnsSpeakerLabels("mistral_voxtral")).toBe(true);
    for (const providerType of [
      "openai_cloud",
      "groq",
      "elevenlabs_scribe",
      "cohere_transcribe",
      "parakeet",
      "whisper",
      "distil_whisper",
      "qwen3_asr",
      "macos_apple_speech",
    ] as const) {
      expect(
        providerReturnsSpeakerLabels(providerType),
        `${providerType} does not return speaker labels`,
      ).toBe(false);
    }
  });

  it("keeps the websocket-only Gemini model out of the meeting lane", () => {
    // gemini-3.5-transcribe-live cannot diarize and is not served by the batch
    // interactions endpoint the provider posts to.
    expect(isMeetingEligibleModel("gemini_transcribe", "gemini-3.5-transcribe")).toBe(true);
    expect(isMeetingEligibleModel("gemini_transcribe", "gemini-3.5-transcribe-live")).toBe(
      false,
    );
    expect(isMeetingEligibleModel("deepgram", "nova-3")).toBe(true);
    expect(isMeetingEligibleModel("deepgram", "nova-3-medical")).toBe(true);
    expect(isMeetingEligibleModel("deepgram", "flux")).toBe(false);
  });

  it("keeps the websocket-only Voxtral model out of the meeting lane", () => {
    // voxtral-mini-realtime-2602 is Mistral's realtime route; it cannot
    // diarize and is not served by the batch /v1/audio/transcriptions
    // endpoint the provider posts to. voxtral-mini-2507 is the deprecated
    // v25.07 predecessor.
    expect(isMeetingEligibleModel("mistral_voxtral", "voxtral-mini-2602")).toBe(true);
    expect(
      isMeetingEligibleModel("mistral_voxtral", "voxtral-mini-realtime-2602"),
    ).toBe(false);
    expect(isMeetingEligibleModel("mistral_voxtral", "voxtral-mini-2507")).toBe(false);
    // The moving alias is not a model id the meeting lane accepts either; the
    // sidecar normalizes it to the pinned snapshot before it gets here.
    expect(isMeetingEligibleModel("mistral_voxtral", "voxtral-mini-latest")).toBe(false);
  });

  it("rejects the deleted Python-backed engines a stale settings file may still name", () => {
    expect(isKnownAsrProvider("mlx_audio")).toBe(false);
    expect(isKnownAsrProvider("voxtral")).toBe(false);
    expect(isKnownAsrProvider("")).toBe(false);
    expect(isKnownAsrProvider(null)).toBe(false);
    expect(isKnownAsrProvider(undefined)).toBe(false);
  });

  it("keeps frontend provider eligibility aligned with backend meeting rules", () => {
    // whisper.cpp is per model (see the matrix below), so the provider as a
    // whole is neither dictation-only nor meeting-grade.
    expect(isDictationOnlyProvider("whisper")).toBe(false);
    expect(isDictationOnlyProvider("moonshine")).toBe(true);
    expect(isDictationOnlyProvider("whisper_candle")).toBe(true);
    expect(isMeetingEligibleProvider("distil_whisper")).toBe(true);
    expect(isMeetingEligibleProvider("parakeet")).toBe(true);
    expect(isMeetingEligibleProvider("openai_cloud")).toBe(true);
    expect(isMeetingEligibleProvider("whisper_candle")).toBe(false);
    expect(isSharedMeetingCompatible("distil_whisper", "distil-large-v3.5")).toBe(true);
    expect(isSharedMeetingCompatible("parakeet", "parakeet-tdt-0.6b-v3")).toBe(true);
    expect(isSharedMeetingCompatible("parakeet", "parakeet-tdt-0.6b-v2")).toBe(false);
    expect(isSharedMeetingCompatible("parakeet", "orukeet-v0.1.0-int8")).toBe(false);
    expect(isSharedMeetingCompatible("whisper", "base.en")).toBe(false);
    expect(isSharedMeetingCompatible("whisper_candle", "whisper-large-v3-turbo")).toBe(false);
  });

  it("admits only the multilingual whisper.cpp models from small up to the meeting lane", () => {
    // Mirrors WHISPER_MEETING_MODEL_IDS in rust-sidecar/src/lib.rs.
    for (const modelId of ["small", "medium", "large-v3", "large-v3-turbo"]) {
      expect(isSharedMeetingCompatible("whisper", modelId)).toBe(true);
    }
    for (const modelId of ["tiny", "tiny.en", "base", "base.en", "small.en", "medium.en"]) {
      expect(isSharedMeetingCompatible("whisper", modelId)).toBe(false);
    }
    // No meeting-safe default: the provider default is base.en.
    expect(isMeetingEligibleModel("whisper", "")).toBe(false);
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
  it("keeps native Qwen 0.6B scoped to experimental English dictation", () => {
    const model = "qwen3-asr-0.6b-q6_k";
    const capability = getAsrModelCapability("transcribe_cpp", model);
    expect(capability).toMatchObject({
      sizeMib: 658,
      tier: "more",
      pauseBehavior: "encoder_decoder",
      languages: { englishOnly: true },
      languageEvidence: { basis: "upstream_listed", verifiedLanguages: [] },
    });
    expect(capability?.tradeoff).toContain("Experimental, for short English dictation");
    expect(isMeetingEligibleModel("transcribe_cpp", model)).toBe(false);
    expect(resolveAsrLanguageBoundary("transcribe_cpp", model).kind).toBe("english_only");
  });

  it("offers Nemotron final dictation as an experimental English option", () => {
    const model = "nemotron-3.5-asr-streaming-0.6b-q8_0";
    expect(getAsrModelCapability("transcribe_cpp", model)?.languages.englishOnly).toBe(true);
    expect(asrModelTier("transcribe_cpp", model)).toBe("more");
    expect(isMeetingEligibleModel("transcribe_cpp", model)).toBe(false);
    expect(resolveAsrLanguageBoundary("transcribe_cpp", model).kind).toBe("english_only");
  });

  it("offers Unified EN for experimental English meetings", () => {
    const model = "parakeet-unified-en-0.6b-q8_0";
    expect(getAsrModelCapability("transcribe_cpp", model)?.languages.englishOnly).toBe(true);
    expect(asrModelTier("transcribe_cpp", model)).toBe("more");
    expect(isMeetingEligibleModel("transcribe_cpp", model)).toBe(true);
    expect(isMeetingEligibleModel("transcribe_cpp", "orukeet-r3-q8_0")).toBe(false);
    expect(isMeetingEligibleModel("transcribe_cpp", "qwen3-asr-1.7b-q8_0")).toBe(false);
    expect(getAsrModelCapability("transcribe_cpp", "qwen3-asr-1.7b-q8_0")?.languages.englishOnly).toBe(true);
    expect(isMeetingEligibleModel("transcribe_cpp", "nemotron-3.5-asr-streaming-0.6b-q8_0")).toBe(false);
    expect(isMeetingEligibleModel("transcribe_cpp", `${model}-unknown`)).toBe(false);
    expect(resolveAsrLanguageBoundary("transcribe_cpp", model).kind).toBe("english_only");
  });

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
      besidesEnglish: "24 other European languages",
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
    expect(getAsrModelCapability("parakeet", "parakeet-tdt-0.6b-v2")?.sizeMib).toBe(631);
    expect(getAsrModelCapability("parakeet", "orukeet-v0.1.0-int8")?.sizeMib).toBe(640);
    expect(getAsrModelCapability("distil_whisper", "distil-large-v3.5")?.sizeMib).toBe(2888);
  });

  it("states one size for base and base.en, which are the same size on disk", () => {
    // 147,964,211 bytes each: 141.1 MiB, or 148.0 MB. Carrying one entry in
    // each unit is what made `base`'s "same size" tradeoff contradict the two
    // numbers rendered beside it.
    const base = getAsrModelCapability("whisper", "base");
    const baseEn = getAsrModelCapability("whisper", "base.en");
    expect(base?.sizeMib).toBe(baseEn?.sizeMib);
    expect(base?.tradeoff).toContain("at the same size");
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
    expect(asrModelTier("parakeet", "parakeet-tdt-0.6b-v2")).toBe("more");
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

  it("converts the stored binary units to the decimal MB and GB Finder shows", () => {
    // The table stores MiB. Relabelling 142 MiB as "142 MB" would understate
    // the file by ~5%; converting gives the number Finder prints.
    expect(formatModelSize(142)).toBe("149 MB");
    expect(formatModelSize(639)).toBe("670 MB");
    expect(formatModelSize(705)).toBe("739 MB");
    expect(formatModelSize(1620)).toBe("1.7 GB");
    expect(formatModelSize(2900)).toBe("3.0 GB");
    expect(formatModelSize(953)).toBe("999 MB");
    expect(formatModelSize(954)).toBe("1.0 GB");
    expect(formatModelSize(0)).toBe("size unknown");
  });

  it("describes a model in one sentence that names the downside", () => {
    const baseEn = describeAsrModel("whisper", "base.en");
    expect(baseEn).toBe(
      "149 MB. English only. Speak Spanish or German into it and it returns English-sounding nonsense rather than admitting it can't.",
    );

    // What Plainsong tested stays apart from what the model was built for.
    const turbo = describeAsrModel("whisper", "large-v3-turbo");
    expect(turbo).toContain("1.7 GB");
    expect(turbo).toContain("Built for about 100 languages. Not yet tested in Plainsong.");
    expect(turbo).toContain("slower");

    // ONNX Parakeet is only ever offered where it is the one Parakeet v3, so
    // there is nothing to compare it with.
    const parakeet = describeAsrModel("parakeet", "parakeet-tdt-0.6b-v3");
    expect(parakeet).toContain("Tested in English. Also built for 24 other European languages.");
    expect(parakeet).toContain("One download covers dictation and meetings.");
    expect(parakeet).not.toMatch(/any Mac|Compatible|more mistakes|twice the memory/);
    expect(describeAsrModel("transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0")).not.toMatch(
      /Compatible|second copy/,
    );

    const parakeetV2 = describeAsrModel("parakeet", "parakeet-tdt-0.6b-v2");
    expect(parakeetV2).toContain("English only. Not yet tested in Plainsong.");
    expect(parakeetV2).toContain("hasn't compared");

    const orukeet = describeAsrModel("parakeet", "orukeet-v0.1.0-int8");
    expect(orukeet).toContain("English only.");
    expect(orukeet).not.toContain("Not yet tested");
    expect(orukeet).toContain("hasn't shown it does better than the recommended model");

    // No build or hardware jargon in what a picker prints.
    for (const [provider, model] of [
      ["parakeet", "parakeet-tdt-0.6b-v3"],
      ["transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"],
      ["qwen3_asr", "qwen3-asr-0.6b"],
      ["cohere_local", "cohere-transcribe-03-2026-q4"],
      ["whistle", "whistle-2.0.0"],
    ] as const) {
      expect(describeAsrModel(provider, model)).not.toMatch(
        /\b(?:GPU|CPU|ONNX|GGUF|Metal|int[48]|upstream|weights|decodes?|runtime)\b/i,
      );
    }
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
    // the copy must say so and must name the speed cost, not hide it.
    expect(cap?.languageEvidence.verifiedLanguages).toEqual(["English"]);
    const summary = describeAsrModel("qwen3_asr", "qwen3-asr-0.6b");
    expect(summary).toContain("Tested in English. Also built for 29 other languages and 22 Chinese dialects.");
    expect(summary).toContain("Experimental");
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

  it("says whose claim a diarizing cloud route's languages are", () => {
    // Neither has a capability-table entry -- that table is about downloads,
    // and a hosted route has none -- so both used to fall through to the
    // generic "the selected model's languages", which tells a user nothing
    // about a route they are paying per minute for.
    expect(getAsrModelCapability("deepgram", "nova-3")).toBeNull();
    expect(
      getAsrModelCapability("gemini_transcribe", "gemini-3.5-transcribe"),
    ).toBeNull();

    for (const [provider, model, expected] of [
      ["deepgram", "nova-3", "multilingual code-switching, listed by Deepgram"],
      ["deepgram", "nova-3-medical", "English, listed by Deepgram"],
      [
        "gemini_transcribe",
        "gemini-3.5-transcribe",
        "85+ languages, listed by Google",
      ],
    ] as const) {
      const boundary = resolveAsrLanguageBoundary(provider, model);
      // Unenumerated, not enumerated: Plainsong has never exercised these
      // sets, and a fabricated list in the session-language picker would be a
      // capability claim the app cannot back.
      expect(boundary.kind).toBe("unenumerated");
      expect(boundary.label).toBe(expected);
      expect(boundary.label).not.toBe("the selected model's languages");
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
    expect(compareStrings(options[0].label, options[1].label)).toBeLessThanOrEqual(0);
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
