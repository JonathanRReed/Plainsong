import fs from "node:fs";
import path from "node:path";
import { aggregateWer, scoreUtterance } from "./lib/asr-wer.ts";

const [manifestPath, corpusPath, ggmlPath, neuralPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !corpusPath || !ggmlPath || !neuralPath || !outputPath) {
  throw new Error("Expected manifest, corpus, ggml JSONL, helper JSONL and output paths");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
const manifest = array(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).map((value) => {
  const row = object(value);
  return { clip: string(row.clip), item: string(row.item), wav: path.resolve(string(row.wav)) };
});
const corpus = object(JSON.parse(fs.readFileSync(corpusPath, "utf8")));
const references = new Map(array(corpus.items).map((value) => {
  const row = object(value);
  return [string(row.id), string(row.spoken)] as const;
}));
function score(file: string) {
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => object(JSON.parse(line)));
  const byWav = new Map(rows.map((row) => [path.resolve(string(row.wav)), row]));
  if (byWav.size !== rows.length) throw new Error("Duplicate WAV results");
  let missing = 0;
  let errors = 0;
  const clips = manifest.map((clip) => {
    const row = byWav.get(clip.wav);
    const reference = references.get(clip.item);
    if (reference === undefined) throw new Error(`No reference for ${clip.item}`);
    if (!row) missing += 1;
    if (row?.error) errors += 1;
    const hypothesis = row && typeof row.transcript === "string" ? row.transcript : "";
    return { clip: clip.clip, ...scoreUtterance(reference, hypothesis) };
  });
  return { missing, errors, scoredClips: clips.length, extraRows: rows.length - manifest.length + missing,
    aggregate: aggregateWer(clips), clips };
}
const result = { scope: "Raw ASR versus spoken words; no text cleanup, destination insertion or speaker score", ggml: score(ggmlPath), neural: score(neuralPath) };
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ggml: result.ggml.aggregate, neural: result.neural.aggregate, errors: [result.ggml.errors, result.neural.errors], missing: [result.ggml.missing, result.neural.missing] }));
