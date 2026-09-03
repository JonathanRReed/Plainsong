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
    // `diarization-speakrs` is listed here for the same reason as
    // `ort-coreml`: it exists, it must stay out of `default`, and it must stay
    // out of the shipped set until a measurement justifies the cost. See
    // artifacts/qa/diarization-speakrs-spike-2026-09-02.md.
    for (const feature of [
      ...MACOS_SIDECAR_CARGO_FEATURES,
      "ort-coreml",
      "asr-transcribe-cpp",
      "diarization-speakrs",
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
    // The dependency behind it stays optional, and comes from crates.io at an
    // exact version. A `git` source is unresolvable from a cargo cache holding
    // only registry crates, which made `cargo metadata --locked --offline` fail
    // for EVERY feature set -- the default and release ones included, which
    // compile none of this -- and took `lint:rust`, `test:rust`,
    // `licenses:generate` and `release:mac` with it on an offline box.
    const dependency = cargoToml.match(/^transcribe-cpp = \{(.*)\}$/m)?.[1] ?? "";
    expect(dependency).toContain("optional = true");
    expect(dependency).toMatch(/version = "\d+\.\d+\.\d+"/);
    expect(dependency).not.toContain("git =");
    expect(dependency).not.toContain("branch =");
    expect(dependency).not.toContain("rev =");

    // ...and the lockfile pins it by checksum, which a git source cannot carry.
    const cargoLock = readRepoFile("rust-sidecar/Cargo.lock");
    const locked = cargoLock.match(
      /\[\[package\]\]\nname = "transcribe-cpp"\nversion = "([^"]+)"\nsource = "([^"]+)"\nchecksum = "([0-9a-f]{64})"/,
    );
    expect(locked?.[2]).toBe(
      "registry+https://github.com/rust-lang/crates.io-index",
    );
    expect(dependency).toContain(`version = "${locked?.[1]}"`);
  });

  it("keeps the spike's crates out of the release build's third-party notices", () => {
    // The spike's backend is named on the dependency line
    // (`features = ["metal"]`), NOT as a `whisper-gpu`-style
    // `transcribe-cpp?/metal` feature in `default`. A `dep?/feature` reference
    // from an enabled feature pulls the optional crate into the release resolve
    // graph even though nothing compiles it, and
    // scripts/generate-third-party-notices.mjs resolves that same graph -- so
    // that shape added transcribe-cpp and transcribe-cpp-sys to the shipped
    // notices (532 -> 534 Rust packages) for crates the shipped binary does not
    // contain.
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    // Any non-comment line naming `transcribe-cpp?/…` would be that shape.
    expect(cargoToml).not.toMatch(/^[^#\n]*"transcribe-cpp\?\/[^"]*"/m);
    const notices = readRepoFile("THIRD-PARTY-NOTICES.txt");
    expect(notices).not.toContain("transcribe-cpp");
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
