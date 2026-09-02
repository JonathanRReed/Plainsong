import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const HELPER_NAME = "plainsong-native-language-model-helper";
const SOURCE = "scripts/native-macos-language-model-helper.swift";

describe("Apple Foundation Models helper entitlements", () => {
  it("carries no entitlement at all", () => {
    // FoundationModels is not TCC-guarded and this helper needs no network
    // client, no Apple Events and no JIT. An empty set is the whole security
    // argument for spawning it: a process that sees dictation text gets
    // strictly less reach than the app it was spawned from.
    const entitlements = read(
      "build-resources/entitlements.mac.language-model-helper.plist",
    );
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
      ([, key]) => key,
    );
    expect(keys).toEqual([]);
  });

  it("is a valid property list", () => {
    const result = spawnSync(
      "/usr/bin/plutil",
      [
        "-lint",
        path.join(
          repoRoot,
          "build-resources/entitlements.mac.language-model-helper.plist",
        ),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

describe("the helper's own source", () => {
  const source = read(SOURCE);

  it("compiles against any SDK, and reports honestly when the framework is absent", () => {
    // The support floor is macOS 13; FoundationModels needs 26. Guarding the
    // import is what lets one binary serve both instead of failing to link.
    expect(source).toContain("#if canImport(FoundationModels)");
    expect(source).toContain('case frameworkUnavailable = "framework_unavailable"');
    expect(source).toContain("@available(macOS 26.0, *)");
  });

  it("never puts the transcript in the instructions channel", () => {
    // `respond(to:)` takes the transcript as the prompt; the instructions
    // come from the sidecar. Nothing in this file concatenates them.
    expect(source).toContain("session.respond(to: prompt, options: options)");
    expect(source).toContain("LanguageModelSession(instructions: instructions)");
    expect(source).not.toMatch(/instructions\s*\+\s*prompt/);
  });

  it("decodes greedily, with no sampling", () => {
    // Cleanup is a deterministic transformation; sampling only adds variance
    // between two runs on the same dictation.
    expect(source).toContain("GenerationOptions(sampling: .greedy)");
  });

  it("bounds the transcript and the wall clock", () => {
    // The window is 4,096 tokens shared between prompt and response, and the
    // caller's pre-insert budget is 6 s.
    expect(source).toContain("private let maximumTranscriptCharacters = 4096");
    expect(source).toMatch(/private let requestTimeoutSeconds: Double = \d+/);
  });

  it("never echoes the framework's own error text back to the app", () => {
    // A guardrail message can quote the transcript. The strings the app logs
    // and shows are written here instead.
    expect(source).toContain("so the wording");
  });
});

describe("scripts/build-native-language-model-helper.mjs", () => {
  const buildScript = read("scripts/build-native-language-model-helper.mjs");

  it("pins the macOS 13 deployment target rather than the host SDK's", () => {
    expect(buildScript).toContain('const deploymentTarget = "arm64-apple-macosx13.0"');
    expect(buildScript).toContain('MACOSX_DEPLOYMENT_TARGET: "13.0"');
  });

  it("does not name FoundationModels on the link line", () => {
    // Swift autolinks what the source actually imported. Naming the framework
    // here would turn "SDK without FoundationModels" from a graceful
    // `available: false` into a link failure.
    const swiftcArgs = buildScript.slice(
      buildScript.indexOf('spawnSync(\n  "swiftc"'),
      buildScript.indexOf("if (compile.error)"),
    );
    expect(swiftcArgs).toContain('"-framework",\n    "Foundation",');
    expect(swiftcArgs).not.toContain("FoundationModels");
  });

  it("signs with the helper's own entitlements", () => {
    expect(buildScript).toContain(
      "build-resources/entitlements.mac.language-model-helper.plist",
    );
    expect(buildScript).toContain("/usr/bin/codesign");
  });

  it("removes a stale binary before compiling", () => {
    // A binary that survives a failed compile would be signed and shipped
    // speaking the previous protocol.
    expect(buildScript.indexOf("rmSync(outputPath")).toBeLessThan(
      buildScript.indexOf('spawnSync(\n  "swiftc"'),
    );
  });

  it("runs in every packaging chain that builds the calendar helper", () => {
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;

    expect(scripts["language-model-helper:build"]).toBe(
      "node scripts/build-native-language-model-helper.mjs",
    );
    for (const [name, command] of Object.entries(scripts)) {
      if (!command.includes("calendar-helper:build")) continue;
      if (name === "calendar-helper:build") continue;
      expect(
        command,
        `${name} must also build the Apple Foundation Models helper`,
      ).toContain("language-model-helper:build");
    }
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

  it("routes the language model helper to its own entitlements, and nothing else", () => {
    const selected = selectEntitlements({
      languageModelHelper: `/tmp/Plainsong.app/Contents/Resources/language-model-helper/${HELPER_NAME}`,
      app: "/tmp/Plainsong.app/Contents/MacOS/Plainsong",
      sidecar: "/tmp/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
      calendarHelper:
        "/tmp/Plainsong.app/Contents/Resources/calendar-helper/plainsong-native-calendar-helper",
      genericHelper: "/tmp/Plainsong.app/Contents/Frameworks/Plainsong Helper.app",
    });

    expect(selected.languageModelHelper.entitlements).toBe(
      path.join(
        repoRoot,
        "build-resources/entitlements.mac.language-model-helper.plist",
      ),
    );
    for (const key of ["app", "sidecar", "calendarHelper", "genericHelper"]) {
      expect(selected[key].entitlements).not.toContain("language-model-helper");
    }
  }, 30_000);
});

describe("electron-builder macOS packaging", () => {
  const config = read("electron-builder.yml");

  it("packages the helper into its own resource directory", () => {
    expect(config).toMatch(
      /- from: dist-native\/\s*\n\s+to: language-model-helper\s*\n\s+filter:\s*\n\s+- plainsong-native-language-model-helper/,
    );
  });

  it("signs it explicitly, at the path the gates look for", () => {
    expect(config).toContain(
      `Contents/Resources/language-model-helper/${HELPER_NAME}`,
    );
  });
});

describe("scripts/verify-packaged-native-helpers.mjs", () => {
  const verifier = read("scripts/verify-packaged-native-helpers.mjs");

  it("refuses to package a build whose helper is missing or fat", () => {
    expect(verifier).toContain("languageModelHelper");
    expect(verifier).toContain('["Apple Foundation Models helper", paths.languageModelHelper]');
  });

  it("holds the helper to an empty entitlement set", () => {
    expect(verifier).toContain(
      "requireEmptyLanguageModelHelperEntitlements(paths.languageModelHelper)",
    );
  });
});

describe("the sidecar side of the protocol", () => {
  const provider = read("rust-sidecar/src/llm/apple_language_model.rs");

  it("agrees with the helper on the binary name and the protocol version", () => {
    expect(provider).toContain(`pub const HELPER_BINARY_NAME: &str = "${HELPER_NAME}"`);
    expect(provider).toContain("pub const HELPER_PROTOCOL_VERSION: u32 = 1");
    expect(read(SOURCE)).toContain("private let protocolVersion = 1");
  });

  it("looks for the helper where electron-builder puts it", () => {
    expect(provider).toContain('.join("language-model-helper")');
  });
});
