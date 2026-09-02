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
    expect(region.textContent).toContain("custom modes");
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
