import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appReceiptMatchesBinding,
  bindAppReceipt,
  captureAppReceiptBinding,
} from "../../scripts/lib/app-receipt-binding.ts";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-app-receipt-"));
  roots.push(root);
  const app = path.join(root, "Plainsong.app");
  const helper = path.join(app, "Contents/Resources/sidecar/plainsong-cli");
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "original helper");
  return { root, app, helper };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("app receipt binding", () => {
  it("qualifies only an unchanged successful capture without exposing the app path", () => {
    const { app } = fixture();
    const binding = captureAppReceiptBinding(app);
    const receipt = bindAppReceipt({ pass: true, checks: { completed: true } }, binding);
    expect(receipt.pass).toBe(true);
    expect(receipt.candidateAppUnchanged).toBe(true);
    expect(receipt.candidateIdentity.appBundle.sha256).toBe(binding.appBundleSha256);
    expect(JSON.stringify(receipt)).not.toContain(app);
    expect(appReceiptMatchesBinding(receipt, binding)).toBe(true);
    expect(bindAppReceipt({ pass: false }, binding).pass).toBe(false);
  });

  it("rejects a helper replacement even when its timestamp is preserved", () => {
    const { app, helper } = fixture();
    const binding = captureAppReceiptBinding(app);
    const stat = fs.statSync(helper);
    fs.writeFileSync(helper, "replacement helper");
    fs.utimesSync(helper, stat.atime, stat.mtime);
    const receipt = bindAppReceipt({ pass: true }, binding);
    expect(receipt.pass).toBe(false);
    expect(receipt.candidateAppUnchanged).toBe(false);
    expect(receipt.candidateIdentity.appBundle.sha256).toBe(binding.appBundleSha256);
    expect(appReceiptMatchesBinding(receipt, captureAppReceiptBinding(app))).toBe(false);
  });

  it("rejects a changed executable mode and a retargeted symlink", () => {
    const { app, helper } = fixture();
    fs.chmodSync(helper, 0o644);
    const binding = captureAppReceiptBinding(app);
    fs.chmodSync(helper, 0o755);
    expect(bindAppReceipt({ pass: true }, binding).pass).toBe(false);
    const link = path.join(app, "Contents/Current");
    fs.symlinkSync("Resources", link);
    const linked = captureAppReceiptBinding(app);
    fs.unlinkSync(link);
    fs.symlinkSync("Resources/sidecar", link);
    expect(bindAppReceipt({ pass: true }, linked).pass).toBe(false);
  });

  it("refuses missing bundles and final reads through a replaced bundle symlink", () => {
    const { root, app } = fixture();
    const missing = captureAppReceiptBinding(path.join(root, "Missing.app"));
    expect(bindAppReceipt({ pass: true }, missing).pass).toBe(false);
    const binding = captureAppReceiptBinding(app);
    const moved = path.join(root, "Moved.app");
    fs.renameSync(app, moved);
    fs.symlinkSync(moved, app);
    expect(bindAppReceipt({ pass: true }, binding)).toMatchObject({
      pass: false, candidateAppUnchanged: false,
    });
  });

  it("rejects identity-free, stale and unfinished child receipts", () => {
    const { app } = fixture();
    const binding = captureAppReceiptBinding(app);
    expect(appReceiptMatchesBinding({ pass: true }, binding)).toBe(false);
    expect(appReceiptMatchesBinding({
      candidateIdentity: { appBundle: { sha256: "0".repeat(64) } },
      candidateAppUnchanged: true,
    }, binding)).toBe(false);
    expect(appReceiptMatchesBinding({
      candidateIdentity: { appBundle: { sha256: binding.appBundleSha256 } },
      candidateAppUnchanged: false,
    }, binding)).toBe(false);
  });
});
