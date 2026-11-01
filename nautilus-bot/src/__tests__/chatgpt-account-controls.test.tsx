import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptAccountControls } from "@/components/models/chatgpt-account-controls";
import { listen } from "@/lib/electron";

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  refresh: vi.fn(),
  connect: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/backend/chatgpt-plan", () => ({
  EMPTY_CHATGPT_PLAN_STATUS: {
    loaded: false,
    modelsReady: false,
    accounts: [],
    models: [],
  },
  getChatGptPlanStatus: api.getStatus,
  refreshChatGptPlanAccounts: api.refresh,
  connectChatGptPlan: api.connect,
  cancelChatGptPlanConnect: api.cancel,
  selectChatGptPlanAccount: api.select,
  signOutChatGptPlan: api.signOut,
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async () => () => {}),
}));

const UNLOADED = {
  loaded: false,
  modelsReady: false,
  accounts: [],
  models: [],
};

describe("ChatGptAccountControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getStatus.mockResolvedValue(UNLOADED);
  });

  it("reads cached status on mount without refreshing saved accounts", async () => {
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Load saved accounts" })).toBeEnabled();
    expect(api.getStatus).toHaveBeenCalledOnce();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("lets a new user connect before checking saved accounts", async () => {
    api.connect.mockResolvedValue({
      loaded: true,
      modelsReady: true,
      accounts: [{ clientId: "new", label: "Jonathan", active: true, connected: true, planEnabled: true }],
      models: [],
    });
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith());
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it("keeps explicit account actions disabled while cloud AI is off", async () => {
    render(<ChatGptAccountControls remoteProcessingEnabled={false} onStatusChange={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Load saved accounts" })).toBeDisabled();
    expect(screen.getByText(/Allow it under Privacy & data/)).toBeInTheDocument();
  });

  it("loads returning accounts and preserves their backend labels", async () => {
    api.refresh.mockResolvedValue({
      loaded: true,
      modelsReady: true,
      accounts: [
        { clientId: "one", email: "same@example.com", label: "Work (same@example.com)", active: true, connected: true, planEnabled: true },
        { clientId: "two", email: "same@example.com", label: "Personal (same@example.com)", active: false, connected: true, planEnabled: true },
      ],
      models: [{ slug: "gpt-5", displayName: "GPT-5" }],
    });
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load saved accounts" }));
    expect(await screen.findByRole("option", { name: "Work (same@example.com)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Personal (same@example.com)" })).toBeInTheDocument();
  });

  it("explains a connected account whose plan grant is missing", async () => {
    api.getStatus.mockResolvedValue({
      loaded: true,
      modelsReady: true,
      accounts: [{ clientId: "one", label: "Jonathan", active: true, connected: true, planEnabled: false }],
      models: [],
    });
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    expect(await screen.findByText(/has not granted access to ChatGPT plan models/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect with ChatGPT" })).toBeEnabled();
  });

  it("switches accounts only after the user chooses one", async () => {
    const loaded = {
      loaded: true,
      modelsReady: true,
      accounts: [
        { clientId: "one", label: "First", active: true, connected: true, planEnabled: true },
        { clientId: "two", label: "Second", active: false, connected: true, planEnabled: true },
      ],
      models: [],
    };
    api.getStatus.mockResolvedValue(loaded);
    api.select.mockResolvedValue({ ...loaded, accounts: loaded.accounts.map((account) => ({ ...account, active: account.clientId === "two" })) });
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Saved account"), { target: { value: "two" } });
    await waitFor(() => expect(api.select).toHaveBeenCalledWith("two"));
  });

  it("reconnects a selected signed-out account with its saved client id", async () => {
    const loaded = {
      loaded: true,
      modelsReady: true,
      accounts: [
        { clientId: "one", label: "Current", active: true, connected: true, planEnabled: true },
        { clientId: "returning", label: "Returning", active: false, connected: false, planEnabled: false },
      ],
      models: [],
    };
    api.getStatus.mockResolvedValue(loaded);
    api.connect.mockResolvedValue({
      ...loaded,
      accounts: loaded.accounts.map((account) => ({
        ...account,
        active: account.clientId === "returning",
        connected: account.clientId === "returning" ? true : account.connected,
      })),
    });
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    expect(await screen.findByRole("option", { name: "Returning (signed out)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Saved account"), { target: { value: "returning" } });
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith("returning"));
    expect(api.select).not.toHaveBeenCalled();
  });

  it("can add another account without reauthorizing the active one", async () => {
    const loaded = {
      loaded: true,
      modelsReady: true,
      accounts: [{ clientId: "active", label: "Current", active: true, connected: true, planEnabled: true }],
      models: [],
    };
    api.getStatus.mockResolvedValue(loaded);
    api.connect.mockResolvedValue(loaded);
    render(<ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add another account" }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith());
  });

  it("disposes a listener that finishes subscribing after unmount", async () => {
    const stop = vi.fn();
    let finishSubscription: ((value: () => void) => void) | undefined;
    vi.mocked(listen).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSubscription = resolve;
      }),
    );
    const view = render(
      <ChatGptAccountControls remoteProcessingEnabled onStatusChange={vi.fn()} />,
    );

    view.unmount();
    finishSubscription?.(stop);
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });
});
