import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sidecarCargoFeatureArgs } from "../../scripts/sidecar-cargo-features.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const wrapper = path.join(repoRoot, "scripts/cargo-sidecar.ts");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-cargo-wrapper-"));
const argsFile = path.join(tempRoot, "cargo-args.txt");

// A stand-in `cargo` on PATH that records its argv and then exits with a
// status, or kills itself with a signal, depending on CARGO_FAKE_MODE.
fs.writeFileSync(
  path.join(tempRoot, "cargo"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > "$CARGO_FAKE_ARGS"',
    'case "$CARGO_FAKE_MODE" in',
    "  signal) kill -TERM $$ ;;",
    "  status) exit 3 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

function runWrapper(mode: string, args: string[]) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tempRoot}${path.delimiter}${process.env.PATH ?? ""}`,
      CARGO_FAKE_MODE: mode,
      CARGO_FAKE_ARGS: argsFile,
    },
  });
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("scripts/cargo-sidecar.ts", () => {
  it("adds the manifest and the host feature set and passes `--` args through untouched", () => {
    const result = runWrapper("status", [
      "clippy",
      "--locked",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    expect(result.status).toBe(3);
    const recorded = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
    expect(recorded[0]).toBe("clippy");
    expect(recorded[1]).toBe("--manifest-path");
    expect(recorded[2]).toBe(path.join(repoRoot, "rust-sidecar", "Cargo.toml"));
    expect(recorded.slice(3, 3 + sidecarCargoFeatureArgs().length)).toEqual(
      sidecarCargoFeatureArgs(),
    );
    expect(recorded.slice(-5)).toEqual(["--locked", "--all-targets", "--", "-D", "warnings"]);
  });

  it("keeps explicit feature-matrix checks free of host release features", () => {
    const result = runWrapper("ok", ["check", "--locked", "--no-default-features", "--features", "asr-whisper", "--lib", "--tests"]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual([
      "check", "--manifest-path", path.join(repoRoot, "rust-sidecar", "Cargo.toml"),
      "--locked", "--no-default-features", "--features", "asr-whisper", "--lib", "--tests",
    ]);
  });

  it("runs fmt without unsupported feature flags", () => {
    const result = runWrapper("ok", ["fmt", "--check"]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual([
      "fmt", "--manifest-path", path.join(repoRoot, "rust-sidecar", "Cargo.toml"), "--check",
    ]);
  });

  it("checks the separate text helper without sidecar-only features", () => {
    const result = runWrapper("ok", ["--text-helper", "test", "--locked"]);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual([
      "test", "--manifest-path", path.join(repoRoot, "rust-sidecar", "text-helper", "Cargo.toml"), "--locked",
    ]);
  });

  it("relays a signal-terminated cargo instead of reporting exit 1", () => {
    const result = runWrapper("signal", ["build", "--locked"]);
    expect(result.stderr).toContain("cargo terminated by SIGTERM");
    // Either the re-raised signal ends the wrapper, or the 128 + N fallback does.
    expect(result.signal === "SIGTERM" || result.status === 128 + os.constants.signals.SIGTERM).toBe(
      true,
    );
    expect(result.status).not.toBe(1);
  });

  it("rejects a missing or flag-shaped subcommand with a usage error", () => {
    expect(runWrapper("ok", []).status).toBe(2);
    expect(runWrapper("ok", ["--locked"]).status).toBe(2);
  });
});
