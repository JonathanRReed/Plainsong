import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MACOS_SIDECAR_CARGO_FEATURES,
  sidecarCargoFeatureArgs,
} from "../../scripts/sidecar-cargo-features.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(repoRoot, "..");

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("sidecar cargo feature set", () => {
  it("ships Candle Metal on macOS only, and keeps ort-coreml off", () => {
    // ort-coreml measured as a regression on Moonshine (24 s first-load
    // compile, slower steady state); see
    // artifacts/qa/acceleration-receipt-2026-09-01.md before adding it back.
    expect([...MACOS_SIDECAR_CARGO_FEATURES]).toEqual(["candle-metal"]);
    expect(sidecarCargoFeatureArgs("darwin")).toEqual([
      "--features",
      "candle-metal",
    ]);
    expect(sidecarCargoFeatureArgs("win32")).toEqual([]);
    expect(sidecarCargoFeatureArgs("linux")).toEqual([]);
  });

  it("keeps the opt-in features out of Cargo.toml's default set", () => {
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    const defaultLine = cargoToml.match(/^default = \[(.*)\]$/m)?.[1] ?? "";
    for (const feature of [
      ...MACOS_SIDECAR_CARGO_FEATURES,
      "ort-coreml",
      "asr-transcribe-cpp",
    ]) {
      expect(cargoToml).toMatch(new RegExp(`^${feature} = \\[`, "m"));
      expect(defaultLine).not.toContain(feature);
    }
  });

  it("leaves the transcribe.cpp spike out of every build users get", () => {
    // The spike is evidence for a decision, not a shipped route: it must not
    // be in `default` (checked above), and it must not be in the macOS
    // release feature list either, or every DMG would carry a second ggml
    // runtime and a second copy of the Parakeet weights' worth of code.
    expect([...MACOS_SIDECAR_CARGO_FEATURES]).not.toContain(
      "asr-transcribe-cpp",
    );
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    // The git dependency behind it stays optional, and pinned to a commit
    // rather than a branch, so `--locked` builds are reproducible.
    const dependency = cargoToml.match(/^transcribe-cpp = \{(.*)\}$/m)?.[1] ?? "";
    expect(dependency).toContain("optional = true");
    expect(dependency).toMatch(/rev = "[0-9a-f]{40}"/);
    expect(dependency).not.toContain("branch =");
  });

  it("uses one feature list for the release build, cargo wrapper, notices, and CI", () => {
    const sidecarBuild = readRepoFile("scripts/build-rust-sidecar.mjs");
    expect(sidecarBuild).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.mjs";',
    );
    expect(sidecarBuild).toMatch(
      /manifestPath,\s*\.\.\.sidecarCargoFeatureArgs\(\),\s*"--bin",\s*"plainsong-sidecar"/,
    );

    const cargoWrapper = readRepoFile("scripts/cargo-sidecar.mjs");
    expect(cargoWrapper).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.mjs";',
    );
    expect(cargoWrapper).toMatch(
      /"--manifest-path",\s*manifestPath,\s*\.\.\.sidecarCargoFeatureArgs\(\)/,
    );

    const notices = readRepoFile("scripts/generate-third-party-notices.mjs");
    expect(notices).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.mjs";',
    );
    expect(notices).toMatch(
      /"metadata",[\s\S]*?cargoManifestPath,[\s\S]*?\.\.\.sidecarCargoFeatureArgs\(\),/,
    );

    const ci = fs.readFileSync(
      path.join(workspaceRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ci).toContain(
      "node scripts/cargo-sidecar.mjs clippy --locked --all-targets -- -D warnings",
    );
    expect(ci).toContain("node scripts/cargo-sidecar.mjs test --locked --lib --bins");
    expect(ci).not.toMatch(/run: cargo (clippy|test) /);
  });
});
