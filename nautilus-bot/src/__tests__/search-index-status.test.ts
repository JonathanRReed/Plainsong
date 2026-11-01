import { describe, expect, it } from "vitest";
import { describeSearchIndexWait } from "@/lib/search-index-status";

describe("describeSearchIndexWait", () => {
  it("reads a pause as written", () => {
    expect(describeSearchIndexWait("Paused in Low Power Mode.")).toBe("Indexing paused in Low Power Mode.");
  });

  it("names a memory refusal without the loader's wording", () => {
    const text = describeSearchIndexWait(
      "Not enough verified memory headroom for native inference working buffers alongside other applications.",
    );
    expect(text).toBe("Indexing is waiting for free memory and will continue on its own.");
    expect(text).not.toMatch(/headroom|inference/);
  });

  it("keeps internal failures out of Settings", () => {
    expect(describeSearchIndexWait("The search model task ended: JoinError::Cancelled")).toBe(
      "Indexing stopped on an error and will try again on its own.",
    );
    expect(describeSearchIndexWait(null)).toBeNull();
  });
});
