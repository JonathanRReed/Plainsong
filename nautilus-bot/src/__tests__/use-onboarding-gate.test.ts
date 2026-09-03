import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the mechanism behind the reported bug: the first-run wizard never
 * appearing.
 *
 * Two things have to stay true for `useOnboardingGate` to hold the splash
 * correctly instead of flashing a setup wizard at someone who is already set
 * up:
 *
 * 1. `READINESS_PATIENCE_MS` (how long the splash waits for a full readiness
 *    answer) must stay longer than the IPC timeout on `get_settings`
 *    (electron/ipc-command-policy.ts). Otherwise a slow-but-successful
 *    settings read races the patience timer, loses, and the gate decides
 *    "show" before evidence that would have said "skip" ever arrives. An
 *    earlier 6-second value did exactly this on a busy Mac -- see
 *    `src/features/onboarding/use-onboarding-gate.ts`.
 * 2. The patience timer itself has to work: it must not fire early, and it
 *    must eventually fire so a launch that never gets an answer still
 *    produces a screen.
 *
 * Both were previously proven only by a packaged-app run
 * (`scripts/capture-packaged-macos-onboarding-first-run.mjs`). This file
 * proves them in-process so a future change to either constant, or to the
 * timer wiring, fails fast in `bunx vitest run` instead of only on a packaged
 * capture.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read `FAST_COMMAND_TIMEOUT_MS` straight out of the Electron main-process
 * source rather than hardcoding 15000, so this assertion still fails if
 * someone changes that value without touching this file.
 */
function readFastCommandTimeoutMs(): number {
  const source = readFileSync(
    path.join(repoRoot, "electron", "ipc-command-policy.ts"),
    "utf8",
  );
  const match = source.match(/FAST_COMMAND_TIMEOUT_MS\s*=\s*([\d_]+)/);
  if (!match) {
    throw new Error(
      "Could not find FAST_COMMAND_TIMEOUT_MS in electron/ipc-command-policy.ts -- " +
        "update the regex in this test if the constant moved or was renamed.",
    );
  }
  return Number(match[1].replace(/_/g, ""));
}

const readinessContext = vi.hoisted(() => ({
  loading: true,
  error: null as string | null,
  settings: null as unknown,
  providers: [] as unknown[],
  permissions: null as unknown,
  dictationRoute: { ready: null as boolean | null },
}));

const backendMocks = vi.hoisted(() => ({
  recordOnboardingState: vi.fn(async () => ({})),
}));

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

vi.mock("@/lib/backend/settings", () => ({
  recordOnboardingState: backendMocks.recordOnboardingState,
}));

describe("READINESS_PATIENCE_MS vs. the fast IPC timeout", () => {
  it("stays longer than get_settings' IPC timeout, so the two cannot drift apart silently", async () => {
    const { READINESS_PATIENCE_MS } = await import(
      "@/features/onboarding/use-onboarding-gate"
    );
    const fastCommandTimeoutMs = readFastCommandTimeoutMs();

    // This is the whole bug: a patience window shorter than (or too close to)
    // the settings-read timeout lets a slow-but-successful read lose the
    // race, so the gate decides "show" before the real answer arrives.
    expect(READINESS_PATIENCE_MS).toBeGreaterThan(fastCommandTimeoutMs);
  });
});

describe("useOnboardingGate readiness patience window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readinessContext.loading = true;
    readinessContext.error = null;
    readinessContext.settings = null;
    readinessContext.providers = [];
    readinessContext.permissions = null;
    readinessContext.dictationRoute = { ready: null };
    backendMocks.recordOnboardingState.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not decide to show the wizard when settings resolve inside the patience window (18s)", async () => {
    const { useOnboardingGate } = await import(
      "@/features/onboarding/use-onboarding-gate"
    );
    const { result, rerender } = renderHook(() => useOnboardingGate());

    expect(result.current.decision.action).toBe("wait");

    // Settings answer late -- past the 15s FAST_COMMAND_TIMEOUT_MS a failed
    // read would have surfaced by, but still inside the 20s patience window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(18_000);
    });

    readinessContext.loading = false;
    readinessContext.settings = {
      onboarding: {
        completedAt: "2026-06-19T10:04:00Z",
        completedVersion: "0.9.0-beta.1",
      },
      transcription: { dictationInsertionMode: "auto" },
    };
    readinessContext.providers = [{ providerType: "distil_whisper" }];
    readinessContext.permissions = {
      microphonePermissionReady: true,
      cursorInsertionReady: true,
    };
    readinessContext.dictationRoute = { ready: true };
    rerender();

    // The Mac is genuinely set up and ready. A slow-but-successful read must
    // never be read as "show the wizard".
    expect(result.current.decision.action).not.toBe("show");
    expect(result.current.decision.action).toBe("skip");

    // The patience timer is still pending (fires at 20s); once it does, it
    // must not retroactively flip a decision that already has its answer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.decision.action).toBe("skip");
  });

  it("flips to the evidence-timed-out path only once the patience window actually elapses (20s)", async () => {
    const { useOnboardingGate, READINESS_PATIENCE_MS } = await import(
      "@/features/onboarding/use-onboarding-gate"
    );
    const { result } = renderHook(() => useOnboardingGate());

    expect(result.current.decision.action).toBe("wait");

    // Settings never resolve. Just short of the patience window, the gate
    // must still be holding the splash rather than guessing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READINESS_PATIENCE_MS - 1);
    });
    expect(result.current.decision.action).toBe("wait");

    // Past the window with still no answer: it has to decide rather than
    // hold the splash forever, which is what a dead/slow sidecar needs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.decision.action).toBe("show");
  });
});
