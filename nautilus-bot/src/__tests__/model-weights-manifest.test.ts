import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODEL_WEIGHTS,
  renderModelWeightsSection,
} from "../../scripts/model-weights-manifest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function sidecarSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const SIDECAR_MODEL_SOURCES = [
  "rust-sidecar/src/llm/bundled_local.rs",
  "rust-sidecar/src/llm/native_text.rs",
  "rust-sidecar/src/llm/builtin_embeddings.rs",
  "rust-sidecar/src/asr/whisper.rs",
  "rust-sidecar/src/asr/whisper_candle.rs",
  "rust-sidecar/src/asr/distil_whisper.rs",
  "rust-sidecar/src/asr/parakeet.rs",
  "rust-sidecar/src/asr/moonshine.rs",
  "rust-sidecar/src/asr/qwen3_asr.rs",
  "rust-sidecar/src/asr/cohere_local.rs",
  // The optional transcribe.cpp runtime pins its GGUFs here. It is compiled
  // out of the default feature set, but the notices cover what the app can
  // download, not what today's cargo flags happen to build.
  "rust-sidecar/src/asr/transcribe_cpp.rs",
  // Core ML builds of Parakeet for the Neural Engine speech helper.
  "rust-sidecar/src/asr/neural_engine.rs",
  "rust-sidecar/src/asr/speech_survey.rs",
  "rust-sidecar/src/download/mod.rs",
];

/**
 * Every upstream revision the sidecar downloads from: a 40-hex commit sha on a
 * line that is either a download URL or a revision constant. This is the set
 * the manifest has to account for -- a model added to the Rust source with a
 * new revision shows up here and fails the coverage test below until it is
 * written down.
 *
 * Word boundaries keep the 64-hex SHA-256 digests out: there is no boundary
 * inside a longer hex run, so a digest cannot be mistaken for a revision.
 */
function pinnedRevisionsInSidecar(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of SIDECAR_MODEL_SOURCES) {
    for (const line of sidecarSource(file).split("\n")) {
      if (!/revision|\bREV\b|https?:\/\//i.test(line)) continue;
      for (const revision of line.match(/\b[0-9a-f]{40}\b/g) ?? []) {
        found.set(revision, [...(found.get(revision) ?? []), file]);
      }
    }
  }
  return found;
}

