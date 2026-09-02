// @electron/osx-sign 2.x dropped the default export and renamed `signAsync` to
// a named `sign`. Nothing here type-checks or unit-tests the call itself, so an
// unported import fails for the first time partway through a release build.
import { sign } from "@electron/osx-sign";
import path from "node:path";

const speechHelperName = "nautilus-macos-speech-helper-aarch64-apple-darwin";
const speechHelperEntitlements = path.resolve(
  import.meta.dirname,
  "..",
  "rust-sidecar",
  "native",
  "macos_speech_helper.entitlements.plist",
);
const shortcutHelperName = "plainsong-native-shortcut-helper";
const shortcutHelperEntitlements = path.resolve(
  import.meta.dirname,
  "..",
  "build-resources",
  "entitlements.mac.shortcut-helper.plist",
);
// Read-only EventKit helper. It gets the calendar entitlement and nothing
// else, for the same reason the Speech helper gets only Speech: the app's own
// signature already carries microphone, Apple Events and the Accessibility
// grant, and calendar reading has no business joining that set.
const calendarHelperName = "plainsong-native-calendar-helper";
const calendarHelperEntitlements = path.resolve(
  import.meta.dirname,
  "..",
  "build-resources",
  "entitlements.mac.calendar-helper.plist",
);
const sidecarName = "plainsong-sidecar";
// The command-line tool / MCP server. Same empty entitlement set as the
// sidecar: it reads the database and talks on stdio, nothing more.
const cliName = "plainsong-cli";
const sidecarEntitlements = path.resolve(
  import.meta.dirname,
  "..",
  "build-resources",
  "entitlements.mac.sidecar.plist",
);
// The generic "<Product> Helper" bundle, which Chromium uses for its utility
// processes — the audio service among them. Matched by shape rather than by the
// literal product name so a productName change cannot silently reroute it, and
// anchored so the GPU/Renderer/Plugin helpers ("<Product> Helper (GPU)" and
// friends) do NOT match: those keep the narrower inherit policy.
const genericHelperPattern = /^.+ Helper(\.app)?$/;
const genericHelperEntitlements = path.resolve(
  import.meta.dirname,
  "..",
  "build-resources",
  "entitlements.mac.helper.plist",
);

export function optionsForSignedFile(filePath, inheritedOptionsForFile, signContext) {
  // 2.x passes a context object as the second argument. Forward it so an
  // inherited callback that reads it sees the same thing osx-sign would.
  const inherited = inheritedOptionsForFile?.(filePath, signContext) ?? {};
  if (path.basename(filePath) === sidecarName || path.basename(filePath) === cliName) {
    return {
      ...inherited,
      entitlements: sidecarEntitlements,
    };
  }
  if (path.basename(filePath) === shortcutHelperName) {
    return {
      ...inherited,
      entitlements: shortcutHelperEntitlements,
    };
  }
  if (path.basename(filePath) === calendarHelperName) {
    return {
      ...inherited,
      entitlements: calendarHelperEntitlements,
    };
  }
  if (genericHelperPattern.test(path.basename(filePath))) {
    return {
      ...inherited,
      entitlements: genericHelperEntitlements,
    };
  }
  if (path.basename(filePath) !== speechHelperName) {
    return inherited;
  }
  return {
    ...inherited,
    entitlements: speechHelperEntitlements,
  };
}

export default async function signMacos(configuration) {
  const inheritedOptionsForFile = configuration.optionsForFile;
  await sign({
    ...configuration,
    optionsForFile: (filePath, signContext) =>
      optionsForSignedFile(filePath, inheritedOptionsForFile, signContext),
  });
}
