import { footprintReceiptQualifies, type FootprintReceiptLike } from "./footprint-gate.ts";
import { reviewChecks } from "./release-review-receipt.ts";
import type { PartialScopeDecision } from "./release-scope-exceptions.ts";

interface ScopedReceipt extends FootprintReceiptLike {
  summary?: { required?: number; requiredLaunchReady?: number };
  rows?: Array<{
    platform?: string;
    app?: string;
    requiredForLaunch?: boolean;
    launchReady?: boolean;
    launchGateSatisfied?: boolean;
    insertionEvidence?: { valid?: boolean };
    openBlockedEntries?: unknown[];
  }>;
  kind?: string;
  reviewMethod?: string;
  observations?: Array<{ id?: string; status?: string }>;
  remainingLaunchFindings?: unknown[];
}

// This is b27's recorded finding for the excluded journey. Free-form findings
// have no scope metadata, so any other finding must still block the audit.
const cleanAccountFinding = "A clean-account installation and first-run permission journey, including dictation and insertion, remains unqualified. Existing account grants were preserved.";

export function partialScopeReceiptQualifies(receipt: ScopedReceipt | null, decision: PartialScopeDecision): boolean {
  if (!receipt || receipt.error != null) return false;
  switch (decision.requirement) {
    case "memory-footprint":
      return footprintReceiptQualifies(receipt, 8, "light", decision.scope.state);
    case "host-matrix": {
      if (!Array.isArray(receipt.rows)) return false;
      const required = receipt.rows.filter((row) => row.requiredForLaunch === true);
      // The existing producer requires these four hosts. Missing rows cannot
      // turn into exclusions, and any additional required host must also pass.
      const hosts = ["Apple Notes", "Google Docs (Chrome)", "Slack", "Messages"];
      return required.length === receipt.summary?.required &&
        hosts.every((app) => required.filter((row) => row.platform === "macOS" && row.app === app).length === 1) &&
        new Set(required.map((row) => `${row.platform}:${row.app}`)).size === required.length &&
        receipt.summary?.requiredLaunchReady === required.filter((row) => row.launchReady === true).length &&
        required.every((row) => (row.platform === "macOS" && row.app === decision.scope.target) ||
          (row.launchReady === true && row.launchGateSatisfied === true &&
            row.insertionEvidence?.valid === true && Array.isArray(row.openBlockedEntries) && row.openBlockedEntries.length === 0));
    }
    case "clean-install": {
      if (receipt.kind !== "clean-install" || receipt.reviewMethod !== "recorded-walkthrough" ||
        !Array.isArray(receipt.observations) || !Array.isArray(receipt.remainingLaunchFindings)) return false;
      const observations = receipt.observations;
      const excluded = ["first-run-permission-flow", "local-dictation-and-meeting"];
      return observations.length === reviewChecks["clean-install"].length &&
        reviewChecks["clean-install"].every((id) => observations.filter((row) => row.id === id).length === 1) &&
        observations.every((row) => excluded.includes(row.id ?? "") || row.status === "pass") &&
        receipt.remainingLaunchFindings.every((finding) => finding === cleanAccountFinding);
    }
  }
}