describe("the model-weights manifest behind the notices' MODEL WEIGHTS section", () => {
  it("names a repository, revision, license and pin site for every artifact", () => {
    expect(MODEL_WEIGHTS.length).toBeGreaterThan(0);
    for (const entry of MODEL_WEIGHTS) {
      expect(entry.name.trim(), JSON.stringify(entry)).not.toBe("");
      expect(entry.usedFor.trim(), entry.name).not.toBe("");
      expect(entry.repository, entry.name).toMatch(/^https:\/\//);
      expect(entry.revision.trim(), entry.name).not.toBe("");
      expect(entry.license.trim(), entry.name).not.toBe("");
      expect(entry.files.length, entry.name).toBeGreaterThan(0);
      // The pin site is a real file, so a reader can check the claim.
      const [pinnedFile] = entry.pinnedIn.split(" ");
      expect(
        fs.existsSync(path.join(repoRoot, pinnedFile)),
        `${entry.name} points at ${pinnedFile}`,
      ).toBe(true);
    }
  });

  it("states a license or says plainly that upstream declares none", () => {
    // An invented SPDX id in a legal notice is worse than an honest gap, so
    // "not declared" is a permitted answer — but only with the flag that keeps
    // it visible in the rendered section and countable by a human.
    for (const entry of MODEL_WEIGHTS) {
      const declaresNone = entry.license.startsWith("not declared");
      expect(Boolean(entry.pendingLicenseReview), entry.name).toBe(declaresNone);
      if (entry.pendingLicenseReview) expect(entry.disabled, entry.name).toBe(true);
    }
    const rendered = renderModelWeightsSection();
    const pending = MODEL_WEIGHTS.filter((entry) => entry.pendingLicenseReview);
    if (pending.length > 0) {
      expect(rendered).toContain(
        `Artifacts whose upstream declares no license: ${pending.length}`,
      );
    }
  });

  it("pins enabled artifacts and keeps disabled revisions as license history", () => {
    const pinned = pinnedRevisionsInSidecar();
    for (const entry of MODEL_WEIGHTS) {
      const revision = entry.revision.split(" ")[0];
      if (entry.disabled) {
        expect(entry.note, entry.name).toMatch(/^Disabled:/);
        expect(pinned.has(revision), `${entry.name} must have no download URL`).toBe(false);
        continue;
      }
      if (revision === "main") {
        // The one branch pin. It is allowed only with a note saying how the
        // files are pinned instead, so the notice is not quietly weaker than
        // it looks.
        expect(entry.note, entry.name).toContain("SHA-256");
        continue;
      }
      expect(revision, entry.name).toMatch(/^[0-9a-f]{40}$/);
      expect(
        pinned.has(revision),
        `${entry.name} claims revision ${revision}, which no sidecar source pins`,
      ).toBe(true);
    }
  });

  it("accounts for every model revision pinned in the sidecar", () => {
    // The direction that catches a *new* model: a download revision added to
    // the Rust source with no manifest entry would otherwise ship with no
    // notice at all.
    const manifestRevisions = new Set(
      MODEL_WEIGHTS.map((entry) => entry.revision.split(" ")[0]),
    );
    const unaccounted: string[] = [];
    for (const [revision, files] of pinnedRevisionsInSidecar()) {
      if (manifestRevisions.has(revision)) continue;
      unaccounted.push(`${revision} (${[...new Set(files)].join(", ")})`);
    }
    expect(
      unaccounted,
      "every model revision the sidecar downloads from needs an entry in scripts/model-weights-manifest.mjs",
    ).toEqual([]);
  });

  it("carries the community-1 bundle's six files, its license and its credits", () => {
    const entry = MODEL_WEIGHTS.find((candidate) =>
      candidate.pinnedIn.includes("COMMUNITY1_BUNDLE"),
    );
    expect(entry, "the community-1 bundle needs a manifest entry").toBeDefined();
    expect(entry!.license).toBe("CC-BY-4.0");
    expect(entry!.pendingLicenseReview).toBeUndefined();
    // CC BY 4.0 attribution: creator, the components' authors, and the changes.
    expect(entry!.note).toContain("by pyannote");
    expect(entry!.note).toContain("WeSpeaker");
    expect(entry!.note).toContain("BUT Speech@FIT");
    expect(entry!.note).toContain("releases/tag/models-2026-10");

    const source = sidecarSource("rust-sidecar/src/download/mod.rs");
    const bundle = source.slice(
      source.indexOf("pub(crate) const COMMUNITY1_BUNDLE"),
      source.indexOf("/// Every file of the community-1 bundle"),
    );
    const pinnedFiles = [...bundle.matchAll(/community1_file!\(\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(pinnedFiles).toHaveLength(6);
    expect([...entry!.files].sort()).toEqual([...pinnedFiles].sort());
    expect(source).toContain(entry!.revision);
  });

  it("names the terms that are not the same as the code's", () => {
    const rendered = renderModelWeightsSection();
    // Parakeet's CC-BY-4.0 requires attribution; this file is the attribution.
    expect(rendered).toContain("CC-BY-4.0");
    expect(rendered).toContain("Attribution is a condition of use");
    // S1-mini's naming clause, in the exact capitalization it requires.
    expect(rendered).toContain('"S1-mini" by "Superwhisper"');
    expect(rendered).toContain("Orukeet v0.1.0 int8");
    expect(rendered).toContain("CC-BY-SA-4.0 weights");
    expect(rendered).toContain("LICENSE-WEIGHTS");
    expect(rendered).toContain("NOTICE.md");
    expect(rendered).toContain("required NVIDIA attribution");
    // And every artifact appears by name with its revision.
    for (const entry of MODEL_WEIGHTS) {
      expect(rendered).toContain(entry.name);
      expect(rendered).toContain(entry.revision);
    }
  });

  it("is what the committed notices file actually carries", () => {
    // The gate regenerates the notices and compares, so a manifest change that
    // was never regenerated would fail the release. Catch it here instead.
    const notices = fs.readFileSync(
      path.join(repoRoot, "THIRD-PARTY-NOTICES.txt"),
      "utf8",
    );
    expect(notices).toContain("\nMODEL WEIGHTS\n");
    expect(notices).toContain(
      `Downloadable model artifacts: ${MODEL_WEIGHTS.length}`,
    );
    expect(notices).toContain(renderModelWeightsSection());
  });
});


describe("Core ML file pins", () => {
  it("records exactly the sizes and digests the downloader verifies", () => {
    const source = sidecarSource("rust-sidecar/src/asr/neural_engine.rs");
    for (const prefix of ["PARAKEET_V3_COREML", "PARAKEET_V2_COREML", "PARAKEET_CTC_VOCABULARY"]) {
      const entry = MODEL_WEIGHTS.find((weight) => weight.pinnedIn ===
        `rust-sidecar/src/asr/neural_engine.rs (${prefix}_*)`);
      expect(entry).toBeDefined();
      if (!entry || !("artifacts" in entry)) throw new Error("Missing Core ML file pins");
      const section = source.split(`const ${prefix}_FILES:`)[1].split("\n];")[0];
      const pins = [...section.matchAll(/path: "([^"]+)",\s+size: ([\d_]+),\s+sha256: "([a-f0-9]+)"/g)]
        .map((match) => ({ path: match[1], size: Number(match[2].replaceAll("_", "")), sha256: match[3] }));
      expect(entry.artifacts).toEqual(pins);
    }
  });
});
