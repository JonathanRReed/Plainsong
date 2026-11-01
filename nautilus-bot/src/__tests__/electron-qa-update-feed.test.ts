import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Session, WebRequest } from "electron";
import { parseQaUpdateFeedUrl, resolveQaUpdateFeedUrl, restrictQaUpdateSession } from "../../electron/qa-update-feed";
import { macosUpdateRelauncherArgs } from "../../electron/updater-channel";

describe("launch-only QA update feed", () => {
  it.each([
    "http://127.0.0.1:18765/", "https://localhost/beta/", "http://[::1]:8000/feed/",
  ])("accepts the exact loopback authority %s", (url) => {
    expect(parseQaUpdateFeedUrl(url)).toBe(url);
  });

  it.each([
    undefined, "", "not a URL", "file:///tmp/feed/", "ftp://localhost/",
    "https://example.com/", "http://127.0.0.1.nip.io/", "http://loopback.example/",
    "http://0x7f000001/", "http://2130706433/", "http://127.1/", "http://0177.0.0.1/",
    "http://127.0.0.01/", "http://127.0.0.2/", "http://localhost./", "http://%6cocalhost/",
    "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:0:0:1]/",
    "http://user:password@localhost/", "http://@localhost/", "http://localhost@evil.test/",
    "http://evil.test@localhost/", "http://localhost:123@evil.test/", "http://localhost:99999/",
    "http://localhost\\@evil.test/", " http://localhost/", "http://local\nhost/",
  ])("rejects ambiguous or non-loopback input %s", (url) => {
    expect(parseQaUpdateFeedUrl(url)).toBeNull();
  });

  it("ignores an invalid launch value and logs once without leaking it", () => {
    const warn = vi.fn();
    expect(resolveQaUpdateFeedUrl("http://secret@evil.test", warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain("secret");
    expect(resolveQaUpdateFeedUrl(undefined, warn)).toBeNull();
    expect(resolveQaUpdateFeedUrl("http://localhost/", warn)).toBe("http://localhost/");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("blocks remote artifact requests and all redirect responses in the updater session", async () => {
    const setProxy = vi.fn<Session["setProxy"]>().mockResolvedValue();
    const onBeforeRequest = vi.fn<WebRequest["onBeforeRequest"]>();
    const onHeadersReceived = vi.fn<WebRequest["onHeadersReceived"]>();
    // Only the two registration methods used by this module are needed.
    await restrictQaUpdateSession({ setProxy, webRequest: { onBeforeRequest, onHeadersReceived } });
    expect(setProxy).toHaveBeenCalledWith({ mode: "direct" });
    const before = onBeforeRequest.mock.calls[0][0];
    const headers = onHeadersReceived.mock.calls[0][0];
    if (typeof before !== "function" || typeof headers !== "function") throw new Error("Missing guards");
    const callback = vi.fn();
    for (const [url, cancel] of [["http://localhost/a.zip", false], ["https://evil.test/a.zip", true]] as const) {
      before({ url } as Electron.OnBeforeRequestListenerDetails, callback);
      expect(callback).toHaveBeenLastCalledWith({ cancel });
    }
    for (const statusCode of [200, 206, 301, 302, 303, 307, 308]) {
      headers({ statusCode } as Electron.OnHeadersReceivedListenerDetails, callback);
      expect(callback).toHaveBeenLastCalledWith({ cancel: statusCode >= 300 });
    }
  });

  it("retains QA launch arguments as arguments and uses the inherited environment on relaunch", () => {
    const args = macosUpdateRelauncherArgs("/tmp/QA.app", "0.9.0-beta.7.1", "/tmp/ready", [
      "--user-data-dir=/tmp/profile", "--remote-debugging-port=12345", "$(touch /tmp/unsafe)",
    ]);
    expect(args.slice(-3)).toEqual(["--user-data-dir=/tmp/profile", "--remote-debugging-port=12345", "$(touch /tmp/unsafe)"]);
    expect(args[1]).toContain('"$target/Contents/MacOS/Plainsong" "$@"');
    expect(args[1]).not.toContain("$(touch");
    expect(args[1]).not.toContain("/usr/bin/open");
  });

  it("reads the override once in main and installs guards before configuring updates", () => {
    const source = readFileSync(resolve("electron/main.ts"), "utf8");
    expect(source.match(/process\.env\.PLAINSONG_QA_UPDATE_FEED_URL/g)).toHaveLength(1);
    expect(source.indexOf("await restrictQaUpdateSession(autoUpdater.netSession)")).toBeLessThan(source.indexOf("configureAutoUpdater(autoUpdater);"));
    expect(readFileSync(resolve("electron/preload.ts"), "utf8")).not.toContain("QA_UPDATE_FEED");
  });
  it.skipIf(process.platform !== "darwin")("runs the QA relaunch shell with inherited HOME and literal arguments", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "plainsong-relaunch-shell-"));
    try {
      const app = path.join(root, "QA.app");
      const executable = path.join(app, "Contents/MacOS/Plainsong");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(path.join(app, "Contents/Info.plist"), '<plist><dict><key>CFBundleShortVersionString</key><string>0.9.0-beta.8</string></dict></plist>');
      writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$HOME" "$PLAINSONG_QA_UPDATE_FEED_URL" "$@" > "$QA_RESULT"
`);
      chmodSync(executable, 0o700);
      const resultPath = path.join(root, "result");
      const injectionPath = path.join(root, "unexpected");
      const literal = `$(touch ${injectionPath})`;
      const args = macosUpdateRelauncherArgs(app, "0.9.0-beta.8", path.join(root, "ready"), ["--user-data-dir=/tmp/qa-profile", literal]);
      const child = spawnSync("/bin/sh", args, { env: { ...process.env, HOME: root, PLAINSONG_QA_UPDATE_FEED_URL: "http://127.0.0.1:1234/", QA_RESULT: resultPath }, encoding: "utf8", timeout: 2000 });
      expect(child.status, child.stderr).toBe(0);
      for (let attempt = 0; attempt < 30 && !existsSync(resultPath); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readFileSync(resultPath, "utf8").split("\n")).toEqual([root, "http://127.0.0.1:1234/", "--user-data-dir=/tmp/qa-profile", literal, ""]);
      expect(existsSync(injectionPath)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
