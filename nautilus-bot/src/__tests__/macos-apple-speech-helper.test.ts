import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { sidecarSource } from "./sidecar-source";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * The entitlement keys a plist actually grants, in file order.
 *
 * Read from the `<key>` elements rather than by matching raw text: these files
 * carry XML comments explaining what was removed and why, and the words in
 * those comments are exactly the ones a raw-text assertion looks for.
 */
function entitlementKeys(relativePath: string): string[] {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  return [...withoutComments.matchAll(/<key>([^<]+)<\/key>/g)].map((entry) => entry[1]);
}

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

  /**
   * `@available(macOS 26, *)` guards the runtime only. The symbols behind it
   * still have to resolve while compiling, so an SDK older than macOS 26 fails
   * the helper compile outright -- and `build.rs` calls
   * `require_success("compile the required macOS Speech helper")`, so the whole
   * app stops building on that machine.
   */
  it("compiles the SpeechAnalyzer section out when the SDK is too old", () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/native/macos_speech_helper.swift"),
      "utf8",
    );
    const buildScript = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/build.rs"),
      "utf8",
    );

    expect(helper).toContain("#if !NO_SPEECH_ANALYZER");
    // The fallback still has to answer the probe, and answer it honestly.
    expect(helper).toMatch(
      /#else[\s\S]{0,600}private func analyzerFactsForProbe\(locale: Locale\) -> AnalyzerFacts \{[\s\S]{0,200}return AnalyzerFacts\(\)/,
    );
    expect(buildScript).toContain('"--sdk", "macosx", "--show-sdk-version"');
    expect(buildScript).toContain('swiftc_arguments.extend(["-D", "NO_SPEECH_ANALYZER"]);');
    // Every `#if` has to close, or the compile-out variant silently keeps the
    // symbols it was meant to drop.
    const opened = helper.match(/^#if /gm)?.length ?? 0;
    const closed = helper.match(/^#endif$/gm)?.length ?? 0;
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });

  /**
   * The only proof the older-SDK path actually builds: compile the helper with
   * the guard forced off and check the binary reports what it can really do.
   * Skipped off macOS, where there is no Swift toolchain to run.
   */
  it.skipIf(process.platform !== "darwin")(
    "builds and probes honestly with the SpeechAnalyzer section removed",
    () => {
      const scratch = fs.mkdtempSync(
        path.join(os.tmpdir(), "plainsong-speech-helper-test-"),
      );
      try {
        const binary = path.join(scratch, "helper-no-speech-analyzer");
        execFileSync(
          "/usr/bin/xcrun",
          [
            "swiftc",
            "-target",
            "arm64-apple-macosx13.0",
            "-D",
            "NO_SPEECH_ANALYZER",
            path.join(repoRoot, "rust-sidecar/native/macos_speech_helper.swift"),
            "-framework",
            "Speech",
            "-framework",
            "Foundation",
            "-framework",
            "AVFoundation",
            "-o",
            binary,
          ],
          { encoding: "utf8" },
        );
        const probe = JSON.parse(
          execFileSync(binary, ["--probe"], { encoding: "utf8" }).trim(),
        ) as { speech_analyzer_available: boolean; engine: string };

        expect(probe.speech_analyzer_available).toBe(false);
        expect(probe.engine).toBe("sf_speech_recognizer");
      } finally {
        fs.rmSync(scratch, { force: true, recursive: true });
      }
    },
    180_000,
  );

  /**
   * The helper is its own binary with its own Speech entitlement. The app's
   * gate is not the only thing that has to hold: both SpeechAnalyzer branches
   * exit the function without returning, so an authorization check that only
   * lives inside `recognitionContext` never runs for them.
   */
  it("checks Speech authorization before either engine can transcribe", () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/native/macos_speech_helper.swift"),
      "utf8",
    );

    expect(helper).toContain(
      "private func requireSpeechAuthorization() -> SFSpeechRecognizerAuthorizationStatus",
    );
    for (const entryPoint of ["runFileRecognition", "runLiveRecognition"]) {
      const start = helper.indexOf(`private func ${entryPoint}(`);
      expect(start).toBeGreaterThan(-1);
      const gate = helper.indexOf("requireSpeechAuthorization()", start);
      const analyzerBranch = helper.indexOf("#if !NO_SPEECH_ANALYZER", start);
      expect(gate).toBeGreaterThan(-1);
      expect(analyzerBranch).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(analyzerBranch);
    }
    // The probe reports authorization; it must never demand it.
    const probeStart = helper.indexOf("private func capabilityProbe(");
    const probeEnd = helper.indexOf("\n}\n", probeStart);
    expect(helper.slice(probeStart, probeEnd)).not.toContain(
      "requireSpeechAuthorization()",
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
    const sidecarEntitlements = fs.readFileSync(
      path.join(repoRoot, "build-resources/entitlements.mac.sidecar.plist"),
      "utf8",
    );

    expect(signScript).toContain("optionsForSignedFile");
    expect(signScript).toContain("macos_speech_helper.entitlements.plist");
    expect(signScript).toContain("plainsong-sidecar");
    expect(signScript).toContain("entitlements.mac.sidecar.plist");
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
    // The main process loads no unsigned native code, and this bundle is the one
    // holding the microphone, Apple Events and the Accessibility grant.
    expect(entitlementKeys("build-resources/entitlements.mac.plist")).not.toContain(
      "com.apple.security.cs.disable-library-validation",
    );
    expect(inheritedEntitlements).not.toContain(
      "com.apple.security.personal-information.speech-recognition",
    );
    expect(shortcutHelperEntitlements).toContain("<dict/>");
    expect(shortcutHelperEntitlements).not.toMatch(
      /microphone|audio-input|apple-events|allow-jit|allow-unsigned-executable-memory|disable-library-validation|speech-recognition/,
    );
    expect(sidecarEntitlements).toContain("<dict/>");
    expect(sidecarEntitlements).not.toMatch(
      /microphone|audio-input|apple-events|allow-jit|allow-unsigned-executable-memory|disable-library-validation|speech-recognition/,
    );
  });

  it("gives the GPU, Renderer and Plugin helpers only what Chromium needs", () => {
    // These three were signed with a copy of the main app's entitlements, so
    // they shipped with the microphone, unscoped Apple Events, and disabled
    // library validation. The Renderer never opens the device itself
    // (getUserMedia is brokered by the audio service), and no child process
    // drives another application.
    expect(entitlementKeys("build-resources/entitlements.mac.inherit.plist")).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.inherit",
    ]);
  });

  it("keeps audio on the generic helper alone, and routes it there by shape", () => {
    // Chromium's audio service runs in the generic "<Product> Helper", and the
    // Settings microphone test reaches it through getUserMedia. Removing audio
    // from every helper at once would break that.
    const signScript = fs.readFileSync(
      path.join(repoRoot, "scripts/sign-macos.mjs"),
      "utf8",
    );

    expect(entitlementKeys("build-resources/entitlements.mac.helper.plist")).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.inherit",
      "com.apple.security.device.audio-input",
      "com.apple.security.device.microphone",
    ]);
    expect(signScript).toContain("entitlements.mac.helper.plist");
    // Matched by shape, not by the literal product name.
    expect(signScript).toContain("genericHelperPattern");
    expect(signScript).not.toContain('"Plainsong Helper"');
  });

  it("routes only the generic helper to the audio policy", () => {
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
          const inherited = () => ({ entitlements: "inherit.plist", marker: "inherited" });
          const pick = (name) => optionsForSignedFile("/tmp/Frameworks/" + name, inherited);
          console.log(JSON.stringify({
            generic: pick("Plainsong Helper"),
            genericBundle: pick("Plainsong Helper.app"),
            gpu: pick("Plainsong Helper (GPU)"),
            renderer: pick("Plainsong Helper (Renderer)"),
            plugin: pick("Plainsong Helper (Plugin)"),
          }));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const selected = JSON.parse(output) as Record<
      string,
      { entitlements: string; marker: string }
    >;
    const helperPolicy = path.join(
      repoRoot,
      "build-resources/entitlements.mac.helper.plist",
    );

    expect(selected.generic.entitlements).toBe(helperPolicy);
    expect(selected.genericBundle.entitlements).toBe(helperPolicy);
    // The three suffixed helpers keep whatever electron-builder inherited them,
    // which is entitlements.mac.inherit.plist.
    expect(selected.gpu.entitlements).toBe("inherit.plist");
    expect(selected.renderer.entitlements).toBe("inherit.plist");
    expect(selected.plugin.entitlements).toBe("inherit.plist");
  }, 15_000);

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
            sidecar: optionsForSignedFile(
              "/tmp/nested/plainsong-sidecar",
              inherited,
            ),
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
    expect(selected.sidecar.marker).toBe("inherited");
    expect(selected.sidecar.entitlements).toBe(
      path.join(repoRoot, "build-resources/entitlements.mac.sidecar.plist"),
    );
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
  }, 15_000);

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
  }, 15_000);

  it("keeps native live recognition separate from generic batch preview", () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/native/macos_speech_helper.swift"),
      "utf8",
    );
    const rustBridge = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar/src/asr/platform/macos_speech.rs"),
      "utf8",
    );
    // Both live in modules lib.rs was split into, so read the whole crate
    // rather than guessing which one.
    const sidecar = sidecarSource();

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
  }, 15_000);
});
