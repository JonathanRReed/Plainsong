import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { DecorativeBoundary } from "@/components/ui/decorative-boundary";

function BrokenEffect(): never {
  throw new Error("no WebAudio here");
}

describe("DecorativeBoundary", () => {
  it("shows the plain surface when the effect throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <DecorativeBoundary fallback={<p>Listening</p>}>
        <BrokenEffect />
      </DecorativeBoundary>,
    );
    expect(screen.getByText("Listening")).toBeInTheDocument();
    warn.mockRestore();
    error.mockRestore();
  });

  it("renders the effect when it works", () => {
    render(
      <DecorativeBoundary fallback={<p>plain</p>}>
        <p>glowing</p>
      </DecorativeBoundary>,
    );
    expect(screen.getByText("glowing")).toBeInTheDocument();
  });
});
