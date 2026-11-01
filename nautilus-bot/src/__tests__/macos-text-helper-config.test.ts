import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const HELPER_NAME = "plainsong-text-helper";
const ENTITLEMENTS = "build-resources/entitlements.mac.text-helper.plist";
const BUILD_SCRIPT = "scripts/build-native-text-helper.ts";
const macIt = process.platform === "darwin" ? it : it.skip;

describe("text helper entitlements", () => {
  it("carries no entitlement at all", () => {
    // The helper reads a model file descriptor and JSON on stdin and runs on
    // Metal or the CPU. It links only system libraries, so it needs no
    // library-validation exception, and nothing it does is TCC-guarded.
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

describe("scripts/build-native-text-helper.ts", () => {
  const buildScript = read(BUILD_SCRIPT);

  it("skips cleanly on a non-macOS host", () => {
    expect(buildScript).toMatch(
      /if \(process\.platform !== "darwin"\) \{[\s\S]*?process\.exit\(0\);/,
    );
  });

  it("builds the crate from its own locked manifest", () => {
    expect(buildScript).toContain('"rust-sidecar/text-helper/Cargo.toml"');
    expect(buildScript).toMatch(
      /\["scripts\/cargo-sidecar\.ts", "--text-helper", "build", "--release", "--locked"\]/,
    );
    expect(buildScript).toContain(
      '"rust-sidecar/text-helper/target/release/plainsong-text-helper"',
    );
  });

  it("writes the binary where electron-builder picks it up", () => {
    expect(buildScript).toContain(`"dist-native/${HELPER_NAME}"`);
    expect(buildScript).toContain("copyFileSync(builtPath, outputPath)");
  });

  it("removes a stale binary before building", () => {
    expect(buildScript.indexOf("rmSync(outputPath")).toBeLessThan(
      buildScript.indexOf("const build = spawnSync("),
    );
  });

  it("signs with the helper's own entitlements after copying", () => {
    expect(buildScript).toContain(`"${ENTITLEMENTS}"`);
    expect(buildScript).toContain(
      '["--force", "--sign", "-", "--entitlements", entitlementsPath, outputPath]',
    );
    expect(buildScript.indexOf("copyFileSync(builtPath")).toBeLessThan(
      buildScript.indexOf('"/usr/bin/codesign"'),
    );
  });

  it("runs right after the speech helper in every packaging chain", () => {
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;

    expect(scripts["text-helper:build"]).toBe(`bun ${BUILD_SCRIPT}`);
    const chains = Object.entries(scripts).filter(
      ([name, command]) =>
        name !== "language-model-helper:build" &&
        command.includes("language-model-helper:build"),
    );
    expect(chains.map(([name]) => name).sort()).toEqual(
      [
        "electron:build",
        "electron:build:mac",
        "electron:build:win",
        "electron:pack",
        "release:mac:compile",
        "release:win",
      ].sort(),
    );
    // The speech helper keeps its place right after the language model
    // helper (macos-asr-helper-config.test.ts); the text helper follows it.
    for (const [name, command] of chains) {
      expect(command, `${name} must build the text helper`).toContain(
        "bun run language-model-helper:build && bun run asr-helper:build && bun run text-helper:build &&",
      );
    }
  });
});

describe("scripts/sign-macos.mjs", () => {
  // Run in a child Node process: the module imports @electron/osx-sign at its
  // top level, which does not resolve under the renderer's test transform.
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

  it("routes the text helper to its own entitlements, and nothing else", () => {
    const selected = selectEntitlements({
      textHelper: `/tmp/Plainsong.app/Contents/Resources/text-helper/${HELPER_NAME}`,
      app: "/tmp/Plainsong.app/Contents/MacOS/Plainsong",
      sidecar: "/tmp/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      languageModelHelper:
        "/tmp/Plainsong.app/Contents/Resources/language-model-helper/plainsong-native-language-model-helper",
      genericHelper: "/tmp/Plainsong.app/Contents/Frameworks/Plainsong Helper.app",
    });

    expect(selected.textHelper.entitlements).toBe(
      path.join(repoRoot, ENTITLEMENTS),
    );
    for (const key of ["app", "sidecar", "languageModelHelper", "genericHelper"]) {
      expect(selected[key].entitlements).not.toContain("text-helper");
    }
  }, 30_000);
});

describe("electron-builder macOS packaging", () => {
  const config = read("electron-builder.yml");

  it("packages the helper into its own resource directory", () => {
    expect(config).toMatch(
      /- from: dist-native\/\s*\n\s+to: text-helper\s*\n\s+filter:\s*\n\s+- plainsong-text-helper/,
    );
  });

  it("signs it explicitly, at the path the gates look for", () => {
    expect(config).toContain(`Contents/Resources/text-helper/${HELPER_NAME}`);
  });
});

describe("scripts/verify-packaged-native-helpers.mjs", () => {
  const verifier = read("scripts/verify-packaged-native-helpers.mjs");

  it("refuses to package a build whose helper is missing or fat", () => {
    expect(verifier).toContain('"text-helper",\n      "plainsong-text-helper"');
    expect(verifier).toContain('["text helper", paths.textHelper]');
  });

  it("holds the helper to an empty entitlement set", () => {
    expect(verifier).toContain(
      'requireEmptyEntitlements(paths.textHelper, "text helper")',
    );
  });
});

describe("the sidecar side of the packaging contract", () => {
  const provider = read("rust-sidecar/src/llm/text_helper.rs");

  it("agrees on the binary name and resource directory", () => {
    expect(provider).toContain(`pub const HELPER_BINARY_NAME: &str = "${HELPER_NAME}"`);
    expect(provider).toContain('pub const HELPER_RESOURCE_DIR: &str = "text-helper"');
  });
});
