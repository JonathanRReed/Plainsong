import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { ErrorBoundary } from "@/App";
import type { Settings } from "@/types/settings";
import { requestOnboarding } from "@/lib/onboarding";

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

/**
 * What the first-run gate reads. `readiness` is mutated per test to stand for
 * a Mac in a particular state: the shell's own tests care about which screen
 * comes up, and the decision rules themselves are covered exhaustively in
 * onboarding-gate.test.ts.
 */
const readiness = {
  settings: null as unknown,
  providers: [] as unknown[],
  permissions: null as unknown,
  dictationRoute: { ready: false },
  loading: false,
  error: null as string | null,
};

function setReadiness(next: Partial<typeof readiness>) {
  Object.assign(readiness, next);
}

/** A Mac where dictation genuinely works, and setup was recorded in June. */
function readyMac(onboarding: Record<string, unknown> | undefined) {
  return {
    settings: {
      ...settings,
      ...(onboarding ? { onboarding } : {}),
    } as unknown as Settings,
    providers: [{ providerType: "whisper" }],
    permissions: {
      microphoneReady: true,
      microphonePermissionReady: true,
      accessibilityReady: true,
      cursorInsertionReady: true,
      automationReady: true,
      notes: [],
    },
    dictationRoute: { ready: true },
    loading: false,
    error: null,
  };
}

vi.mock("@/features/readiness/product-readiness-context", () => ({
  ProductReadinessProvider: ({ children }: { children: ReactNode }) => children,
  useProductReadinessStatus: () => ({
    ...readiness,
    productReadiness: {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: { domain: "meetings", state: "ready", cause: null },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "ready",
        cause: null,
      },
      fullCapture: { domain: "full_capture", state: "ready", cause: null },
      overall: { domain: "overall", state: "ready", cause: null },
    },
  }),
}));

