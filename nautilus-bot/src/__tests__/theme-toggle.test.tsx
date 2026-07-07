import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { invoke } from "@/lib/electron";

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(),
}));

const settings = {
  theme: "dark",
  ui: {
    colorScheme: "default",
  },
};

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_settings") {
        return settings;
      }
      if (command === "save_settings") {
        Object.assign(settings, args?.settings);
        return null;
      }
      return null;
    });
  });

  it("shows the active theme and persists theme changes", async () => {
    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );

    await user.click(screen.getByRole("button", { name: "Toggle theme" }));

    const darkItem = await screen.findByRole("menuitemradio", { name: /Dark/ });
    expect(darkItem).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Light/ })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await user.click(screen.getByRole("menuitemradio", { name: /Light/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("save_settings", {
        settings: {
          ...settings,
          theme: "light",
        },
      });
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
