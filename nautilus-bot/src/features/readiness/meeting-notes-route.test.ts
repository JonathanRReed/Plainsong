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
    credentialPresent: null,
    ...overrides,
  };
}

describe("meeting notes route", () => {
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
