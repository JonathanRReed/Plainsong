import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(repoRoot, "..");

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readWorkspaceFile(relativePath: string) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function expectInOrder(source: string, values: string[]) {
  let previousIndex = -1;
  for (const value of values) {
    const index = source.indexOf(value);
    expect(index, `missing ${value}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function workflowRunBody(source: string, stepName: string) {
  const lines = source.split("\n");
  const start = lines.indexOf(`      - name: ${stepName}`);
  if (start < 0) throw new Error(`Missing workflow step: ${stepName}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("      - "));
  const step = lines.slice(start + 1, next < 0 ? undefined : next);
  const run = step.indexOf("        run: |");
  if (run < 0) throw new Error(`Missing shell body: ${stepName}`);
  const body: string[] = [];
  for (const line of step.slice(run + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  if (!body.some((line) => line.trim())) throw new Error(`Empty shell body: ${stepName}`);
  return body.join("\n");
}

describe("reproducible package and release configuration", () => {
  it("aligns the first beta identity and stages its channel assets", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      version: string;
    };
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    const cargoLock = readRepoFile("rust-sidecar/Cargo.lock");
    const builder = readRepoFile("electron-builder.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");

    // The beta identity is whatever package.json says; the point of this
    // test is that Cargo.toml and Cargo.lock carry the *same* version and
    // that it is still a 0.9.0 beta, not that it equals one hardcoded tag
    // (which broke on the beta.2 -> beta.3 bump).
    expect(packageJson.version).toMatch(/^0\.9\.0-beta\.\d+$/);
    const escapedVersion = packageJson.version.replace(/\./g, "\\.");
    expect(cargoToml).toMatch(new RegExp(`^version = "${escapedVersion}"$`, "m"));
    expect(cargoLock).toMatch(
      new RegExp(`name = "plainsong"\\nversion = "${escapedVersion}"`),
    );
    expect(builder).toMatch(
      /publish:\s*[\s\S]*?provider:\s*generic[\s\S]*?url:\s*https:\/\/updates\.plainsong\.jonathanrreed\.com\/beta\/[\s\S]*?channel:\s*beta[\s\S]*?useMultipleRangeRequest:\s*false/,
    );
    expect(release).not.toContain("release/latest-mac.yml");
    expect(release).toContain('EXPECTED_TAG="v$PKG"');
    expect(release).toContain("shasum -a 256 -c SHA256SUMS");
    expect(release).not.toContain("Stage verified draft release");
  });

  it("stages the validated prerelease classification and refuses published releases", () => {
    const release = readWorkspaceFile(".github/workflows/release.yml");
    const validate = workflowRunBody(release, "Validate release tag name");
    const stage = workflowRunBody(release, "Stage artifact-only draft release");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-release-workflow-"));
    try {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "gh"), String.raw`#!/bin/bash
printf '%s\0' "$@" >> "$GH_LOG"
printf '\n' >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  if [ "$GH_STATE" = "missing" ]; then exit 1; fi
  for argument in "$@"; do
    if [ "$argument" = "--json" ]; then
      if [ "$GH_STATE" = "draft" ]; then printf 'true\n'; else printf 'false\n'; fi
      break
    fi
  done
fi
`, { mode: 0o700 });
      const cases = [
        { tag: "v0.9.0-beta.6", prerelease: true, state: "missing" },
        { tag: "v0.9.0-beta.6", prerelease: true, state: "draft" },
        { tag: "v0.9.0", prerelease: false, state: "missing" },
        { tag: "v0.9.0", prerelease: false, state: "draft" },
        { tag: "v0.9.0+build-preview", prerelease: false, state: "missing" },
        { tag: "v0.9.0-beta.6+build", prerelease: true, state: "missing" },
        { tag: "v0.9.0-beta.6", prerelease: true, state: "published" },
      ] satisfies { tag: string; prerelease: boolean; state: "missing" | "draft" | "published" }[];
      for (const [index, scenario] of cases.entries()) {
        const cwd = path.join(root, String(index));
        fs.mkdirSync(path.join(cwd, "release"), { recursive: true });
        for (const filename of ["Plainsong.dmg", "Plainsong-mac.zip", "Plainsong-mac.zip.blockmap", "beta-mac.yml", "SHA256SUMS"]) {
          fs.writeFileSync(path.join(cwd, "release", filename), "public fixture\n");
        }
        const output = path.join(cwd, "outputs");
        const log = path.join(cwd, "gh-log");
        const env = {
          HOME: cwd, PATH: `${bin}:/usr/bin:/bin`, GH_TOKEN: "", GH_LOG: log,
          GH_STATE: scenario.state, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "fixture/plainsong",
          RELEASE_TAG: scenario.tag,
        };
        const validated = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", validate], {
          cwd, env, encoding: "utf8", timeout: 5000,
        });
        expect(validated.error, scenario.tag).toBeUndefined();
        expect(validated.status, validated.stderr).toBe(0);
        const outputs = new Map<string, string>(fs.readFileSync(output, "utf8").trim().split("\n").map((line): [string, string] => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));
        expect(outputs.get("tag")).toBe(scenario.tag);
        expect(outputs.get("ref")).toBe(`refs/tags/${scenario.tag}`);
        const prerelease = outputs.get("prerelease") ?? String(scenario.prerelease);
        const staged = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", stage], {
          cwd, env: { ...env, RELEASE_PRERELEASE: prerelease }, encoding: "utf8", timeout: 5000,
        });
        expect(staged.error, scenario.tag).toBeUndefined();
        const calls = fs.readFileSync(log, "utf8").trimEnd().split("\n").map((line) => line.split("\0").filter(Boolean));
        const mutations = calls.filter((call) => call[1] !== "view");
        if (scenario.state === "published") {
          expect(staged.status).not.toBe(0);
          expect(staged.stderr).toContain("Refusing to modify published release");
          expect(mutations).toEqual([]);
        } else {
          expect(staged.status, staged.stderr).toBe(0);
          expect(mutations.map((call) => call[1])).toEqual(scenario.state === "missing" ? ["create"] : ["edit", "upload"]);
          expect(mutations[0]).toContain(`--prerelease=${scenario.prerelease}`);
          expect(mutations[0]).toContain(scenario.tag);
          if (scenario.state === "missing") expect(mutations[0]).toContain("--draft");
        }
        expect(outputs.get("prerelease")).toBe(String(scenario.prerelease));
      }
    expect(release).toContain("prerelease: ${{ steps.release-ref.outputs.prerelease }}");
    expect(release).toContain("RELEASE_PRERELEASE: ${{ needs.verify-ref.outputs.prerelease }}");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins Bun and Knip to the declared local toolchain", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const knipConfig = JSON.parse(readRepoFile("knip.json")) as {
      $schema: string;
    };

    expect(packageJson.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(packageJson.devDependencies.knip).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.scripts["gate:dead-code"]).toContain(
      "bunx --no-install knip",
    );
    expect(knipConfig.$schema).toBe(
      "https://unpkg.com/knip@6.32.2/schema.json",
    );
  });

  it("includes test configuration in source identity", () => {
    const sourceGate = readRepoFile("scripts/capture-source-gates.ts");
    expect(sourceGate).toContain("vite(?:st)?\\.config");
  });

  it("keeps contributor and release Cargo commands locked", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const sidecarBuild = readRepoFile("scripts/build-rust-sidecar.ts");

    // Contributor cargo commands go through scripts/cargo-sidecar.ts so they
    // compile the same feature set the release sidecar ships on this host;
    // that wrapper's feature handling is pinned in
    // sidecar-cargo-features.test.ts. Here: still `--locked`.
    expect(packageJson.scripts["lint:rust"]).toContain(
      "bun scripts/cargo-sidecar.ts clippy --locked",
    );
    expect(packageJson.scripts["test:rust"]).toContain(
      "bun scripts/cargo-sidecar.ts test --locked",
    );
    expect(packageJson.scripts["test:rust"]).toContain("--bins");
    expect(packageJson.scripts["benchmark:latency"]).toContain(
      "bun scripts/cargo-sidecar.ts run --release --locked",
    );
    expect(packageJson.scripts["gate:dictation-latency"]).toContain(
      "verify-dictation-latency.ts",
    );
    expect(packageJson.scripts["gate:release:local"]).not.toContain(
      "gate:dictation-latency",
    );
    const sourceGate = readRepoFile("scripts/capture-source-gates.ts");
    expect(sourceGate).not.toContain('id: "dictation-latency"');
    expect(sourceGate).not.toContain('"gate:dictation-latency"');
    expect(sidecarBuild).toMatch(/"build",\s*"--locked",\s*"--release"/);
  });

  it("runs cheap source gates first in CI and release verification", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
      scripts: Record<string, string>;
    };
    const declaredBun = packageJson.packageManager.replace(/^bun@/, "");
    expect(packageJson.scripts["gate:dead-code"]).toContain("bunx --no-install knip");
    expect(packageJson.scripts["gate:release:local"].split("&&")[0]?.trim()).toBe(
      "bun run gate:release:rust-dependencies",
    );
    const ci = readWorkspaceFile(".github/workflows/ci.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");
    expect(release).toContain("PLAINSONG_RUSTSEC_DB: ${{ runner.temp }}/plainsong-rustsec-db");
    expectInOrder(release, [
      "      - name: Verify Rust dependency audit",
      "cargo install cargo-audit --locked --version 0.22.1",
      'git clone --depth 1 https://github.com/RustSec/advisory-db.git "$PLAINSONG_RUSTSEC_DB"',
      "bun run gate:release:rust-dependencies",
      "bun run release:mac",
    ]);
    const ciBunVersions = [...ci.matchAll(/bun-version:\s*(\S+)/g)].map(
      ([, version]) => version,
    );
    const releaseBunVersions = [
      ...release.matchAll(/bun-version:\s*(\S+)/g),
    ].map(([, version]) => version);

    expect(ciBunVersions).not.toHaveLength(0);
    // bun lint ships only in canary builds, so one late step switches to canary
    // for lint:js alone. Every build, test and release step keeps the pin.
    expect(ciBunVersions.filter((version) => version === "canary")).toHaveLength(1);
    expect(ci).toMatch(/bun-version: canary\n\n\s+- name: Lint \(bun lint\)\n\s+run: bun run lint:js\n\n\s+verify-build:/);
    expect(ciBunVersions.filter((version) => version !== "canary").every((version) => version === declaredBun)).toBe(true);
    expect(releaseBunVersions).toEqual([declaredBun]);
    expect(ci).toContain("needs: verify-web");
    expect(ci).toContain("needs: [verify-build, verify-rust]");

    const verifyWeb = ci.slice(
      ci.indexOf("  verify-web:"),
      ci.indexOf("  verify-build:"),
    );
    expectInOrder(verifyWeb, [
      "bun run gate:ipc-contract",
      "bun run gate:dead-code",
      "bun run typecheck",
      "bun run test",
    ]);

    const verifySource = release.slice(
      release.indexOf("      - name: Verify source"),
      release.indexOf("      - name: Require signing"),
    );
    expectInOrder(verifySource, [
      "bun run gate:ipc-contract",
      "bun run gate:dead-code",
      "bun run typecheck",
      "bun run test",
      "bun run lint:rust",
      "bun run test:rust",
    ]);
  });

  it("uses the release runner before the workflow release trust gate", () => {
    const builder = readRepoFile("electron-builder.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");
    const packageJson = JSON.parse(readRepoFile("package.json"));
    expect(packageJson.scripts["release:mac"]).toContain("bun scripts/release-mac.mjs");
    expect(builder).toContain("notarize: false");
    expect(builder).toMatch(/dmg:\s*[\s\S]*?sign:\s*true[\s\S]*?writeUpdateInfo:\s*false/);
    expectInOrder(release, ["bun run release:mac", "bun run gate:release:macos:trust"]);
    expect(release).not.toContain("xcrun notarytool submit");
  });

  it("centralizes packaged native presence and architecture checks", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const verifier = readRepoFile("scripts/verify-packaged-native-helpers.mjs");
    const ci = readWorkspaceFile(".github/workflows/ci.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");

    expect(packageJson.scripts["gate:packaged:macos:native"]).toBe(
      "node scripts/verify-packaged-native-helpers.mjs --app release/mac-arm64/Plainsong.app --arch arm64",
    );
    for (const executable of [
      "mainExecutable",
      "plainsong-sidecar",
      "plainsong-native-shortcut-helper",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ]) {
      expect(verifier).toContain(executable);
    }
    expect(verifier).toContain('spawnSync("/usr/bin/lipo"');
    expect(verifier).toContain("verify-macos-speech-helper.mjs");
    expect(ci).toContain("bun run gate:packaged:macos:native");
    expect(release).toContain("bun run gate:packaged:macos:native");
    expect(ci).not.toContain("lipo -archs");
  });
});
