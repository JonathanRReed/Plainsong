import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Settings } from "@/types/settings";

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

describe("settings wire contract", () => {
  const source = (() => {
    if (!existsSync(SETTINGS_RS)) {
      throw new Error(
        `Expected the Rust settings schema at ${SETTINGS_RS}. Run vitest from the nautilus-bot package root.`,
      );
    }
    return readFileSync(SETTINGS_RS, "utf8");
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
