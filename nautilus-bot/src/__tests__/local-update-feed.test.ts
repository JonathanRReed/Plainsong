import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile, startLocalUpdateFeed } from "../../scripts/lib/local-update-feed";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-local-feed-test-"));
  roots.push(root);
  const zipName = "Plainsong-0.9.0-beta.7.1-arm64.zip";
  const zip = crypto.randomBytes(128 * 1024);
  const manifest = path.join(root, "beta-mac.yml");
  const sha512 = crypto.createHash("sha512").update(zip).digest("base64");
  fs.writeFileSync(path.join(root, zipName), zip);
  fs.writeFileSync(path.join(root, `${zipName}.blockmap`), "fixture blockmap");
  fs.writeFileSync(manifest, `version: 0.9.0-beta.7.1\nfiles:\n  - url: ${zipName}\n    sha512: ${sha512}\n    size: ${zip.length}\npath: ${zipName}\nsha512: ${sha512}\n`);
  return { root, zipName, zip, manifest, sha512 };
}

describe("local packaged updater feed", () => {
  it("serves the candidate manifest, ZIP, blockmap and byte ranges on 127.0.0.1", async () => {
    const f = fixture();
    const feed = await startLocalUpdateFeed(f.manifest, "success");
    try {
      expect(new URL(feed.url).hostname).toBe("127.0.0.1");
      expect(await (await fetch(new URL("beta-mac.yml", feed.url))).text()).toContain("0.9.0-beta.7.1");
      expect(Buffer.from(await (await fetch(new URL(f.zipName, feed.url))).arrayBuffer())).toEqual(f.zip);
      expect(await (await fetch(new URL(`${f.zipName}.blockmap`, feed.url))).text()).toBe("fixture blockmap");
      const range = await fetch(new URL(f.zipName, feed.url), { headers: { Range: "bytes=7-31" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("Content-Range")).toBe(`bytes 7-31/${f.zip.length}`);
      expect(Buffer.from(await range.arrayBuffer())).toEqual(f.zip.subarray(7, 32));
      expect((await fetch(new URL(f.zipName, feed.url), { headers: { Range: "bytes=999999-" } })).status).toBe(416);
      expect((await fetch(new URL("outside.txt", feed.url))).status).toBe(404);
    } finally { await feed.close(); }
  });

  it("drops the first ZIP mid-body, then serves a complete retry and a resumed range", async () => {
    const f = fixture();
    const feed = await startLocalUpdateFeed(f.manifest, "interrupted");
    try {
      const first = await fetch(new URL(f.zipName, feed.url));
      await expect(first.arrayBuffer()).rejects.toThrow();
      const retry = await fetch(new URL(f.zipName, feed.url));
      expect(Buffer.from(await retry.arrayBuffer())).toEqual(f.zip);
      const resume = await fetch(new URL(f.zipName, feed.url), { headers: { Range: "bytes=65536-" } });
      expect(resume.status).toBe(206);
      expect(Buffer.from(await resume.arrayBuffer())).toEqual(f.zip.subarray(65536));
      expect(feed.requests.filter((request) => request.dropped)).toHaveLength(1);
    } finally { await feed.close(); }
  });

  it("corrupts only the temporary ZIP, leaving the manifest hash and candidate intact", async () => {
    const f = fixture();
    const feed = await startLocalUpdateFeed(f.manifest, "corrupt");
    try {
      const bytes = Buffer.from(await (await fetch(new URL(f.zipName, feed.url))).arrayBuffer());
      expect(bytes.length).toBe(f.zip.length);
      expect(crypto.createHash("sha512").update(bytes).digest("base64")).not.toBe(f.sha512);
      expect(await hashFile(path.join(f.root, f.zipName), "sha512", "base64")).toBe(f.sha512);
      expect(await (await fetch(new URL("beta-mac.yml", feed.url))).text()).toContain(f.sha512);
    } finally { await feed.close(); }
  });

  it("rejects a ZIP that did not match the candidate manifest before fault injection", async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, f.zipName), "bad");
    await expect(startLocalUpdateFeed(f.manifest, "success")).rejects.toThrow("does not match");
  });

  it.each(["https://evil.test/a.zip", "../outside.zip"]) ("rejects non-static artifact path %s", async (name) => {
    const f = fixture();
    fs.writeFileSync(f.manifest, fs.readFileSync(f.manifest, "utf8").replaceAll(f.zipName, name));
    await expect(startLocalUpdateFeed(f.manifest, "success")).rejects.toThrow("relative ZIP basename");
  });

  it("dry-runs all scenarios without launching an app or claiming journey proof", () => {
    const f = fixture();
    const cli = ["scripts/capture-packaged-macos-beta-update.ts", "--dry-run", "--manifest", f.manifest];
    for (const [label, version, content] of [["before", "0.9.0-beta.7", "old"], ["after", "0.9.0-beta.7.1", "new"]]) {
      const app = path.join(f.root, `${label}.app`);
      fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
      fs.writeFileSync(path.join(app, "Contents/Info.plist"), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
      const artifact = path.join(f.root, `${label}.dmg`);
      fs.writeFileSync(artifact, content);
      const trust = path.join(f.root, `${label}-trust.json`);
      fs.writeFileSync(trust, JSON.stringify({ pass: true, packageVersion: version, artifactSha256: crypto.createHash("sha256").update(content).digest("hex") }));
      cli.push(`--${label}-app`, app, `--${label}-artifact`, artifact, `--${label}-trust`, trust, `--expected-${label}-version`, version);
    }
    const result = spawnSync("bun", cli, { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "dry-run", inputsValid: true, pass: false, packagedJourneyRun: false, scenarios: ["corrupt", "interrupted", "success"] });
    const same = [...cli];
    same[same.indexOf("--expected-after-version") + 1] = "0.9.0-beta.7+qa";
    const rejected = spawnSync("bun", same, { encoding: "utf8", timeout: 10_000 });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("strictly newer SemVer");
  });
});
