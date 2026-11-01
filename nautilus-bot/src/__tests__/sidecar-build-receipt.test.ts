import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sidecarBuildReceiptPath, writeSidecarBuildReceipt, verifySidecarBuildReceipt } from "../../scripts/lib/sidecar-build-receipt.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-receipt-"));
  roots.push(root);
  const built = new Map<string, string>();
  const packaged = new Map<string, string>();
  for (const name of ["plainsong-sidecar", "plainsong-cli"]) {
    const source = path.join(root, `custom-target-${name}`);
    const destination = path.join(root, `packaged-${name}`);
    fs.writeFileSync(source, `${name} current build`);
    fs.copyFileSync(source, destination);
    built.set(name, source);
    packaged.set(name, destination);
  }
  return { root, built, packaged };
}

describe("sidecar packaging build receipt", () => {
  it("records actual paths and hashes without claiming release by default", () => {
    const { root, built, packaged } = fixture();
    const receipt = writeSidecarBuildReceipt(root, built);
    expect(receipt.profile).toBe("unspecified");
    for (const [name, source] of built) {
      expect(receipt.binaries[name].path).toBe(source);
      expect(receipt.binaries[name].sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(verifySidecarBuildReceipt(root, packaged)).toEqual(receipt);
  });

  it.each(["plainsong-sidecar", "plainsong-cli"])("rejects stale packaged %s", (name) => {
    const { root, built, packaged } = fixture();
    writeSidecarBuildReceipt(root, built, { profile: "dev" });
    fs.writeFileSync(packaged.get(name)!, "previous build");
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow(`${name} packaged output`);
  });

  it.each(["plainsong-sidecar", "plainsong-cli"])("rejects a changed or missing source for %s", (name) => {
    const { root, built, packaged } = fixture();
    writeSidecarBuildReceipt(root, built);
    fs.writeFileSync(built.get(name)!, "changed build");
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow(`${name} build output changed`);
    fs.rmSync(built.get(name)!);
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow(`Cannot read ${name} build output`);
  });

  it("rejects missing, malformed, and incomplete receipts", () => {
    const { root, built, packaged } = fixture();
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow("Build the sidecar before packaging");
    const receipt = writeSidecarBuildReceipt(root, built);
    fs.writeFileSync(sidecarBuildReceiptPath(root), "{");
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow("Cannot read sidecar build receipt");
    delete receipt.binaries["plainsong-cli"];
    fs.writeFileSync(sidecarBuildReceiptPath(root), JSON.stringify(receipt));
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow("plainsong-cli");
  });

  it("requires both binary paths when writing and verifying", () => {
    const { root, built, packaged } = fixture();
    writeSidecarBuildReceipt(root, built);
    packaged.delete("plainsong-cli");
    expect(() => verifySidecarBuildReceipt(root, packaged)).toThrow("plainsong-cli packaged output must have an absolute binary path");
    built.delete("plainsong-cli");
    expect(() => writeSidecarBuildReceipt(root, built)).toThrow("plainsong-cli must have an absolute binary path");
  });

  it("requires a receipt only in the packaging hook", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../scripts/verify-packaged-native-helpers.mjs"), "utf8");
    const hook = source.slice(source.indexOf("export default function"), source.indexOf("if (process.argv[1]"));
    expect(hook).toContain("verifySidecarBuildReceipt(");
    expect(hook.indexOf("verifySidecarBuildReceipt(")).toBeLessThan(hook.indexOf("verifyAppBundle("));
    expect(source.slice(source.indexOf("if (process.argv[1]"))).not.toContain("verifySidecarBuildReceipt(");
  });
});
