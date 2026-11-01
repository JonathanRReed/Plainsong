import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getAppUpdatePublishConfiguration } = require("app-builder-lib/out/publish/PublishManager.js");
const { serializeToYaml, Arch } = require("builder-util");
const { Packager } = require("app-builder-lib/out/packager.js");
const { MacPackager } = require("app-builder-lib/out/macPackager.js");

// Use the same resolver, options and serializer as PublishManager.afterPack.
// Its built-in macOS hook skips dir targets, which our two-step release needs.
async function appUpdateYaml(packager, arch) {
  const config = await getAppUpdatePublishConfiguration(packager, null, arch, false);
  if (config == null) throw new Error("No app update publish configuration");
  return serializeToYaml(config);
}

export async function expectedMacUpdateYaml(projectDir) {
  // Read and validate configuration without building, signing or loading keys.
  const info = new Packager({ projectDir });
  await info.validateConfig();
  return appUpdateYaml(new MacPackager(info), Arch.arm64);
}

export function verifyAppUpdateConfig(app, expected) {
  const file = path.join(app, "Contents", "Resources", "app-update.yml");
  if (!fs.existsSync(file)) throw new Error(`Packaged app-update.yml not found at ${file}`);
  if (fs.readFileSync(file, "utf8") !== expected) {
    throw new Error(`Packaged app-update.yml does not match electron-builder publish configuration: ${file}`);
  }
}

export default async function writeAppUpdateConfig(context) {
  if (context.electronPlatformName !== "darwin") return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  fs.writeFileSync(path.join(resources, "app-update.yml"), await appUpdateYaml(context.packager, context.arch));
}
