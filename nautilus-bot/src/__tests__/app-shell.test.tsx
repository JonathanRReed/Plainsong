import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { ErrorBoundary } from "@/App";
import { ONBOARDING_STORAGE_KEY } from "@/lib/onboarding";

type Listener = (event: { payload: unknown }) => void;

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: {} as Record<string, Listener>,
}));

vi.mock("@/lib/electron", () => ({
  invoke: electronMocks.invoke,
  listen: vi.fn((event: string, handler: Listener) => {
    electronMocks.listeners[event] = handler;
    return Promise.resolve(() => {
      delete electronMocks.listeners[event];
    });
  }),
}));

vi.mock("@/components/views/dashboard-view", () => ({
  DashboardView: () => <div>Mock home workspace</div>,
}));
vi.mock("@/components/views/dictation-view", () => ({
  DictationView: () => <div>Mock dictation workspace</div>,
}));
vi.mock("@/components/views/recordings-view", () => ({
  RecordingsView: () => <div>Mock meetings workspace</div>,
}));
vi.mock("@/components/views/projects-view", () => ({
  ProjectsView: () => <div>Mock projects workspace</div>,
}));
vi.mock("@/components/views/exports-view", () => ({
  ExportsView: () => <div>Mock exports workspace</div>,
}));
vi.mock("@/components/views/settings-view-simple", () => ({
  SettingsView: () => <div>Mock settings workspace</div>,
}));
vi.mock("@/components/views/setup-view", () => ({
  SetupView: () => <div>Mock setup workspace</div>,
}));

vi.mock("@/features/readiness/product-readiness-context", () => ({
  ProductReadinessProvider: ({ children }: { children: ReactNode }) => children,
  useProductReadinessStatus: () => ({
    productReadiness: {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: { domain: "meetings", state: "ready", cause: null },
      fullCapture: { domain: "full_capture", state: "ready", cause: null },
      overall: { domain: "overall", state: "ready", cause: null },
    },
  }),
}));

vi.mock("@/components/first-run-wizard", () => ({
  FirstRunWizard: ({ mode, onComplete }: { mode: string; onComplete: () => void }) => (
    <div role="dialog" aria-label="First-run wizard">
      First-run wizard: {mode}
      <button type="button" onClick={onComplete}>
        Complete setup
      </button>
    </div>
  ),
}));

const settings = {
  theme: "dark",
  ui: { colorScheme: "default" },
  privacy: {
    dictationAi: { provider: "ollama", modelId: null },
    meetingsAi: { provider: "ollama", modelId: null },
    remoteProcessingEnabled: false,
  },
  shortcuts: {
    toggleDictation: "CommandOrControl+Shift+D",
  },
  transcription: {
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
  },
};

describe("App shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.listeners = {};
    const localStore = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => localStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStore.delete(key);
      }),
      clear: vi.fn(() => {
        localStore.clear();
      }),
    } as Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    electronMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_settings") {
        return settings;
      }
      if (command === "get_recording_overlay_state") {
        return { phase: "idle", recordingId: null, startedAtMs: null, systemAudioActive: false };
      }
      if (command === "get_dictation_overlay_state") {
        return { phase: "idle", dismissed: false, message: null, preview: null };
      }
      return null;
    });
  });

  it("opens to dictation for returning users and routes with app shortcuts", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");

    render(<App />);

    expect(await screen.findByText("Mock dictation workspace")).toBeInTheDocument();

    // jsdom reports a non-mac platform, so the primary modifier is Ctrl.
    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("Mock home workspace")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(await screen.findByText("Mock dictation workspace")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "m", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("Mock meetings workspace")).toBeInTheDocument();

    // Plain Ctrl+M (without Shift) belongs to the OS minimize accelerator and
    // must not navigate.
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    expect(screen.getByText("Mock meetings workspace")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(await screen.findByText("Mock projects workspace")).toBeInTheDocument();

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "h", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("Mock projects workspace")).toBeInTheDocument();
    input.remove();

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(await screen.findByText("Mock settings workspace")).toBeInTheDocument();
  });

  it("names the active workspace and moves keyboard focus after navigation", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");

    render(<App />);

    const skipLink = screen.getByRole("link", { name: "Skip to workspace" });
    expect(skipLink).toHaveAttribute("href", "#main-content");

    const initialMain = await screen.findByRole("main", {
      name: "Dictation workspace",
    });
    expect(initialMain).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });

    const homeMain = await screen.findByRole("main", {
      name: "Home workspace",
    });
    await waitFor(() => {
      expect(homeMain).toHaveFocus();
      expect(screen.getByRole("status", { name: "Current workspace" })).toHaveTextContent(
        "Home workspace",
      );
    });
  });

  it("shows first-run onboarding until setup completes", async () => {
    render(<App />);

    expect(await screen.findByRole("dialog", { name: "First-run wizard" })).toHaveTextContent(
      "First-run wizard: full"
    );

    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "First-run wizard" })).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
  });

  it("surfaces runtime provider warnings as toasts", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");

    render(<App />);

    await screen.findByText("Mock dictation workspace");

    await waitFor(() => {
      expect(electronMocks.listeners["asr-provider-warning"]).toBeDefined();
    });

    act(() => {
      electronMocks.listeners["asr-provider-warning"]({ payload: "Local model is unavailable" });
    });

    expect(await screen.findByText("Local model is unavailable")).toBeInTheDocument();
  });

  it("shows a recoverable error boundary when a child view crashes", async () => {
    function CrashOnDemand() {
      const [crashed, setCrashed] = useState(false);
      if (crashed) {
        throw new Error("Dictation view failed");
      }
      return (
        <button type="button" onClick={() => setCrashed(true)}>
          Crash workspace
        </button>
      );
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <CrashOnDemand />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Crash workspace" }));

    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Dictation view failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));

    expect(await screen.findByRole("button", { name: "Crash workspace" })).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
