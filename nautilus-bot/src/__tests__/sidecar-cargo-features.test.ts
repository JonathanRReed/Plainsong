import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MACOS_SIDECAR_CARGO_FEATURES,
  sidecarCargoFeatureArgs,
} from "../../scripts/sidecar-cargo-features.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(repoRoot, "..");

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("sidecar cargo feature set", () => {
  it("ships compact meeting storage and macOS acceleration features", () => {
    // ort-coreml measured as a regression on Moonshine (24 s first-load
    // compile, slower steady state); see
    // artifacts/qa/acceleration-receipt-2026-09-01.md before adding it back.
    expect([...MACOS_SIDECAR_CARGO_FEATURES]).toEqual([
      "meeting-audio-16k",
      "candle-metal",
      "asr-transcribe-cpp",
      "diarization-nemotron",
      "ort-coreml-ep",
    ]);
    expect(sidecarCargoFeatureArgs("darwin")).toEqual([
      "--features",
      "meeting-audio-16k,candle-metal,asr-transcribe-cpp,diarization-nemotron,ort-coreml-ep",
    ]);
    expect(sidecarCargoFeatureArgs("win32")).toEqual([]);
    expect(sidecarCargoFeatureArgs("linux")).toEqual([]);
  });

  it("keeps platform features optional and compact meeting audio in defaults", () => {
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    const defaultLine = cargoToml.match(/^default = \[(.*)\]$/m)?.[1] ?? "";
    for (const feature of [
      ...MACOS_SIDECAR_CARGO_FEATURES,
      "ort-coreml",
      "asr-transcribe-cpp",
      "diarization-nemotron",
    ]) {
      expect(cargoToml).toMatch(new RegExp(`^${feature} = \\[`, "m"));
      if (feature === "meeting-audio-16k") expect(defaultLine).toContain(`"${feature}"`);
      else expect(defaultLine).not.toContain(feature);
    }
  });

  it("includes the qualified native runtime in macOS builds with a pinned dependency", () => {
    expect([...MACOS_SIDECAR_CARGO_FEATURES]).toContain(
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

  it("includes the native runtime's crates in the build's third-party notices", () => {
    // The spike's backend is named on the dependency line
    // (`features = ["metal"]`), NOT as a `whisper-gpu`-style
    // `transcribe-cpp?/metal` feature in `default`. A `dep?/feature` reference
    // from an enabled feature pulls the optional crate into the release resolve
    // graph even though nothing compiles it, and
    // scripts/generate-third-party-notices.ts resolves that same graph -- so
    // that shape added transcribe-cpp and transcribe-cpp-sys to the shipped
    // notices (532 -> 534 Rust packages) for crates the shipped binary does not
    // contain.
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    // Any non-comment line naming `transcribe-cpp?/…` would be that shape.
    expect(cargoToml).not.toMatch(/^[^#\n]*"transcribe-cpp\?\/[^"]*"/m);
    const notices = readRepoFile("THIRD-PARTY-NOTICES.txt");
    const dependencyIndex = notices.split("RUST DEPENDENCY INDEX")[1]?.split("RUST LICENSE DOCUMENTS")[0];
    expect(dependencyIndex).toBeDefined();
    expect(dependencyIndex).toMatch(/^transcribe-cpp\s/m);
    expect(dependencyIndex).toMatch(/^transcribe-cpp-sys\s/m);
  });

  it("uses one feature list for the release build, cargo wrapper, notices, and CI", () => {
    const sidecarBuild = readRepoFile("scripts/build-rust-sidecar.ts");
    expect(sidecarBuild).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";',
    );
    expect(sidecarBuild).toMatch(
      /manifestPath,\s*\.\.\.sidecarCargoFeatureArgs\(\),\s*"--bin",\s*"plainsong-sidecar"/,
    );

    const cargoWrapper = readRepoFile("scripts/cargo-sidecar.ts");
    expect(cargoWrapper).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";',
    );
    expect(cargoWrapper).toMatch(
      /"--manifest-path",\s*manifestPath,/,
    );

    expect(cargoWrapper).toContain("sidecarCargoFeatureArgs()");

    const notices = readRepoFile("scripts/generate-third-party-notices.ts");
    expect(notices).toContain(
      'import { sidecarCargoFeatureArgs } from "./sidecar-cargo-features.ts";',
    );
    expect(notices).toMatch(
      /cargoMetadataFor\(cargoManifestPath, sidecarCargoFeatureArgs\(\)\)/,
    );
    expect(notices).toMatch(/cargoMetadataFor\(textHelperManifestPath, \[\]\)/);

    const ci = fs.readFileSync(
      path.join(workspaceRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ci).toContain(
      "bun scripts/cargo-sidecar.ts clippy --locked --all-targets -- -D warnings",
    );
    expect(ci).toContain("bun scripts/cargo-sidecar.ts test --locked --lib --bins");
    expect(ci).not.toMatch(/run: cargo (clippy|test) /);
  });
});
