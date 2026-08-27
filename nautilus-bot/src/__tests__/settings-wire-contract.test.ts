import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MeetingCustomTemplate, Settings } from "@/types/settings";

/**
 * The settings bridge is pass-through in both directions: `get_settings` hands
 * the frontend whatever serde serialized, and `save_settings` hands Rust
 * whatever the frontend spread back. Serde ignores keys it does not recognize,
 * so a field renamed on one side and not the other produces no error anywhere
 * — the reader just sees `undefined` and the writer's value is dropped on the
 * floor.
 *
 * That is not hypothetical. `privacy.llmProvider` / `privacy.llmModelId` were
 * split into the `dictationAi` / `meetingsAi` lanes in Rust while every
 * frontend reader and writer kept the old names. Both suites stayed green: the
 * TS mirror is hand-written so `tsc` saw nothing, and the fixtures asserted the
 * old shape. The result was a provider dropdown that saved nothing and a
 * privacy chip that told users their transcripts were leaving the machine when
 * they were not.
 *
 * These tests close that hole from both sides:
 *  - a rename in `src/types/settings.ts` breaks `tsc --noEmit` on the typed
 *    literals below, because they are annotated with the real interfaces;
 *  - a rename in `rust-sidecar/src/settings.rs` breaks the runtime comparison,
 *    because the field names are read out of the Rust source itself.
 */

const SETTINGS_RS = resolve(process.cwd(), "rust-sidecar/src/settings.rs");
const MEETING_TEMPLATES_TS = resolve(process.cwd(), "src/lib/meeting-templates.ts");

/** Field names of a `pub struct`, in declaration order. */
function rustStructFields(source: string, structName: string): string[] {
  const header = `pub struct ${structName} {`;
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`${structName} not found in ${SETTINGS_RS}`);
  }
  const bodyStart = start + header.length;
  const bodyEnd = source.indexOf("\n}", bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`unterminated ${structName} in ${SETTINGS_RS}`);
  }
  return [...source.slice(bodyStart, bodyEnd).matchAll(/^\s*pub (\w+):/gm)].map(
    (match) => match[1],
  );
}

/**
 * Ids of the `BUILTIN_MEETING_TEMPLATE_IDS` array in settings.rs, in
 * declaration order. This is Rust's copy of the id list `meeting-templates.ts`
 * defines authoritatively; the two are read out of source and compared below
 * rather than trusted to stay in sync by hand.
 */
