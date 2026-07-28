import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("macOS Apple Speech helper contract", () => {
  it("passes source, on-device, entitlement, and packaging checks", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts/verify-macos-speech-helper.mjs"), "--source-only"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      pass: true,
      sourceOnly: true,
      deploymentTarget: "13.0",
      architecture: "arm64",
      strictOnDevice: true,
    });
  });

  it("hard-requires helper sources instead of silently omitting macOS support", () => {
    const buildScript = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/build.rs"),
      "utf8",
    );
    expect(buildScript).toContain("require_regular_file(path)");
    expect(buildScript).toContain("ensure_executable(&helper_path)");
    expect(buildScript).toContain(
      'const SWIFT_TARGET: &str = "arm64-apple-macosx13.0";',
    );
    expect(buildScript).not.toMatch(
      /if\s*!source\.exists\(\)[\s\S]{0,160}return;/,
    );
  });

  it("uses helper-specific Speech-only entitlements while signing", () => {
    const signScript = fs.readFileSync(
      path.join(repoRoot, "scripts/sign-macos.mjs"),
      "utf8",
    );
    const entitlements = fs.readFileSync(
      path.join(
        repoRoot,
        "rust-sidecar/native/macos_speech_helper.entitlements.plist",
      ),
      "utf8",
    );
    const appEntitlements = fs.readFileSync(
      path.join(repoRoot, "build-resources/entitlements.mac.plist"),
      "utf8",
    );
    const inheritedEntitlements = fs.readFileSync(
      path.join(repoRoot, "build-resources/entitlements.mac.inherit.plist"),
      "utf8",
    );
    const shortcutHelperEntitlements = fs.readFileSync(
      path.join(
        repoRoot,
        "build-resources/entitlements.mac.shortcut-helper.plist",
      ),
      "utf8",
    );

    expect(signScript).toContain("optionsForSignedFile");
    expect(signScript).toContain("macos_speech_helper.entitlements.plist");
    expect(signScript).toContain("plainsong-native-shortcut-helper");
    expect(signScript).toContain("entitlements.mac.shortcut-helper.plist");
    expect(entitlements).toContain(
      "com.apple.security.personal-information.speech-recognition",
    );
    expect(entitlements).not.toMatch(
      /microphone|audio-input|apple-events|allow-jit|disable-library-validation/,
    );
    expect(appEntitlements).not.toContain(
      "com.apple.security.personal-information.speech-recognition",
    );
    expect(inheritedEntitlements).not.toContain(
      "com.apple.security.personal-information.speech-recognition",
    );
    expect(shortcutHelperEntitlements).toContain("<dict/>");
    expect(shortcutHelperEntitlements).not.toMatch(
      /microphone|audio-input|apple-events|allow-jit|allow-unsigned-executable-memory|disable-library-validation|speech-recognition/,
    );
  });

  it("selects dedicated native-helper entitlements by basename", () => {
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
          const inherited = () => ({ entitlements: "broad.plist", marker: "inherited" });
          console.log(JSON.stringify({
            ordinary: optionsForSignedFile("/tmp/ordinary-helper", inherited),
            shortcut: optionsForSignedFile(
              "/tmp/nested/plainsong-native-shortcut-helper",
              inherited,
            ),
            speech: optionsForSignedFile(
              "/tmp/nested/nautilus-macos-speech-helper-aarch64-apple-darwin",
              inherited,
            ),
          }));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const selected = JSON.parse(output) as Record<
      string,
      { entitlements: string; marker: string }
    >;

    expect(selected.ordinary).toEqual({
      entitlements: "broad.plist",
      marker: "inherited",
    });
    expect(selected.shortcut.marker).toBe("inherited");
    expect(selected.shortcut.entitlements).toBe(
      path.join(
        repoRoot,
        "build-resources/entitlements.mac.shortcut-helper.plist",
      ),
    );
    expect(selected.speech.marker).toBe("inherited");
    expect(selected.speech.entitlements).toBe(
      path.join(
        repoRoot,
        "rust-sidecar/native/macos_speech_helper.entitlements.plist",
      ),
    );
  });

  it("calls a signing entry point @electron/osx-sign actually exports", () => {
    // The signing hook only runs during a packaged release build, so a renamed
    // export surfaces for the first time mid-release. 2.x dropped the default
    // export and `signAsync`; assert the name we call still resolves.
    const resolved = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const osxSign = await import("@electron/osx-sign");
          console.log(JSON.stringify({
            exports: Object.keys(osxSign).sort(),
            signIsCallable: typeof osxSign.sign === "function",
          }));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const { signIsCallable } = JSON.parse(resolved) as {
      exports: string[];
      signIsCallable: boolean;
    };

    expect(signIsCallable).toBe(true);
    expect(
      fs.readFileSync(path.join(repoRoot, "scripts/sign-macos.mjs"), "utf8"),
    ).toContain('import { sign } from "@electron/osx-sign"');
  });

  it("keeps native live recognition separate from generic batch preview", () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/native/macos_speech_helper.swift"),
      "utf8",
    );
    const rustBridge = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/src/asr/platform/macos_speech.rs"),
      "utf8",
    );
    const sidecar = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/src/lib.rs"),
      "utf8",
    );

    expect(helper).toContain("SFSpeechAudioBufferRecognitionRequest");
    expect(helper).toContain('type: result.isFinal ? "final" : "partial"');
    expect(rustBridge).toContain("start_live_dictation_session");
    expect(rustBridge).not.toContain("dictation_live_preview_enabled");
    expect(sidecar).toContain(
      "provider != asr::AsrProviderType::MacosAppleSpeech",
    );
    expect(sidecar).toContain(
      "provider_supports_generic_live_preview(dictation_provider)",
    );
  });
});
