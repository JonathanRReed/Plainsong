import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Cdp } from "../../scripts/capture-packaged-macos-launch-performance.mjs";

describe("launch CDP client", () => {
  it("rejects a stalled request at its deadline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cdp = new Cdp(input, output);
    await expect(
      cdp.send("Target.getTargets", {}, Date.now() + 20),
    ).rejects.toThrow("deadline");
  });

  it("rejects every pending request when the response pipe closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const cdp = new Cdp(input, output);
    const pending = cdp.send("Target.getTargets", {}, Date.now() + 1000);
    output.destroy();
    await expect(pending).rejects.toThrow("closed");
  });
});
