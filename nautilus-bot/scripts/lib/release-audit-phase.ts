import { matchesScopeDecision, releaseScopeDecisions } from "./release-scope-exceptions.ts";

export function prePublicationAuditProvesRequirements(receipt: unknown, requiredIds: readonly string[]): boolean {
  if (!receipt || typeof receipt !== "object" ||
    !("schemaVersion" in receipt) || receipt.schemaVersion !== 2 ||
    !("phase" in receipt) || receipt.phase !== "pre" ||
    !("pass" in receipt) || receipt.pass !== true ||
    !("publicationReady" in receipt) || receipt.publicationReady !== true ||
    !("requirements" in receipt) || !Array.isArray(receipt.requirements)) return false;
  const rows: unknown[] = receipt.requirements;
  const version = "version" in receipt && typeof receipt.version === "string" ? receipt.version : null;
  const decisions = releaseScopeDecisions(version);
  return rows.length === requiredIds.length && requiredIds.every((id) => rows.some((row) =>
    row !== null && typeof row === "object" &&
    "id" in row && row.id === id && "status" in row && (
      row.status === "proved" || ((row.status === "excluded by decision" || row.status === "proved with scoped exclusion") &&
        "scopeDecision" in row && decisions.some((decision) =>
          decision.requirement === id &&
          (decision.scope ? row.status === "proved with scoped exclusion" : row.status === "excluded by decision") &&
          matchesScopeDecision(row.scopeDecision, decision)))
    ),
  ));
}
