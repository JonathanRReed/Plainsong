import osxSign from "@electron/osx-sign";
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

export function optionsForSignedFile(filePath, inheritedOptionsForFile) {
  const inherited = inheritedOptionsForFile?.(filePath) ?? {};
  if (path.basename(filePath) === shortcutHelperName) {
    return {
      ...inherited,
      entitlements: shortcutHelperEntitlements,
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
  await osxSign.signAsync({
    ...configuration,
    optionsForFile: (filePath) => optionsForSignedFile(filePath, inheritedOptionsForFile),
  });
}
