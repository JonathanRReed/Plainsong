import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Packaging hooks run directly as JavaScript.
import writeAppUpdateConfig, { expectedMacUpdateYaml, verifyAppUpdateConfig } from "../../scripts/lib/app-update-config.mjs";
// @ts-expect-error Packaging hooks run directly as JavaScript.
import afterPack from "../../scripts/after-pack.mjs";
import verifyNativeHelpers from "../../scripts/verify-packaged-native-helpers.mjs";

vi.mock("../../scripts/verify-packaged-native-helpers.mjs", () => ({ default: vi.fn() }));
const require = createRequire(import.meta.url);
const { Packager } = require("app-builder-lib/out/packager.js");
const { MacPackager } = require("app-builder-lib/out/macPackager.js");
const { PublishManager } = require("app-builder-lib/out/publish/PublishManager.js");
const { Arch } = require("builder-util");
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  vi.mocked(verifyNativeHelpers).mockReset();
});

async function fixture(config = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-update-config-"));
  roots.push(appOutDir);
  const info = new Packager({ projectDir: process.cwd(), config });
  await info.validateConfig();
  const packager = new MacPackager(info);
  const resources = packager.getResourcesDir(appOutDir);
  fs.mkdirSync(resources, { recursive: true });
  const app = path.dirname(path.dirname(resources));
  const file = path.join(resources, "app-update.yml");
  const context = { packager, appOutDir, arch: Arch.arm64, electronPlatformName: "darwin", targets: [{ name: "dir" }] };
  return { info, context, app, file };
}

it.each([
  {},
  { publish: [{ provider: "github", owner: "example", repo: "speech", channel: "beta" }] },
  { mac: { publish: { provider: "generic", url: "https://example.invalid/${arch}/${version}/", channel: "preview" } } },
])("writes the exact bytes of electron-builder's built-in ZIP hook for %j", async config => {
  const f = await fixture(config);
  new PublishManager(f.info, { publish: "never" });
  // Reproduce the dir omission, then compare against the actual ZIP hook.
  await f.info.emitAfterPack(f.context);
  expect(fs.existsSync(f.file)).toBe(false);
  await writeAppUpdateConfig(f.context);
  const actual = fs.readFileSync(f.file, "utf8");
  fs.rmSync(f.file);
  await f.info.emitAfterPack({ ...f.context, targets: [{ name: "zip" }] });
  expect(actual).toBe(fs.readFileSync(f.file, "utf8"));
  expect(actual).toContain("updaterCacheDirName: plainsong-updater");
  verifyAppUpdateConfig(f.app, actual);
});

it("uses the configured hook before native verification and preserves its failure", async () => {
  const f = await fixture();
  expect(f.info.config.afterPack).toBe("scripts/after-pack.mjs");
  const expected = await expectedMacUpdateYaml(process.cwd());
  vi.mocked(verifyNativeHelpers).mockImplementation(() => {
    expect(fs.readFileSync(f.file, "utf8")).toBe(expected);
    throw new Error("native helper rejected");
  });
  await expect(afterPack(f.context)).rejects.toThrow("native helper rejected");
  expect(verifyNativeHelpers).toHaveBeenCalledWith(f.context);
});

it("fails packaging when publishing is disabled rather than shipping no update config", async () => {
  const f = await fixture({ publish: null });
  await expect(writeAppUpdateConfig(f.context)).rejects.toThrow("No app update publish configuration");
  expect(fs.existsSync(f.file)).toBe(false);
});

it("leaves other platforms to electron-builder", async () => {
  await writeAppUpdateConfig({ electronPlatformName: "linux" });
  expect(verifyNativeHelpers).not.toHaveBeenCalled();
});

it("rejects missing, stale, or extra configuration bytes", async () => {
  const f = await fixture();
  const expected = await expectedMacUpdateYaml(process.cwd());
  expect(() => verifyAppUpdateConfig(f.app, expected)).toThrow("not found");
  await writeAppUpdateConfig(f.context);
  verifyAppUpdateConfig(f.app, expected);
  for (const value of [expected.replace("channel: beta", "channel: latest"), expected.replace("plainsong-updater", "wrong-cache"), `${expected}extra: true\n`]) {
    fs.writeFileSync(f.file, value);
    expect(() => verifyAppUpdateConfig(f.app, expected)).toThrow("does not match");
  }
});
