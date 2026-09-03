import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AppleLanguageModelRow,
  BundledCleanupModelRow,
} from "@/components/models/zero-setup-model-row";
import type {
  AppleLanguageModelAvailability,
  BundledCleanupModelStatus,
} from "@/lib/backend/ai";

function statusFixture(
  overrides: Partial<BundledCleanupModelStatus> = {},
): BundledCleanupModelStatus {
  return {
    provider: "bundled_local",
    modelId: "s1-mini",
    displayName: "S1-mini",
    vendor: "Superwhisper",
    downloadBytes: 495_654_965,
    bytesOnDisk: 0,
    ready: false,
    missingFiles: ["s1-mini-q4_k_m.gguf", "tokenizer.json", "LICENSE", "NOTICE"],
    path: "/models/bundled_cleanup",
    backend: "metal",
    backendMeetsBudget: true,
    backendPresent: true,
    residentBytes: 484_219_808,
    ...overrides,
  };
}

describe("the built-in cleanup model row", () => {
  it("names the model exactly as its license requires", () => {
    render(
      <BundledCleanupModelRow
        status={statusFixture()}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    // Apache-2.0 + naming clause: this exact capitalization, wherever used.
    expect(screen.getByText("S1-mini by Superwhisper")).toBeTruthy();
  });

  it("says both what it does and what it cannot do", () => {
    render(
      <BundledCleanupModelRow
        status={statusFixture()}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("Removes filler words");
    // The honest half: a user must not discover this when a custom mode
    // quietly stops using AI.
    expect(region.textContent).toContain("does not summarize");
    // "Saved profiles", not "custom modes": one word per concept, checked by
    // src/__tests__/settings-vocabulary.test.ts.
    expect(region.textContent).toContain("saved profiles");
    expect(region.textContent).toContain("English only");
  });

  it("offers the download with its measured size when nothing is on disk", () => {
    const onDownload = vi.fn();
    render(
      <BundledCleanupModelRow
        status={statusFixture()}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={onDownload}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText(/473 MiB to download/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("shows download progress instead of an unmoving label", () => {
    render(
      <BundledCleanupModelRow
        status={statusFixture()}
        busy
        progressPercent={42.4}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Downloading 42%" })).toBeTruthy();
  });

  it("offers delete once every pinned file verifies", () => {
    const onDelete = vi.fn();
    render(
      <BundledCleanupModelRow
        status={statusFixture({
          ready: true,
          bytesOnDisk: 495_654_965,
          missingFiles: [],
        })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByText(/On this Mac · 473 MiB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("names the files that failed verification rather than saying 'not ready'", () => {
    // Bytes on disk but no trusted receipt: the model will not load, and the
    // row has to say which file to blame.
    render(
      <BundledCleanupModelRow
        status={statusFixture({
          bytesOnDisk: 400_000_000,
          missingFiles: ["s1-mini-q4_k_m.gguf"],
        })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("s1-mini-q4_k_m.gguf");
    expect(region.textContent).toContain("failed verification");
  });

  it("says the CPU fallback cannot keep up with a long dictation", () => {
    // Measured: 11.26 s p50 for 199 words against a 6 s budget. A user who is
    // not told this discovers it as a "took too long" warning on every long
    // capture, with no way to connect the warning to its cause.
    render(
      <BundledCleanupModelRow
        status={statusFixture({
          ready: true,
          bytesOnDisk: 495_654_965,
          missingFiles: [],
          backend: "cpu",
          backendMeetsBudget: false,
          backendPresent: true,
        })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("CPU");
    expect(region.textContent).toContain("11 to 13");
    expect(region.textContent).toContain("six-second limit");
    // Rust is the "not yet / cannot" color; there is no amber in this app.
    const warning = Array.from(region.querySelectorAll("p")).find((node) =>
      node.textContent?.includes("11 to 13"),
    );
    expect(warning?.className).toContain("text-rust");
  });

  it("does not warn about speed when the GPU is doing the work", () => {
    render(
      <BundledCleanupModelRow
        status={statusFixture({ ready: true, missingFiles: [] })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("GPU");
    expect(region.textContent).not.toContain("11 to 13");
  });

  it("says a build with no runtime cannot clean up at all", () => {
    // Different sentence from the CPU one: "this build cannot run it" is not
    // "this Mac is slow", and only one of them is fixed by a faster Mac.
    render(
      <BundledCleanupModelRow
        status={statusFixture({
          ready: true,
          missingFiles: [],
          backend: "unavailable",
          backendMeetsBudget: false,
          backendPresent: false,
        })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("no runtime");
    expect(region.textContent).not.toContain("11 to 13");
  });

  it("states the memory it holds while it is loaded", () => {
    // Keeping a model warm costs half a gigabyte of RAM; a user choosing
    // between routes is entitled to that number before they choose.
    render(
      <BundledCleanupModelRow
        status={statusFixture({ ready: true, missingFiles: [] })}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(region.textContent).toContain("462 MiB of memory");
    expect(region.textContent).toContain("Keep the model");
  });

  it("shows nothing measured rather than inventing a state", () => {
    render(
      <BundledCleanupModelRow
        status={null}
        busy={false}
        progressPercent={null}
        error={null}
        onDownload={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText(/nothing measured to show/)).toBeTruthy();
  });
});

function availability(
  overrides: Partial<AppleLanguageModelAvailability> = {},
): AppleLanguageModelAvailability {
  return {
    provider: "apple_language_model",
    displayName: "Apple on-device model",
    available: false,
    reason: "apple_intelligence_not_enabled",
    detail:
      "Apple Intelligence is turned off. Turn it on in System Settings to use the Apple on-device model.",
    operatingSystemVersion: "27.0.0",
    ...overrides,
  };
}

describe("the Apple on-device model row", () => {
  it("reports availability and offers a re-check", () => {
    const onRecheck = vi.fn();
    render(
      <AppleLanguageModelRow
        availability={availability({
          available: true,
          reason: null,
          detail: null,
        })}
        checking={false}
        onRecheck={onRecheck}
      />,
    );
    expect(screen.getByText("Available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("gives the reason it cannot run, plus what happens instead", () => {
    // "Not available" alone leaves the user with nothing to do. The probe
    // already distinguishes "this Mac cannot" from "you switched it off".
    render(
      <AppleLanguageModelRow
        availability={availability()}
        checking={false}
        onRecheck={() => {}}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Apple on-device model",
    });
    expect(region.textContent).toContain("Apple Intelligence is turned off");
    expect(region.textContent).toContain("inserted unchanged");
  });

  it("calls a downloading model a wait, not a verdict", () => {
    // "Not available" reads as "this Mac cannot", which is wrong and sends the
    // user to buy a different Mac instead of waiting ten minutes.
    render(
      <AppleLanguageModelRow
        availability={availability({
          reason: "model_not_ready",
          detail:
            "Apple Intelligence is still downloading its model. Try again once it has finished.",
        })}
        checking={false}
        onRecheck={() => {}}
      />,
    );
    expect(screen.getByText("Still downloading")).toBeTruthy();
    expect(screen.queryByText("Not available")).toBeNull();
    const region = screen.getByRole("region", {
      name: "Apple on-device model",
    });
    expect(region.textContent).toContain(
      "Apple Intelligence is still downloading its model",
    );
  });

  it("still says 'Not available' when this Mac genuinely cannot run it", () => {
    render(
      <AppleLanguageModelRow
        availability={availability({ reason: "device_not_eligible" })}
        checking={false}
        onRecheck={() => {}}
      />,
    );
    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("does not claim a verdict while it is still probing", () => {
    render(
      <AppleLanguageModelRow
        availability={null}
        checking
        onRecheck={() => {}}
      />,
    );
    expect(screen.getByText("Checking…")).toBeTruthy();
    expect(screen.queryByText(/Not available/)).toBeNull();
  });
});
