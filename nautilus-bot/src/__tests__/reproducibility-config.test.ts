import fs from "node:fs";
import path from "node:path";
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

describe("reproducible package and release configuration", () => {
  it("aligns the first beta identity and stages its channel assets", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      version: string;
    };
    const cargoToml = readRepoFile("rust-sidecar/Cargo.toml");
    const cargoLock = readRepoFile("rust-sidecar/Cargo.lock");
    const builder = readRepoFile("electron-builder.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");

    expect(packageJson.version).toBe("0.9.0-beta.2");
    expect(cargoToml).toMatch(/^version = "0\.9\.0-beta\.2"$/m);
    expect(cargoLock).toMatch(
      /name = "plainsong"\nversion = "0\.9\.0-beta\.2"/,
    );
    expect(builder).toMatch(
      /publish:\s*[\s\S]*?provider:\s*generic[\s\S]*?url:\s*https:\/\/updates\.plainsong\.jonathanrreed\.com\/beta\/[\s\S]*?channel:\s*beta[\s\S]*?useMultipleRangeRequest:\s*false/,
    );
    expect(builder).toMatch(/publish:\s*[\s\S]*?channel:\s*beta/);
    expect(release).toContain("release/beta-mac.yml");
    expect(release).not.toContain("release/latest-mac.yml");
    expect(release).toContain('EXPECTED_TAG="v$PKG"');
    expect(release).toContain('shasum -a 256 "${DMGS[@]}" "${ZIPS[@]}" "${BLOCKMAPS[@]}" release/beta-mac.yml');
    expect(release).toContain("Stage artifact-only draft release");
    expect(release).toContain("does not assert");
    expect(release).not.toContain("Stage verified draft release");
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

    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.devDependencies.knip).toBe("6.32.2");
    expect(packageJson.scripts["gate:dead-code"]).toContain(
      "bunx --no-install knip",
    );
    expect(knipConfig.$schema).toBe(
      "https://unpkg.com/knip@6.32.2/schema.json",
    );
  });

  it("keeps the full test suite stable and includes its config in source identity", () => {
    const vitestConfig = readRepoFile("vitest.config.ts");
    const sourceGate = readRepoFile("scripts/capture-source-gates.mjs");

    expect(vitestConfig).toContain('pool: "threads"');
    expect(vitestConfig).toContain("maxWorkers: 4");
    expect(sourceGate).toContain("vite(?:st)?\\.config");
  });

  it("keeps contributor and release Cargo commands locked", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const sidecarBuild = readRepoFile("scripts/build-rust-sidecar.mjs");

    // Contributor cargo commands go through scripts/cargo-sidecar.mjs so they
    // compile the same feature set the release sidecar ships on this host;
    // that wrapper's feature handling is pinned in
    // sidecar-cargo-features.test.ts. Here: still `--locked`.
    expect(packageJson.scripts["lint:rust"]).toContain(
      "node scripts/cargo-sidecar.mjs clippy --locked",
    );
    expect(packageJson.scripts["test:rust"]).toContain(
      "node scripts/cargo-sidecar.mjs test --locked",
    );
    expect(packageJson.scripts["test:rust"]).toContain("--bins");
    expect(packageJson.scripts["benchmark:latency"]).toContain(
      "node scripts/cargo-sidecar.mjs run --release --locked",
    );
    expect(packageJson.scripts["gate:dictation-latency"]).toContain(
      "verify-dictation-latency.mjs",
    );
    expect(packageJson.scripts["gate:release:local"]).not.toContain(
      "gate:dictation-latency",
    );
    const sourceGate = readRepoFile("scripts/capture-source-gates.mjs");
    expect(sourceGate).not.toContain('id: "dictation-latency"');
    expect(sourceGate).not.toContain('"gate:dictation-latency"');
    expect(sidecarBuild).toMatch(/"build",\s*"--locked",\s*"--release"/);
  });

  it("runs cheap source gates first in CI and release verification", () => {
    const ci = readWorkspaceFile(".github/workflows/ci.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");
    const ciBunVersions = [...ci.matchAll(/bun-version:\s*(\S+)/g)].map(
      ([, version]) => version,
    );
    const releaseBunVersions = [
      ...release.matchAll(/bun-version:\s*(\S+)/g),
    ].map(([, version]) => version);

    expect(ciBunVersions).not.toHaveLength(0);
    expect(ciBunVersions.every((version) => version === "1.3.14")).toBe(true);
    expect(releaseBunVersions).toEqual(["1.3.14"]);
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

  it("notarizes and staples the signed DMG before the release trust gate", () => {
    const builder = readRepoFile("electron-builder.yml");
    const release = readWorkspaceFile(".github/workflows/release.yml");
    const trustSteps = release.slice(
      release.indexOf("      - name: Verify package size"),
      release.indexOf("      - name: Verify release assets"),
    );

    expectInOrder(release, [
      "bun run licenses:generate",
      "      - name: Build signed and notarized release",
      "bun run release:mac",
      "bun run gate:release:licenses",
      "bun run gate:cold-start",
      "      - name: Notarize and staple signed DMG",
    ]);
    expect(builder).toMatch(
      /dmg:\s*[\s\S]*?sign:\s*true[\s\S]*?writeUpdateInfo:\s*false/,
    );
    expect(builder).not.toContain("rust-sidecar/python");
    expectInOrder(trustSteps, [
      "bun run gate:size",
      "      - name: Notarize and staple signed DMG",
      "DMGS=(release/*.dmg)",
      'if [ "${#DMGS[@]}" -ne 1 ]',
      'xcrun notarytool submit "${DMGS[0]}"',
      "--wait",
      'xcrun stapler staple "${DMGS[0]}"',
      "bun run gate:release:macos:trust",
    ]);
    expect(trustSteps).toContain("APPLE_ID: ${{ secrets.APPLE_ID }}");
    expect(trustSteps).toContain(
      "APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}",
    );
    expect(trustSteps).toContain("APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}");
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
