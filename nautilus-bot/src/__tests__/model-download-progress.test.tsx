import { act, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ModelDownloadProgress } from "@/components/models/model-download-progress";

it("names paired downloads and announces only 25% milestones", () => {
  const view = (value: number, active = true) => <>
    <section aria-label="Dictation"><ModelDownloadProgress name="Whisper" active={active} value={value} /></section>
    <section aria-label="Meetings"><ModelDownloadProgress name="Parakeet" active={active} value={null} /></section>
  </>;
  const { rerender } = render(view(0, false));
  const live = within(screen.getByRole("region", { name: "Dictation" })).getByRole("status");
  expect(live).toBeEmptyDOMElement();
  rerender(view(0));
  expect(live).toHaveTextContent("Downloading Whisper. Download started.");
  rerender(view(26));
  expect(live).toHaveTextContent("25% complete");
  const milestone = live.textContent;
  rerender(view(49));
  expect(live.textContent).toBe(milestone);
  rerender(view(50));
  expect(live).toHaveTextContent("50% complete");
  expect(screen.getByRole("progressbar", { name: "Whisper download" })).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByRole("progressbar", { name: "Parakeet download" })).not.toHaveAttribute("aria-valuenow");
});
it("announces unknown-length downloads every 30 seconds and cleans up its timer", () => {
  vi.useFakeTimers();
  try {
    const { unmount } = render(<ModelDownloadProgress name="Parakeet" active value={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Progress isn't available yet");
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("status")).toHaveTextContent("30 seconds elapsed");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each([NaN, Infinity, -Infinity])("treats invalid progress %s as unknown", (value) => {
  render(<ModelDownloadProgress name="Parakeet" active value={value} />);
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  expect(screen.getByRole("status")).toHaveTextContent("Progress isn't available yet");
  expect(screen.getByRole("status")).not.toHaveTextContent(/NaN|Infinity|complete/);
});

it.each([[-10, 0], [125, 100]])("clamps progress %s for both the bar and announcement", (value, expected) => {
  render(<ModelDownloadProgress name="Parakeet" active value={value} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(expected));
});
