import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIARIZATION_DIR,
  MODELS_ROOT_SEGMENTS,
  assertIsolatedDataDir,
  modelsRootFor,
  parseCliArgs,
  parseCommunity1BundlePins,
  parseTranscribeCppPins,
  planInstall,
} from "../../scripts/install-staged-models.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const source = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const downloadMod = source("rust-sidecar/src/download/mod.rs");
const transcribeCpp = source("rust-sidecar/src/asr/transcribe_cpp.rs");
const STAGED_IDS = ["fluid-speech-mini-q8_0", "underdog-bark-3.0-pro-q8_0"];
const HEX64 = /^[0-9a-f]{64}$/;

describe("install-staged-models.ts pin parsing", () => {
  it("reads all six community-1 files and their digests from download/mod.rs", () => {
    const pins = parseCommunity1BundlePins(downloadMod);
    expect(pins.dirName).toBe("pyannote-community-1");
    expect(pins.files.map((file) => file.fileName).sort()).toEqual(
      [
        "pyannote-community-1-segmentation.onnx",
        "pyannote-community-1-embedding.onnx",
        "pyannote-community-1-plda.npz",
        "pyannote-community-1-xvec_transform.npz",
        "pyannote-community-1-LICENSE.txt",
        "pyannote-community-1-NOTICE.txt",
      ].sort(),
    );
    for (const file of pins.files) {
      expect(file.sha256, file.fileName).toMatch(HEX64);
      // The digest parsed is the one written beside that name in the source.
      expect(downloadMod).toContain(`"${file.fileName}",\n        "${file.sha256}"`);
    }
  });

  it("reads both staged GGUFs and their LICENSE/NOTICE pins from transcribe_cpp.rs", () => {
    const pins = parseTranscribeCppPins(transcribeCpp, STAGED_IDS);
    expect(pins.dirName).toBe("transcribe_cpp");
    expect(pins.models.map((model) => model.model.fileName)).toEqual([
      "fluid-speech-mini-q8_0.gguf",
      "underdog-bark-3.0-pro-q8_0.gguf",
    ]);
    expect(pins.models.map((model) => model.auxiliary.map((file) => file.fileName))).toEqual([
      ["fluid-speech-mini-LICENSE.txt", "fluid-speech-mini-NOTICE.txt"],
      ["underdog-bark-3.0-pro-LICENSE.txt", "underdog-bark-3.0-pro-NOTICE.txt"],
    ]);
    for (const file of pins.models.flatMap((model) => [model.model, ...model.auxiliary])) {
      expect(file.sha256, file.fileName).toMatch(HEX64);
      const nameAt = transcribeCpp.indexOf(`"${file.fileName}"`);
      expect(nameAt, file.fileName).toBeGreaterThan(-1);
      // The pin follows its own file name, before the next struct literal.
      const shaAt = transcribeCpp.indexOf(`sha256: "${file.sha256}"`, nameAt);
      expect(shaAt, file.fileName).toBeGreaterThan(nameAt);
      expect(transcribeCpp.slice(nameAt, shaAt)).not.toContain("},");
    }
  });

  it("fails loudly when a pin is missing or malformed", () => {
    expect(() => parseCommunity1BundlePins("")).toThrow(/COMMUNITY1_BUNDLE_DIR/);
    expect(() => parseTranscribeCppPins(transcribeCpp, ["no-such-model"])).toThrow(
      /no transcribe.cpp spec for no-such-model/,
    );
    const broken = downloadMod.replace(
      /("pyannote-community-1-plda.npz",\s*")[0-9a-f]{64}"/,
      '$1not-a-digest"',
    );
    expect(() => parseCommunity1BundlePins(broken)).toThrow(/not a 64-hex SHA-256/);
  });
});

describe("install-staged-models.ts path mapping", () => {
  it("uses the models root and diarization directory the sidecar joins onto data_dir()", () => {
    const [plainsong, models] = MODELS_ROOT_SEGMENTS;
    expect(source("rust-sidecar/src/paths.rs")).toContain(
      'directory_with_override("PLAINSONG_DATA_DIR", dirs::data_dir)',
    );
    expect(source("rust-sidecar/src/diarization/mod.rs")).toMatch(
      new RegExp(
        `fn diarization_models_dir\\(\\)[\\s\\S]*?\\.join\\("${plainsong}"\\)\\s*\\.join\\("${models}"\\)\\s*\\.join\\("${DIARIZATION_DIR}"\\)`,
      ),
    );
    expect(transcribeCpp).toMatch(
      new RegExp(`crate::paths::data_dir\\(\\)[\\s\\S]{0,80}\\.join\\("${plainsong}"\\)\\s*\\.join\\("${models}"\\)`),
    );
    expect(modelsRootFor("/tmp/qa")).toBe("/tmp/qa/Plainsong/models");
  });

  it("plans each artifact into the folder the app's download code writes", () => {
    const plan = planInstall({
      dataDir: "/tmp/qa",
      stagingDir: "/staging",
      community1: parseCommunity1BundlePins(downloadMod),
      transcribeCpp: parseTranscribeCppPins(transcribeCpp, STAGED_IDS),
    });
    const destinations = Object.fromEntries(plan.map((item) => [item.fileName, item.destination]));
    expect(plan).toHaveLength(12);
    expect(destinations["pyannote-community-1-segmentation.onnx"]).toBe(
      "/tmp/qa/Plainsong/models/diarization/pyannote-community-1/pyannote-community-1-segmentation.onnx",
    );
    expect(destinations["pyannote-community-1-NOTICE.txt"]).toBe(
      "/tmp/qa/Plainsong/models/diarization/pyannote-community-1/pyannote-community-1-NOTICE.txt",
    );
    expect(destinations["fluid-speech-mini-q8_0.gguf"]).toBe(
      "/tmp/qa/Plainsong/models/transcribe_cpp/fluid-speech-mini-q8_0.gguf",
    );
    expect(destinations["underdog-bark-3.0-pro-q8_0.gguf"]).toBe(
      "/tmp/qa/Plainsong/models/transcribe_cpp/underdog-bark-3.0-pro-q8_0.gguf",
    );
    expect(destinations["underdog-bark-3.0-pro-LICENSE.txt"]).toBe(
      "/tmp/qa/Plainsong/models/transcribe_cpp/underdog-bark-3.0-pro-LICENSE.txt",
    );
    for (const item of plan) expect(item.source).toBe(path.join("/staging", item.fileName));
  });
});

describe("install-staged-models.ts arguments", () => {
  it("requires --data-dir and resolves it to an absolute path", () => {
    expect(() => parseCliArgs(["--dry-run"], "/work")).toThrow(/--data-dir is required/);
    expect(() => parseCliArgs(["--data-dir"], "/work")).toThrow(/needs a value/);
    expect(parseCliArgs(["--data-dir", "qa", "--dry-run"], "/work")).toMatchObject({
      dataDir: "/work/qa",
      dryRun: true,
    });
  });

  it("refuses the real application-support location and anything inside it", () => {
    expect(() => assertIsolatedDataDir("/Users/q/Library/Application Support", "/Users/q")).toThrow(
      /Refusing/,
    );
    expect(() =>
      assertIsolatedDataDir("/Users/q/Library/Application Support/Plainsong", "/Users/q"),
    ).toThrow(/Refusing/);
    expect(() => assertIsolatedDataDir("/tmp/plainsong-qa", "/Users/q")).not.toThrow();
    expect(() =>
      assertIsolatedDataDir("/Users/q/Library/Application Support Backup", "/Users/q"),
    ).not.toThrow();
  });
});
