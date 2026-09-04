import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/capture-packaged-macos-onboarding-first-run.mjs"),
  "utf8",
);

describe("packaged macOS first-run onboarding harness", () => {
  it("uses inherited private CDP pipes without exposing a loopback endpoint", () => {
    expect(source).toContain('"--remote-debugging-pipe"');
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]');
    expect(source).toContain("new Cdp(child.stdio[3], child.stdio[4])");

    expect(source).not.toMatch(/--remote-debugging-port(?:=|\b)/);
    expect(source).not.toMatch(/https?:\/\/(?:127\.0\.0\.1|localhost)/);
    expect(source).not.toContain("/json/version");
    expect(source).not.toContain("webSocketDebuggerUrl");
  });

  it("NUL-frames CDP reads and writes", () => {
    expect(source).toContain('const frames = buffered.split("\\0")');
    expect(source).toContain("buffered = frames.pop()");
    expect(source).toContain("this.receive(JSON.parse(frame))");
    expect(source).toContain('this.input.write(`${JSON.stringify(message)}\\0`)');
  });

  it("attaches to the renderer and routes later commands through its session", () => {
    expect(source).toContain('cdp.send("Target.getTargets")');
    expect(source).toContain('cdp.send("Target.attachToTarget", {');
    expect(source).toContain("targetId: page.targetId");
    expect(source).toContain("flatten: true");
    expect(source).toContain("cdp.sessionId = sessionId");
    expect(source).toContain("if (this.sessionId) message.sessionId = this.sessionId");
  });

  it("preserves the four first-run scenarios and durable result checks", () => {
    for (const label of ["fresh", "legacy-flag", "stale-record", "defer"]) {
      expect(source).toContain(`label: "${label}"`);
    }

    expect(source).toContain('localStorage.setItem("nautilus_onboarding_complete", "true")');
    expect(source).toContain("staleSettings.onboarding = {");
    expect(source).toContain("Boolean(afterDefer?.onboarding?.deferredAt)");
    expect(source).toContain("process.exit(1)");
  });
});
