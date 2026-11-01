import { describe, expect, it } from "vitest";
import { buildDownloadedModelIndex, isModelOnDisk } from "../components/models/downloaded-models";

const onnx = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "LICENSE-WEIGHTS", "NOTICE.md"];
const native = ["orukeet-transcribe-cpp-Q8_0.gguf", "orukeet-r3-LICENSE-WEIGHTS", "orukeet-r3-NOTICE.md"];
const files = (provider: string, directory: string, names: string[]) => names.map((name) => ({ name, provider, path: `${directory}/${name}`, sizeBytes: 10 }));

describe("Orukeet downloaded model identity", () => {
  it("recognizes complete Moonshine Streaming Medium without counting partial downloads", () => {
    const model = "moonshine-streaming-medium-q8_0";
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", ["moonshine-streaming-medium-Q8_0.gguf"]);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", model)).toBe(true);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete.map(file => ({...file, path:file.path+".part"}))), "transcribe_cpp", model)).toBe(false);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete.map(file => ({...file, sizeBytes:0}))), "transcribe_cpp", model)).toBe(false);
  });


  it("counts Parakeet v3 present on its Core ML build alone, and removes every bundle with it", () => {
    const model = "parakeet-tdt-0.6b-v3-q8_0";
    const bundle = (name: string, sizeBytes: number) => ({
      name,
      provider: "transcribe_cpp",
      path: `/models/neural_engine/${name.replace(/ \(incomplete\)$/, "")}`,
      sizeBytes,
    });
    for (const speech of ["parakeet-tdt-0.6b-v3-coreml", "parakeet-tdt-0.6b-v2-coreml"]) {
      const index = buildDownloadedModelIndex([bundle(speech, 600), bundle("parakeet-ctc-110m-coreml", 100)]);
      expect(isModelOnDisk(index, "transcribe_cpp", model), speech).toBe(true);
      expect(index.filesByRoute.get(`transcribe_cpp:${model}`)).toEqual({
        paths: [`/models/neural_engine/${speech}`, "/models/neural_engine/parakeet-ctc-110m-coreml"],
        bytes: 700,
      });
    }
    // The vocabulary model alone, or an interrupted speech build, is not Parakeet.
    expect(isModelOnDisk(buildDownloadedModelIndex([bundle("parakeet-ctc-110m-coreml", 100)]), "transcribe_cpp", model)).toBe(false);
    expect(isModelOnDisk(buildDownloadedModelIndex([bundle("parakeet-tdt-0.6b-v3-coreml (incomplete)", 50)]), "transcribe_cpp", model)).toBe(false);
    // Both copies on an upgraded Mac: Remove takes both.
    const both = buildDownloadedModelIndex([
      ...files("transcribe_cpp", "/models/transcribe_cpp", ["parakeet-tdt-0.6b-v3-Q8_0.gguf"]),
      bundle("parakeet-tdt-0.6b-v3-coreml", 600),
    ]);
    expect(both.filesByRoute.get(`transcribe_cpp:${model}`)?.paths).toHaveLength(2);
  });

  it("recognizes Nemotron shared preview and final-dictation weights", () => {
    const model = "nemotron-3.5-asr-streaming-0.6b-q8_0";
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", ["nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"]);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", model)).toBe(true);
    expect(isModelOnDisk(buildDownloadedModelIndex([]), "transcribe_cpp", model)).toBe(false);
  });

  it.each([
    ["qwen3-asr-1.7b-q8_0", "Qwen3-ASR-1.7B-Q8_0.gguf", "qwen3-asr-0.6b-q6_k"],
    ["qwen3-asr-0.6b-q6_k", "Qwen3-ASR-0.6B-Q6_K.gguf", "qwen3-asr-1.7b-q8_0"],
  ])("recognizes only the complete, nonempty %s artifact", (model, fileName, otherModel) => {
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", [fileName]);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", model)).toBe(true);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", otherModel)).toBe(false);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete.map(file => ({ ...file, sizeBytes: 0 }))), "transcribe_cpp", model)).toBe(false);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete.map(file => ({ ...file, path: file.path + ".part" }))), "transcribe_cpp", model)).toBe(false);
  });
  it("requires Unified EN weights and retained model attribution", () => {
    const names = ["parakeet-unified-en-0.6b-Q8_0.gguf", "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md", "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf"];
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", names);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", "parakeet-unified-en-0.6b-q8_0")).toBe(true);
    for (const missing of names) {
      expect(isModelOnDisk(buildDownloadedModelIndex(complete.filter((file) => file.name !== missing)), "transcribe_cpp", "parakeet-unified-en-0.6b-q8_0")).toBe(false);
    }
  });

  it.each([["fluid-speech-mini"], ["underdog-bark-3.0-pro"]])("requires %s weights with their CC BY 4.0 license and notice", (stem) => {
    const model = `${stem}-q8_0`;
    const names = [`${stem}-q8_0.gguf`, `${stem}-LICENSE.txt`, `${stem}-NOTICE.txt`];
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", names);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", model)).toBe(true);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0")).toBe(false);
    for (const missing of names) {
      expect(isModelOnDisk(buildDownloadedModelIndex(complete.filter((file) => file.name !== missing)), "transcribe_cpp", model)).toBe(false);
    }
  });

  it("recognizes the complete ONNX bundle without marking legacy Parakeet present", () => {
    const index = buildDownloadedModelIndex(files("parakeet", "/models/parakeet/orukeet-v0.1.0-int8", onnx));
    expect(isModelOnDisk(index, "parakeet", "orukeet-v0.1.0-int8")).toBe(true);
    expect(isModelOnDisk(index, "parakeet", "parakeet-tdt-ctc-110m")).toBe(false);
    expect(index.totalBytes).toBe(60);
  });

  it("requires every ONNX artifact, including retained attribution", () => {
    for (const missing of onnx) {
      const index = buildDownloadedModelIndex(files("parakeet", "/models/parakeet/orukeet-v0.1.0-int8", onnx.filter((name) => name !== missing)));
      expect(isModelOnDisk(index, "parakeet", "orukeet-v0.1.0-int8"), missing).toBe(false);
    }
  });

  it("keeps native Orukeet distinct from native Parakeet and rejects partial or empty artifacts", () => {
    const complete = files("transcribe_cpp", "/models/transcribe_cpp", native);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", "orukeet-r3-q8_0")).toBe(true);
    expect(isModelOnDisk(buildDownloadedModelIndex(complete), "transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0")).toBe(false);
    for (const missing of native) {
      expect(isModelOnDisk(buildDownloadedModelIndex(complete.filter((file) => file.name !== missing)), "transcribe_cpp", "orukeet-r3-q8_0"), missing).toBe(false);
    }
    const empty = complete.map((file, i) => ({ ...file, sizeBytes: i === 0 ? 0 : file.sizeBytes }));
    expect(isModelOnDisk(buildDownloadedModelIndex(empty), "transcribe_cpp", "orukeet-r3-q8_0")).toBe(false);
    const partial = complete.map((file, i) => ({ ...file, path: i === 0 ? `${file.path}.part` : file.path }));
    expect(isModelOnDisk(buildDownloadedModelIndex(partial), "transcribe_cpp", "orukeet-r3-q8_0")).toBe(false);
  });
});
