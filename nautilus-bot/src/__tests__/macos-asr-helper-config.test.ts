import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const HELPER_NAME = "plainsong-native-asr-helper";
const ENTITLEMENTS = "build-resources/entitlements.mac.asr-helper.plist";
const PACKAGE_DIR = "rust-sidecar/native/asr_helper";
const FLUIDAUDIO_VERSION = "0.17.7";
const FLUIDAUDIO_REVISION = "503b4bd1bbf7220882de39fe8ae6716aae4132da";
const macIt = process.platform === "darwin" ? it : it.skip;

describe("Neural Engine speech helper entitlements", () => {
  it("carries no entitlement at all", () => {
    // The sidecar owns the microphone and writes 16 kHz samples to the
    // helper's stdin; Core ML needs no TCC grant, and the helper opens no
    // network connection, sends no Apple Events and needs no JIT. An empty set
    // means a process that hears every dictation can do strictly less than the
    // app that spawned it.
    const entitlements = read(ENTITLEMENTS);
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
      ([, key]) => key,
    );
    expect(keys).toEqual([]);
  });

  macIt("is a valid property list", () => {
    const result = spawnSync(
      "/usr/bin/plutil",
      ["-lint", path.join(repoRoot, ENTITLEMENTS)],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

describe("the FluidAudio pin", () => {
  it("names one exact release and turns every optional trait off", () => {
    // `exact:` stops SwiftPM from taking a newer patch on its own. The
    // default trait pulls a prebuilt text-normalisation framework at build
    // time; with `traits: []` everything that ships is built from source.
    const manifest = read(`${PACKAGE_DIR}/Package.swift`);
    expect(manifest).toContain(`exact: "${FLUIDAUDIO_VERSION}"`);
    expect(manifest).toContain("traits: []");
  });

  it("records the commit that release resolved to", () => {
    // A tag can be moved; a revision cannot. The build passes
    // `--force-resolved-versions`, so this hash is what actually gets built.
    const resolved = JSON.parse(read(`${PACKAGE_DIR}/Package.resolved`)) as {
      pins: { identity: string; state: { revision: string; version: string } }[];
    };
    const fluidAudio = resolved.pins.find((pin) => pin.identity === "fluidaudio");
    expect(fluidAudio?.state.revision).toBe(FLUIDAUDIO_REVISION);
    expect(fluidAudio?.state.version).toBe(FLUIDAUDIO_VERSION);
  });
});

describe("scripts/build-native-asr-helper.ts", () => {
  const buildScript = read("scripts/build-native-asr-helper.ts");

  it("builds only what Package.resolved names", () => {
    // Without this flag SwiftPM may re-resolve and quietly update the lock
    // file, so a release could be built from a revision nobody reviewed.
    expect(buildScript).toContain('"--force-resolved-versions"');
  });

  it("signs with the hardened runtime and the helper's own entitlements", () => {
    // A dev run should face the same runtime policy as the shipped binary,
    // and the ad-hoc signature should claim the same (empty) entitlements
    // electron-builder applies later.
    expect(buildScript).toContain('"--options",\n  "runtime"');
    expect(buildScript).toContain(ENTITLEMENTS);
    expect(buildScript).toContain("/usr/bin/codesign");
  });

  it("checks the built helper protocol before packaging can use it", () => {
    expect(buildScript).toContain('"scripts/test-native-asr-helper.py"');
  });

  it("removes a stale binary before building", () => {
    // A binary that survives a failed build would be signed and shipped
    // speaking the previous protocol.
    expect(buildScript.indexOf("rmSync(outputPath")).toBeGreaterThan(-1);
    expect(buildScript.indexOf("rmSync(outputPath")).toBeLessThan(
      buildScript.indexOf('run("swift"'),
    );
  });

  it("runs in every packaging chain that builds the language model helper", () => {
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;

    expect(scripts["asr-helper:build"]).toBe("bun scripts/build-native-asr-helper.ts");
    let chains = 0;
    for (const [name, command] of Object.entries(scripts)) {
      if (!command.includes("bun run language-model-helper:build")) continue;
      chains += 1;
      expect(
        command,
        `${name} must build the speech helper right after the language model helper`,
      ).toContain("bun run language-model-helper:build && bun run asr-helper:build");
    }
    // electron:build, electron:build:mac/win, electron:pack, release:mac/win.
    expect(chains).toBeGreaterThanOrEqual(6);
  });
});

describe("scripts/sign-macos.mjs", () => {
  /**
   * Run the real signing adapter in a child Node process: the module imports
   * @electron/osx-sign at its top level, which does not resolve under the
   * renderer's test transform.
   */
  function selectEntitlements(paths: Record<string, string>) {
    const signScriptUrl = pathToFileURL(
      path.join(repoRoot, "scripts/sign-macos.mjs"),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const { optionsForSignedFile } = await import(${JSON.stringify(signScriptUrl)});
          const inherited = () => ({ entitlements: "inherit.plist" });
          const targets = ${JSON.stringify(paths)};
          console.log(JSON.stringify(
            Object.fromEntries(
              Object.entries(targets).map(([key, filePath]) => [
                key,
                optionsForSignedFile(filePath, inherited),
              ]),
            ),
          ));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return JSON.parse(output) as Record<string, { entitlements: string }>;
  }

  it("routes the speech helper to its own entitlements, and nothing else", () => {
    const selected = selectEntitlements({
      asrHelper: `/tmp/Plainsong.app/Contents/Resources/asr-helper/${HELPER_NAME}`,
      app: "/tmp/Plainsong.app/Contents/MacOS/Plainsong",
      sidecar: "/tmp/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      languageModelHelper:
        "/tmp/Plainsong.app/Contents/Resources/language-model-helper/plainsong-native-language-model-helper",
      genericHelper: "/tmp/Plainsong.app/Contents/Frameworks/Plainsong Helper.app",
    });

    expect(selected.asrHelper.entitlements).toBe(path.join(repoRoot, ENTITLEMENTS));
    for (const key of ["app", "sidecar", "languageModelHelper", "genericHelper"]) {
      expect(selected[key].entitlements).not.toContain("asr-helper");
    }
  }, 30_000);
});

describe("electron-builder macOS packaging", () => {
  const config = read("electron-builder.yml");

  it("packages the helper into its own resource directory", () => {
    expect(config).toMatch(
      /- from: dist-native\/\s*\n\s+to: asr-helper\s*\n\s+filter:\s*\n\s+- plainsong-native-asr-helper/,
    );
  });

  it("signs it explicitly, at the path the gates look for", () => {
    expect(config).toContain(`- Contents/Resources/asr-helper/${HELPER_NAME}`);
  });
});

describe("the packaging gates", () => {
  it("refuses a build whose helper is missing, fat or carries entitlements", () => {
    const verifier = read("scripts/verify-packaged-native-helpers.mjs");
    expect(verifier).toContain('["Neural Engine speech helper", paths.asrHelper]');
    expect(verifier).toContain(
      'requireEmptyEntitlements(paths.asrHelper, "Neural Engine speech helper")',
    );
  });

  it("holds the shipped helper to the same release trust checks", () => {
    const trust = read("scripts/verify-macos-release-trust.ts");
    for (const check of [
      "asrHelperExecutablePresent",
      "asrHelperSignatureValid",
      "asrHelperUsesDeveloperId",
      "asrHelperUsesHardenedRuntime",
      "asrHelperHasSecureTimestamp",
      "asrHelperTeamMatchesExpected",
      "asrHelperIsArm64",
      "asrHelperHasEmptyEntitlements",
    ]) {
      expect(trust).toContain(`${check}:`);
    }
  });
});

describe("the sidecar side", () => {
  const provider = read("rust-sidecar/src/asr/neural_engine.rs");

  it("looks for the helper where electron-builder puts it", () => {
    expect(provider).toContain(`pub(crate) const HELPER_BINARY_NAME: &str = "${HELPER_NAME}"`);
    expect(provider).toContain('.join("asr-helper")');
  });

  it("expects the FluidAudio release the helper is built from", () => {
    // The "prepared for this Mac" marker is keyed on this version. If it
    // drifted from Package.swift, a FluidAudio upgrade would keep trusting
    // models the previous release compiled.
    expect(provider).toContain(
      `pub(crate) const HELPER_ENGINE_VERSION: &str = "${FLUIDAUDIO_VERSION}"`,
    );
  });
});
