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

export function optionsForSignedFile(filePath, inheritedOptionsForFile, signContext) {
  // 2.x passes a context object as the second argument. Forward it so an
  // inherited callback that reads it sees the same thing osx-sign would.
  const inherited = inheritedOptionsForFile?.(filePath, signContext) ?? {};
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
  await sign({
    ...configuration,
    optionsForFile: (filePath, signContext) =>
      optionsForSignedFile(filePath, inheritedOptionsForFile, signContext),
  });
}
