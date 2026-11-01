#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { collectReleaseCandidateIdentity } from "../lib/release-candidate-identity.ts";
import { completeReview, parseReviewKind, reviewTemplate } from "../lib/release-review-receipt.ts";

const args = process.argv.slice(2);
function value(flag: string) {
  const index = args.indexOf(flag);
  const result = args[index + 1];
  if (index < 0 || !result || result.startsWith("--")) throw new Error(`Missing ${flag}`);
  return result;
}
if (args.includes("--begin") === args.includes("--finish")) throw new Error("Select exactly one of --begin or --finish");
const kind = parseReviewKind(value("--kind"));
const qa = path.resolve(value("--qa-dir"));
const candidatePath = path.resolve(value("--candidate"));
const candidateIdentity = collectReleaseCandidateIdentity({ candidatePath, appPath: path.join(candidatePath, "mac-arm64/Plainsong.app") });
const inputPath = path.join(qa, `${kind}.observations.json`);
const filenames = { "rendered-first-run": "rendered-ux.json", "clean-install": "clean-install.json", "release-code-review": "code-review.json", "meeting-lifecycle-real-device": "meeting-lifecycle-real-device.json" };
let sourceIdentity: unknown = null;
if (kind === "release-code-review") {
  const gates: unknown = JSON.parse(fs.readFileSync(path.join(qa, "source-gates.json"), "utf8"));
  if (!gates || typeof gates !== "object" || !("sourceIdentity" in gates) || !("pass" in gates) || gates.pass !== true) {
    throw new Error("Passing source-gates receipt required before code review");
  }
  sourceIdentity = gates.sourceIdentity;
}
const out = args.includes("--begin") ? inputPath : path.join(qa, filenames[kind]);
if (fs.existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
const receipt = args.includes("--begin") ? reviewTemplate(kind, candidateIdentity, sourceIdentity) : completeReview({
  input: JSON.parse(fs.readFileSync(inputPath, "utf8")), kind, candidateIdentity, sourceIdentity, baseDir: qa,
});
fs.mkdirSync(qa, { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(out);
if ("pass" in receipt && !receipt.pass) process.exitCode = 1;