vi.mock("@/components/first-run-wizard", () => ({
  FirstRunWizard: ({
    mode,
    onComplete,
  }: {
    mode: string;
    onComplete: (result?: { deferred?: boolean }) => void;
  }) => (
    <div role="dialog" aria-label="First-run wizard">
      First-run wizard: {mode}
      <button type="button" onClick={() => onComplete()}>
        Complete setup
      </button>
      <button type="button" onClick={() => onComplete({ deferred: true })}>
        Skip setup for now
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
    // Default: a fresh install. Settings have loaded and say nothing about
    // onboarding, no provider is ready, no permission is granted.
    setReadiness({
      settings: settings as unknown as Settings,
      providers: [{ providerType: "whisper" }],
      permissions: {
        microphoneReady: false,
        microphonePermissionReady: false,
        accessibilityReady: false,
        cursorInsertionReady: false,
        automationReady: false,
        notes: [],
      },
      dictationRoute: { ready: false },
      loading: false,
      error: null,
    });
    electronMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_settings") {
        return settings;
      }
      if (command === "record_onboarding_state") {
        return {};
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
    setReadiness(readyMac({ completedAt: "2026-06-19T10:04:00Z" }));

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
    setReadiness(readyMac({ completedAt: "2026-06-19T10:04:00Z" }));

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

  it("shows first-run onboarding until setup completes, and records it in settings", async () => {
    render(<App />);

    expect(await screen.findByRole("dialog", { name: "First-run wizard" })).toHaveTextContent(
      "First-run wizard: full"
    );

    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "First-run wizard" })).not.toBeInTheDocument();
    });
    // Into settings.json through the sidecar, not into a renderer localStorage
    // that every development build shares with the packaged app.
    expect(electronMocks.invoke).toHaveBeenCalledWith("record_onboarding_state", {
      event: "completed",
      meetingsCompleted: false,
      unmet: [],
    });
  });

  /**
   * The reported bug: a signed DMG installed onto a Mac that had ever run a
   * development build read `nautilus_onboarding_complete = true` out of the
   * shared Electron user-data directory and skipped setup in silence, so the
   * reader had to find and grant every macOS permission themselves.
   */
  it("still shows onboarding when a stale renderer flag claims setup happened but the Mac is not set up", async () => {
    localStorage.setItem("nautilus_onboarding_complete", "true");

    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "First-run wizard" }),
    ).toHaveTextContent("First-run wizard: full");
  });

  it("does not re-run the wizard for a working install carrying the old flag, and writes the record instead", async () => {
    localStorage.setItem("nautilus_onboarding_complete", "true");
    setReadiness(readyMac(undefined));

    render(<App />);

    expect(await screen.findByText("Mock dictation workspace")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "First-run wizard" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(electronMocks.invoke).toHaveBeenCalledWith("record_onboarding_state", {
        event: "migrated",
        meetingsCompleted: false,
        unmet: [],
      });
    });
  });

  // Completed in June, Accessibility revoked in September.
  it("reopens onboarding for a completed install whose permissions were revoked", async () => {
    const mac = readyMac({ completedAt: "2026-06-19T10:04:00Z" });
    setReadiness({
      ...mac,
      permissions: { ...(mac.permissions as object), cursorInsertionReady: false },
    });

    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "First-run wizard" }),
    ).toHaveTextContent("First-run wizard: full");
  });

  it("records what the reader deferred when they skip setup", async () => {
    render(<App />);

    await screen.findByRole("dialog", { name: "First-run wizard" });
    fireEvent.click(screen.getByRole("button", { name: "Skip setup for now" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "First-run wizard" }),
      ).not.toBeInTheDocument();
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith("record_onboarding_state", {
      event: "deferred",
      meetingsCompleted: false,
      unmet: ["microphone_permission", "cursor_insertion", "dictation_model"],
    });
  });

  it("does not reopen setup in a loop when the reader finishes it with something still missing", async () => {
    render(<App />);

    await screen.findByRole("dialog", { name: "First-run wizard" });
    // Finished the wizard, but the model download was skipped, so the gate
    // still says this Mac cannot dictate.
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "First-run wizard" }),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Mock dictation workspace")).toBeInTheDocument();
    // What is left over is recorded as a deferral, so the next launch is quiet
    // about exactly this and still speaks up if something else breaks.
    await waitFor(() => {
      expect(electronMocks.invoke).toHaveBeenCalledWith("record_onboarding_state", {
        event: "deferred",
        meetingsCompleted: false,
        unmet: ["microphone_permission", "cursor_insertion", "dictation_model"],
      });
    });
    // And it stays closed.
    expect(
      screen.queryByRole("dialog", { name: "First-run wizard" }),
    ).not.toBeInTheDocument();
  });

  it("reopens setup on demand after it has been closed", async () => {
    render(<App />);

    await screen.findByRole("dialog", { name: "First-run wizard" });
    fireEvent.click(screen.getByRole("button", { name: "Skip setup for now" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "First-run wizard" }),
      ).not.toBeInTheDocument();
    });

    act(() => {
      requestOnboarding("full");
    });

    expect(
      await screen.findByRole("dialog", { name: "First-run wizard" }),
    ).toHaveTextContent("First-run wizard: full");
  });

  it("still closes onboarding when the record cannot be written", async () => {
    electronMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "record_onboarding_state") {
        throw new Error("sidecar unavailable");
      }
      if (command === "get_settings") {
        return settings;
      }
      return null;
    });

    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "First-run wizard" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete setup" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "First-run wizard" }),
      ).not.toBeInTheDocument();
    });
  });

  it("holds the setup check rather than flashing a workspace whose state is unknown", async () => {
    setReadiness({ settings: null, providers: [], permissions: null, loading: true });

    render(<App />);

    expect(
      await screen.findByRole("status", { name: "Checking first-run setup" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Mock dictation workspace")).not.toBeInTheDocument();
  });

  it("surfaces runtime provider warnings as toasts", async () => {
    setReadiness(readyMac({ completedAt: "2026-06-19T10:04:00Z" }));

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

  it("surfaces the startup vault encryption repair as a toast", async () => {
    // The database is opened before the sidecar can emit anything, so this is
    // the only place the person is told that their database was (or was not)
    // encrypted at launch.
    setReadiness(readyMac({ completedAt: "2026-06-19T10:04:00Z" }));

    render(<App />);
    await screen.findByText("Mock dictation workspace");
    await waitFor(() => {
      expect(electronMocks.listeners["vault-database-encryption-notice"]).toBeDefined();
    });

    act(() => {
      electronMocks.listeners["vault-database-encryption-notice"]({
        payload: { message: "Plainsong finished encrypting its database.", encrypted: true },
      });
    });
    expect(
      await screen.findByText("Plainsong finished encrypting its database."),
    ).toBeInTheDocument();

    act(() => {
      electronMocks.listeners["vault-database-encryption-notice"]({
        payload: { message: "Plainsong could not encrypt its database.", encrypted: false },
      });
    });
    expect(
      await screen.findByText("Plainsong could not encrypt its database."),
    ).toBeInTheDocument();
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
