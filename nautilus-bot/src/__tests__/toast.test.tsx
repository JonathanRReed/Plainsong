import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/toast";

function Harness() {
  const { toast } = useToast();
  return <>
    <button onClick={() => toast("Saved", "success")}>Success</button>
    <button onClick={() => toast("Try again", "error")}>Error</button>
    <button onClick={() => toast("Open Settings", "info")}>Action</button>
  </>;
}
afterEach(() => vi.useRealTimers());
it("keeps the announcement container mounted and errors and action messages until dismissed", () => {
  vi.useFakeTimers();
  const { container } = render(<ToastProvider><Harness /></ToastProvider>);
  const live = container.querySelector('[aria-live="polite"]');
  expect(live).not.toBeNull();
  fireEvent.click(screen.getByText("Error"));
  fireEvent.click(screen.getByText("Action"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText("Try again")).toBeInTheDocument();
  expect(screen.getByText("Open Settings")).toBeInTheDocument();
  screen.getAllByLabelText("Dismiss notification").forEach((button) => fireEvent.click(button));
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
});
it.each(["hover", "focus"])("pauses success expiry during %s and resumes the remaining time", (interaction) => {
  vi.useFakeTimers();
  render(<ToastProvider><Harness /></ToastProvider>);
  fireEvent.click(screen.getByText("Success"));
  act(() => vi.advanceTimersByTime(1000));
  const item = screen.getByText("Saved").closest('[role="status"]')!;
  const button = screen.getByLabelText("Dismiss notification");
  if (interaction === "hover") fireEvent.mouseEnter(item);
  else fireEvent.focus(button);
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText("Saved")).toBeInTheDocument();
  if (interaction === "hover") fireEvent.mouseLeave(item);
  else fireEvent.blur(button);
  act(() => vi.advanceTimersByTime(2499));
  expect(screen.getByText("Saved")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Saved")).not.toBeInTheDocument();
});
