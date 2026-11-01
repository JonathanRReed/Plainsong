import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUMMARY_GROUNDING_POLICY_VERSION } from "@/types/asr";

describe("analysis policy boundary", () => {
  it("keeps the renderer policy aligned with the backend acceptance checks", () => {
    const models = readFileSync("rust-sidecar/src/models.rs", "utf8");
    const version = models.match(/pub const SUMMARY_GROUNDING_POLICY_VERSION: u32 = (\d+);/);
    expect(version).not.toBeNull();
    expect(SUMMARY_GROUNDING_POLICY_VERSION).toBe(Number(version![1]));
  });
});
