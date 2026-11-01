import scopeFile from "../../release-scope-exceptions.json";

interface DecisionRecord {
  decision: string;
  decidedBy: "Jonathan";
  reason: string;
}

export type PartialScopeDecision = DecisionRecord & { date: "2026-10-31" } & (
  | { requirement: "memory-footprint"; scope: { tier: "8gb"; state: "idle-after-dictation" } }
  | { requirement: "host-matrix"; scope: { target: "Google Docs (Chrome)" } }
  | { requirement: "clean-install"; scope: { journey: "clean-account-first-run" } }
);

export type ScopeDecision = PartialScopeDecision | (DecisionRecord & {
  requirement: "signed-updater" | "audible-benchmark";
  date: "2026-10-30";
  scope?: never;
});

const recordedDecisions: readonly ScopeDecision[] = [
  {
    "requirement": "signed-updater",
    "decision": "beta.5→beta.7 updater journey: skipped by Jonathan 2026-10-30",
    "decidedBy": "Jonathan",
    "date": "2026-10-30",
    "reason": "if it breaks they can reload it"
  },
  {
    "requirement": "audible-benchmark",
    "decision": "audible benchmark: skipped for beta.7 by Jonathan 2026-10-30",
    "decidedBy": "Jonathan",
    "date": "2026-10-30",
    "reason": "b23 measurement stands"
  },
  {
    "requirement": "memory-footprint",
    "scope": {
      "tier": "8gb",
      "state": "idle-after-dictation"
    },
    "decision": "Accept 8 GB window-open idle after dictation for beta.7; fix in beta.8",
    "decidedBy": "Jonathan",
    "date": "2026-10-31",
    "reason": "Average is at the 300 MiB limit with the speech model kept warm and the main window open; brief graphics peaks to 534 MiB; window closed is about 200 MiB."
  },
  {
    "requirement": "host-matrix",
    "scope": {
      "target": "Google Docs (Chrome)"
    },
    "decision": "Skip Google Docs typing for beta.7",
    "decidedBy": "Jonathan",
    "date": "2026-10-31",
    "reason": "Chrome has no QA connection on this Mac; Notes, Slack and Messages pass."
  },
  {
    "requirement": "clean-install",
    "scope": {
      "journey": "clean-account-first-run"
    },
    "decision": "Skip fresh-account install journey for beta.7",
    "decidedBy": "Jonathan",
    "date": "2026-10-31",
    "reason": "Needs a new macOS user account; quarantined DMG install, signatures and Gatekeeper pass."
  }
];

// Compare every key, including nested scope keys. Extra fields cannot widen a decision.
function exactFields(input: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return input === expected;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const actual = Object.fromEntries(Object.entries(input));
  const entries = Object.entries(expected);
  return Object.keys(actual).length === entries.length &&
    entries.every(([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && exactFields(actual[key], value));
}

export function matchesScopeDecision(input: unknown, decision: ScopeDecision): boolean {
  return exactFields(input, decision);
}

export function parseScopeDecisions(input: unknown, version: string | null): ScopeDecision[] {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !("schemaVersion" in input) || input.schemaVersion !== 1 ||
    !("version" in input) || input.version !== "0.9.0-beta.7" ||
    !("decisions" in input) || !Array.isArray(input.decisions)) {
    throw new Error("Invalid beta.7 scope decisions");
  }
  const decisions: ScopeDecision[] = [];
  const rows: unknown[] = input.decisions;
  for (const row of rows) {
    const decision = recordedDecisions.find((recorded) => matchesScopeDecision(row, recorded));
    if (!decision || decisions.some((existing) => existing.requirement === decision.requirement)) {
      throw new Error("Only Jonathan's five exact recorded beta.7 scope decisions are permitted");
    }
    decisions.push(structuredClone(decision));
  }
  return version === input.version ? decisions : [];
}

export function releaseScopeDecisions(version: string | null): ScopeDecision[] {
  return parseScopeDecisions(scopeFile, version);
}