function rustBuiltinMeetingTemplateIds(source: string): string[] {
  const header = "pub(crate) const BUILTIN_MEETING_TEMPLATE_IDS: &[&str] = &[";
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`BUILTIN_MEETING_TEMPLATE_IDS not found in ${SETTINGS_RS}`);
  }
  const bodyStart = start + header.length;
  const bodyEnd = source.indexOf("];", bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`unterminated BUILTIN_MEETING_TEMPLATE_IDS in ${SETTINGS_RS}`);
  }
  return [...source.slice(bodyStart, bodyEnd).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/** `value` ids of the `MEETING_TEMPLATES` array in meeting-templates.ts, in
 * declaration order -- the authoritative built-in id list. */
function tsBuiltinMeetingTemplateIds(source: string): string[] {
  const header = "export const MEETING_TEMPLATES: MeetingTemplateOption[] = [";
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`MEETING_TEMPLATES not found in ${MEETING_TEMPLATES_TS}`);
  }
  const bodyStart = start + header.length;
  const bodyEnd = source.indexOf("\n];", bodyStart);
  if (bodyEnd === -1) {
    throw new Error(`unterminated MEETING_TEMPLATES array in ${MEETING_TEMPLATES_TS}`);
  }
  return [...source.slice(bodyStart, bodyEnd).matchAll(/value:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

const toCamelCase = (field: string): string =>
  field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

// Annotated with the real interfaces on purpose: an added, removed, or renamed
// field on the TypeScript side makes these literals stop type-checking, which
// is the compile-time half of the contract.
const PRIVACY_WIRE_SHAPE: Settings["privacy"] = {
  remoteProcessingEnabled: false,
  dictationAi: { provider: "ollama", modelId: null },
  meetingsAi: { provider: "ollama", modelId: null },
  exportRoot: null,
  exportLocationId: null,
  exportLocationLabel: null,
  exportLocationApproved: false,
  vaultInitialized: false,
  vaultSalt: null,
};

const AI_LANE_WIRE_SHAPE: Settings["privacy"]["dictationAi"] = {
  provider: "ollama",
  modelId: null,
};

// Extended deliberately alongside the new `meeting_custom_templates`
// persistence (audit finding ux-12): this pins the third corner of the same
// three-way contract the two shapes above cover for privacy settings --
// TypeScript catches a renderer-side rename, and the runtime comparison
// below catches a Rust-side one.
const MEETING_CUSTOM_TEMPLATE_WIRE_SHAPE: MeetingCustomTemplate = {
  id: "custom-1",
  name: "Board Update",
  summaryPrompt: "Summarize board sentiment, asks, and follow-ups.",
  notesOutline: ["Sentiment", "Asks"],
};

describe("settings wire contract", () => {
  const source = (() => {
    if (!existsSync(SETTINGS_RS)) {
      throw new Error(
        `Expected the Rust settings schema at ${SETTINGS_RS}. Run vitest from the nautilus-bot package root.`,
      );
    }
    return readFileSync(SETTINGS_RS, "utf8");
  })();

  const meetingTemplatesSource = (() => {
    if (!existsSync(MEETING_TEMPLATES_TS)) {
      throw new Error(
        `Expected ${MEETING_TEMPLATES_TS}. Run vitest from the nautilus-bot package root.`,
      );
    }
    return readFileSync(MEETING_TEMPLATES_TS, "utf8");
  })();

  it("mirrors every PrivacySettings field Rust serializes", () => {
    expect(rustStructFields(source, "PrivacySettings").map(toCamelCase)).toEqual(
      Object.keys(PRIVACY_WIRE_SHAPE),
    );
  });

  it("mirrors every AiLaneSettings field Rust serializes", () => {
    expect(rustStructFields(source, "AiLaneSettings").map(toCamelCase)).toEqual(
      Object.keys(AI_LANE_WIRE_SHAPE),
    );
  });

  it("mirrors every MeetingCustomTemplate field Rust serializes", () => {
    expect(rustStructFields(source, "MeetingCustomTemplate").map(toCamelCase)).toEqual(
      Object.keys(MEETING_CUSTOM_TEMPLATE_WIRE_SHAPE),
    );
  });

  it("keeps the Rust built-in meeting template id list identical to meeting-templates.ts", () => {
    // The two sides resolve a template id in opposite priority order (the
    // renderer's picker looks built-ins up by this exact list; the analysis
    // resolver in lib.rs now checks it first too -- see FIX 5 in the ux-12
    // review). A drift here would let a custom id shadow a built-in on one
    // side while the other still shows the built-in, which is exactly the
    // failure this comparison exists to catch before it ships.
    const tsIds = tsBuiltinMeetingTemplateIds(meetingTemplatesSource);
    expect(tsIds.length).toBeGreaterThan(0);
    expect(rustBuiltinMeetingTemplateIds(source)).toEqual(tsIds);
  });

  it("keeps the retired single-provider keys out of the schema", () => {
    // They live on in REMOVED_SETTINGS_KEYS, which is the migration list that
    // strips them from settings.json — that is the only mention allowed.
    for (const retired of ["llm_provider", "llm_model_id"]) {
      expect(rustStructFields(source, "PrivacySettings")).not.toContain(retired);
    }
    for (const retired of ["llmProvider", "llmModelId"]) {
      expect(Object.keys(PRIVACY_WIRE_SHAPE)).not.toContain(retired);
    }
  });
});
