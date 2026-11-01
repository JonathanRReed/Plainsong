#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAY_MS = 86400000;
const MAX_AGE_MS = 7 * DAY_MS;
const CLOCK_SKEW_MS = 5 * 60000;
const repoRoot = path.resolve(import.meta.dirname, "..");
const publicOrigin = /^https:\/\/github\.com\/RustSec\/advisory-db(?:\.git)?\/?$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface RustAuditDatabase {
  revision: string | null;
  commitTimestamp: string | null;
  origin: string | null;
  trackedClean: boolean;
}

export interface RustAuditProcessResult {
  status: number | null;
  stdout?: string;
  signal?: string | null;
  error?: unknown;
}

export interface RustReleaseAuditReceipt {
  schemaVersion: number;
  generatedAt: string;
  pass: boolean;
  errors: string[];
  database: {
    revision: string | null;
    commitTimestamp: string | null;
    ageDays: number | null;
    maximumAgeDays: number;
    originVerified: boolean;
    trackedClean: boolean;
  };
  audit: {
    status: number | null;
    signal: string | null;
    processError: boolean;
    vulnerabilityCount: number | null;
    vulnerabilities: unknown[];
    informationalWarningCount: number | null;
    informationalWarnings: Record<string, unknown[]>;
  };
}

/** The `cargo audit --json` fields this gate reads. Untrusted until validated below. */
interface CargoAuditReport {
  vulnerabilities?: { count: number; found: boolean; list: unknown[] };
  warnings?: Record<string, unknown[]>;
}

export function evaluateRustReleaseAudit({
  database,
  result,
  now = Date.now(),
}: {
  database: RustAuditDatabase | null;
  result: RustAuditProcessResult;
  now?: number;
}): RustReleaseAuditReceipt {
  const errors: string[] = [];
  // A missing timestamp parses to NaN, which the finiteness check below rejects.
  const timestamp = Date.parse(database?.commitTimestamp as string);
  const ageMs = now - timestamp;
  if (!database || !/^[a-f0-9]{40}$/.test(database.revision ?? "")) errors.push("Advisory database revision is missing or invalid.");
  if (!publicOrigin.test(database?.origin ?? "")) errors.push("Advisory database origin is not the public RustSec repository.");
  if (database?.trackedClean !== true) errors.push("Advisory database tracked files are not clean.");
  if (!Number.isFinite(timestamp)) errors.push("Advisory database timestamp is missing or invalid.");
  else if (ageMs < -CLOCK_SKEW_MS) errors.push("Advisory database timestamp is in the future.");
  else if (ageMs > MAX_AGE_MS) errors.push("Advisory database is older than seven days.");
  let report: CargoAuditReport | null = null;
  try { report = JSON.parse(String(result?.stdout ?? "")) as CargoAuditReport; }
  catch { errors.push("Cargo audit did not return JSON."); }
  const vulnerabilities = report?.vulnerabilities;
  const warnings = report?.warnings;
  const valid = object(report) && object(vulnerabilities) &&
    Number.isInteger(vulnerabilities.count) && vulnerabilities.count >= 0 &&
    Array.isArray(vulnerabilities.list) && vulnerabilities.count === vulnerabilities.list.length &&
    vulnerabilities.list.every((finding) => object(finding) && object(finding.advisory) && typeof finding.advisory.id === "string" && object(finding.package)) &&
    typeof vulnerabilities.found === "boolean" && vulnerabilities.found === (vulnerabilities.count > 0) &&
    object(warnings) && Object.values(warnings).every((entries) => Array.isArray(entries) && entries.every(object));
  if (!valid) errors.push("Cargo audit report is malformed or inconsistent.");
  if (result?.error || result?.signal || !Number.isInteger(result?.status)) errors.push("Cargo audit failed to run or was interrupted.");
  else if (result.status !== 0 && !(result.status === 1 && valid && vulnerabilities!.count > 0)) errors.push("Cargo audit failed without a valid vulnerability report.");
  if (valid && vulnerabilities!.count > 0) errors.push("Cargo audit found vulnerabilities.");
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    pass: errors.length === 0 && result?.status === 0,
    errors,
    database: {
      revision: database?.revision ?? null,
      commitTimestamp: database?.commitTimestamp ?? null,
      ageDays: Number.isFinite(ageMs) ? ageMs / DAY_MS : null,
      maximumAgeDays: 7,
      originVerified: publicOrigin.test(database?.origin ?? ""),
      trackedClean: database?.trackedClean === true,
    },
    audit: {
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      processError: Boolean(result?.error),
      vulnerabilityCount: valid ? vulnerabilities!.count : null,
      vulnerabilities: valid ? vulnerabilities!.list : [],
      informationalWarningCount: valid ? Object.values(warnings!).reduce((count, entries) => count + entries.length, 0) : null,
      informationalWarnings: valid ? warnings! : {},
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--db" || !args[1])) {
    console.error("Usage: bun scripts/verify-rust-release-audit.ts [--db PATH]");
    process.exitCode = 1;
    return;
  }
  const dbPath = path.resolve(args[1] ?? (process.env.PLAINSONG_RUSTSEC_DB || path.join(os.homedir(), ".cargo/advisory-db")));
  const options: SpawnSyncOptionsWithStringEncoding = { cwd: repoRoot, encoding: "utf8", timeout: 45000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", CARGO_NET_OFFLINE: "true" } };
  const git = (args: string[]): string | null => {
    const result = spawnSync("git", ["-C", dbPath, ...args], options);
    return result.status === 0 && !result.error ? String(result.stdout).trim() : null;
  };
  const revision = git(["rev-parse", "HEAD"]);
  const commitTimestamp = git(["log", "-1", "--format=%cI"]);
  const origin = git(["config", "--get", "remote.origin.url"]);
  const trackedStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const database = { revision, commitTimestamp, origin, trackedClean: trackedStatus === "" };
  // Reject invalid database evidence before invoking Cargo. This never refreshes it.
  const preflight = evaluateRustReleaseAudit({ database, result: { status: 0, stdout: JSON.stringify({ vulnerabilities: { count: 0, found: false, list: [] }, warnings: {} }) } });
  const receipt = preflight.pass
    ? evaluateRustReleaseAudit({ database, result: spawnSync("cargo", ["audit", "--json", "--no-fetch", "--db", dbPath, "--file", "rust-sidecar/Cargo.lock"], options) })
    : { ...preflight, audit: null };
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
