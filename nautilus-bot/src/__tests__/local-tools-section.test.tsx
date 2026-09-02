import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalToolsSection } from "@/components/local-tools-section";
import { ToastProvider } from "@/components/toast";

const backend = vi.hoisted(() => ({
  getCliToolStatus: vi.fn(),
  installCliTool: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getCliToolStatus: backend.getCliToolStatus,
  installCliTool: backend.installCliTool,
}));

const binaryPath = "/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli";
const manualCommand = `sudo ln -sfn '${binaryPath}' /usr/local/bin/plainsong`;

function status(overrides: Partial<{
  binaryPresent: boolean;
  installed: boolean;
  stale: boolean;
  occupied: boolean;
}> = {}) {
  return {
    binaryPath,
    binaryPresent: true,
    linkPath: "/usr/local/bin/plainsong",
    installed: false,
    stale: false,
    occupied: false,
    manualCommand,
    ...overrides,
  };
}

function renderSection(enabled = false, onEnabledChange = vi.fn()) {
  render(
    <ToastProvider>
      <LocalToolsSection enabled={enabled} onEnabledChange={onEnabledChange} />
    </ToastProvider>,
  );
  return onEnabledChange;
}

describe("LocalToolsSection", () => {
  beforeEach(() => {
    backend.getCliToolStatus.mockReset();
    backend.installCliTool.mockReset();
    backend.getCliToolStatus.mockResolvedValue(status());
  });

  it("states what the switch allows and reports it off", async () => {
    const onEnabledChange = renderSection(false);
    expect(screen.getByText("Local tools")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Apps you run on this Mac, such as a terminal or an AI assistant, can read your meeting notes and transcripts\. Nothing leaves the machine unless that app sends it\./,
      ),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Allow local tools" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(screen.getByTestId("cli-tool-status")).toHaveTextContent(
        "Not installed. Installing adds /usr/local/bin/plainsong",
      ),
    );
  });

  it("shows the paste-able command when the app cannot write the link", async () => {
    backend.installCliTool.mockResolvedValue({
      status: "manual",
      reason: "Plainsong cannot write to /usr/local/bin without administrator rights.",
      command: manualCommand,
    });
    renderSection(true);
    const button = await screen.findByRole("button", { name: "Install command-line tool" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(backend.installCliTool).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(manualCommand)).toBeInTheDocument();
    expect(
      screen.getByText(/cannot write to \/usr\/local\/bin without administrator rights/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });

  it("reports an installed link and disables the install action", async () => {
    backend.getCliToolStatus.mockResolvedValue(status({ installed: true }));
    renderSection(true);
    await waitFor(() =>
      expect(screen.getByTestId("cli-tool-status")).toHaveTextContent(
        "Installed. The plainsong command at /usr/local/bin/plainsong points at this copy of Plainsong.",
      ),
    );
    expect(screen.getByRole("button", { name: "Install command-line tool" })).toBeDisabled();
  });

  it("names a stale link, an occupied path, and a build without the tool", async () => {
    backend.getCliToolStatus.mockResolvedValue(status({ stale: true }));
    const { unmount } = render(
      <ToastProvider>
        <LocalToolsSection enabled onEnabledChange={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("cli-tool-status")).toHaveTextContent(
        "points at an older copy of Plainsong. Install again to update it.",
      ),
    );
    expect(screen.getByRole("button", { name: "Install command-line tool" })).toBeEnabled();
    unmount();

    backend.getCliToolStatus.mockResolvedValue(status({ occupied: true }));
    const second = render(
      <ToastProvider>
        <LocalToolsSection enabled onEnabledChange={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("cli-tool-status")).toHaveTextContent(
        "already exists and is not a Plainsong link, so Plainsong leaves it alone.",
      ),
    );
    expect(screen.getByRole("button", { name: "Install command-line tool" })).toBeDisabled();
    second.unmount();

    backend.getCliToolStatus.mockResolvedValue(status({ binaryPresent: false }));
    render(
      <ToastProvider>
        <LocalToolsSection enabled onEnabledChange={vi.fn()} />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("cli-tool-status")).toHaveTextContent(
        "The command-line tool is not part of this build.",
      ),
    );
  });
});
