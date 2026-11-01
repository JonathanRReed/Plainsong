import { describe, expect, it } from "vitest";
import {
  resolveMeetingNotesRoute,
  type MeetingNotesRouteFacts,
} from "@/features/readiness/meeting-notes-route";

function facts(
  overrides: Partial<MeetingNotesRouteFacts> = {},
): MeetingNotesRouteFacts {
  return {
    optedOut: false,
    provider: "ollama",
    remoteProcessingEnabled: false,
    localRuntimeReady: true,
    localModelReady: true,
    localModelId: "qwen3.5:4b",
    localExecutionReady: true,
    credentialPresent: null,
    ...overrides,
  };
}

describe("meeting notes route", () => {
  it("does not override a persistent pause with installed Ollama inventory", () => {
    expect(resolveMeetingNotesRoute(facts({ localExecutionReady: false, localExecutionMessage: "Local processing is paused." }))).toEqual({ state: "unconfigured", reason: "Local processing is paused." });
  });
  it("is ready when the local analysis runtime answers", () => {
    expect(resolveMeetingNotesRoute(facts())).toEqual({
      state: "ready",
      reason: null,
    });
  });

  it("reports the default install honestly when Ollama is absent", () => {
    // The finding: a default install points the meetings lane at an Ollama that
    // was never installed, and the first meeting's summary, action items and
    // title all failed with nothing on screen.
    const assessment = resolveMeetingNotesRoute(
      facts({ localRuntimeReady: false }),
    );

    expect(assessment.state).toBe("unconfigured");
    expect(assessment.reason).toBe("Ollama on this machine is not running.");
  });

  it("separates a missing selected model from a stopped runtime", () => {
    expect(
      resolveMeetingNotesRoute(facts({ localModelReady: false })),
    ).toEqual({
      state: "unconfigured",
      reason: "qwen3.5:4b is not installed and ready for meeting notes.",
    });
    expect(
      resolveMeetingNotesRoute(facts({ localModelReady: null })).state,
    ).toBe("unknown");
  });

  it("rejects cleanup-only providers for meeting notes", () => {
    expect(
      resolveMeetingNotesRoute(
        facts({ provider: "bundled_local", localRuntimeReady: true }),
      ),
    ).toMatchObject({ state: "unconfigured" });
  });

  it("does not turn an unanswered probe into a verdict", () => {
    expect(
      resolveMeetingNotesRoute(facts({ localRuntimeReady: null })).state,
    ).toBe("unknown");
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "openai",
          remoteProcessingEnabled: true,
          credentialPresent: null,
        }),
      ).state,
    ).toBe("unknown");
  });

  it("names the cloud blockers separately", () => {
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "openai",
          remoteProcessingEnabled: false,
          credentialPresent: true,
        }),
      ),
    ).toEqual({
      state: "unconfigured",
      reason: "cloud AI is turned off, so OpenAI cannot write them.",
    });
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "openai",
          remoteProcessingEnabled: true,
          credentialPresent: false,
        }),
      ),
    ).toEqual({
      state: "unconfigured",
      reason: "no API key is stored for OpenAI.",
    });
  });

  it("is ready for a cloud lane with a key and cloud AI allowed", () => {
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "anthropic",
          remoteProcessingEnabled: true,
          credentialPresent: true,
        }),
      ).state,
    ).toBe("ready");
  });

  it("uses ChatGPT account state instead of API-key wording", () => {
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "chatgpt_plan",
          remoteProcessingEnabled: true,
          credentialPresent: false,
          accountRoute: "check_account",
        }),
      ),
    ).toEqual({
      state: "unknown",
      reason: "Check the saved ChatGPT account in Models.",
    });
    expect(
      resolveMeetingNotesRoute(
        facts({
          provider: "chatgpt_plan",
          remoteProcessingEnabled: true,
          accountRoute: "choose_model",
        }),
      ).reason,
    ).toBe("choose an available ChatGPT model in Models.");
  });

  it("remembers a transcripts-only choice ahead of every probe", () => {
    const assessment = resolveMeetingNotesRoute(
      facts({ optedOut: true, provider: null, localRuntimeReady: false }),
    );

    expect(assessment.state).toBe("opted_out");
    expect(assessment.reason).toContain("transcripts only");
  });

  it("treats unloaded settings as unknown rather than unconfigured", () => {
    expect(resolveMeetingNotesRoute(facts({ provider: null })).state).toBe(
      "unknown",
    );
  });
});
