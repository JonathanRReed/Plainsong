import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RememberedVoicesSection } from "@/components/remembered-voices-section";

/**
 * What the app tells you it stores has to be what it stores.
 *
 * The sidecar writes a per-meeting voice signature only for a cluster that has
 * been given a name — see `record_named_cluster_voice_signature` and
 * `store_and_match_cluster_voices` in the Rust side, where the rule and its
 * tests live. The consequence a reader can actually observe is that a meeting
 * reopened after a restart offers no suggestions for speakers nobody named,
 * and that consequence has to be written down. This test pins the three
 * surfaces that say so: the Settings panel, the privacy document, and the
 * known-limitations list.
 */

vi.mock("@/components/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/backend/asr", () => ({
  listRememberedVoices: vi.fn(async () => []),
  forgetRememberedVoice: vi.fn(async () => true),
  forgetAllRememberedVoices: vi.fn(async () => 0),
}));

const docsDir = path.resolve(__dirname, "..", "..", "docs", "beta");
const readDoc = (name: string) => readFileSync(path.join(docsDir, name), "utf8");

/** Whitespace-insensitive, because these are wrapped prose files. */
const flatten = (text: string) => text.replace(/\s+/g, " ");

describe("remembered voices: what the copy promises", () => {
  it("says in Settings that only named speakers are written down", () => {
    render(
      <RememberedVoicesSection
        rememberVoices
        autoApplyConfidentVoices={false}
        onRememberVoicesChange={vi.fn()}
        onAutoApplyChange={vi.fn()}
      />,
    );

    const description = screen.getByText(/Off by default\./);
    expect(description).toHaveTextContent(
      "stores a signature only for speakers you name, or that Plainsong offers to name and you confirm",
    );
    // And the cost of that rule, rather than only its benefit.
    expect(description).toHaveTextContent(
      "everyone else's stays in memory until you quit",
    );

    expect(
      screen.getByText(/Speakers you never name are not written down at all/),
    ).toHaveTextContent(
      "their numbers stay in memory while Plainsong is open, which is why a meeting reopened after a restart offers no suggestions for them",
    );
  });

  it("says in PRIVACY-AND-CLOUD.md what is stored and what is not", () => {
    const privacy = flatten(readDoc("PRIVACY-AND-CLOUD.md"));

    expect(privacy).toContain(
      "A signature is only written for a speaker you name, or one Plainsong offers to name and you confirm",
    );
    // Auto-apply names a speaker without being asked, so it writes one too.
    // Leaving that out would make the sentence above false.
    expect(privacy).toContain(
      'if you turn on "Apply a confident match without asking"',
    );
    expect(privacy).toContain("**What is not stored.**");
    expect(privacy).toContain(
      "they are kept in memory while Plainsong is running and are never written down",
    );
    expect(privacy).toContain("one signature per *named* speaker on each meeting");
    // The old claim, which the storage rule no longer backs.
    expect(privacy).not.toContain(
      "one signature per speaker on each meeting it was matched in",
    );
  });

  it("says in KNOWN-LIMITATIONS.md that suggestions do not survive a restart", () => {
    const limitations = flatten(readDoc("KNOWN-LIMITATIONS.md"));

    expect(limitations).toContain(
      "Suggestions for speakers you never named do not survive quitting Plainsong",
    );
    expect(limitations).toContain(
      "until you run speaker identification again",
    );
    // Attendees rank suggestions; they never decide one.
    expect(limitations).toContain(
      "they only decide which of several suggestions is shown first, never which voice matched",
    );
  });
});
