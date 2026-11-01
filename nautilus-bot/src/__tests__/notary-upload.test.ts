import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Release tooling is plain JavaScript, also run directly by Bun.
import { notarizeArtifact } from "../../scripts/lib/notary-upload.mjs";

const id = "12345678-1234-1234-1234-123456789abc";
const roots: string[] = [];
const result = (value: unknown, status = 0) => ({ stdout: JSON.stringify(value), stderr: "", status });
function fixture(replies: Record<string, ReturnType<typeof result>[]>) {
  const receipts = fs.mkdtempSync(path.join(os.tmpdir(), "notary-test-"));
  roots.push(receipts);
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const run = async (_step: string, args: string[]) => {
    calls.push(args);
    const next = replies[args[0]]?.shift();
    if (!next) throw new Error(`Unexpected fake notarytool call: ${args}`);
    return next;
  };
  return { receipts, calls, sleeps, options: { file: "/tmp/candidate.dmg", binding: "sha256", receipts, run, tries: 2, spacingMs: 600_000, sleep: async (ms: number) => { sleeps.push(ms); } } };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe("notarytool upload and recovery", () => {
  it("retries resets serially, records their IDs and never waits on them", async () => {
    const f = fixture({ history: [result({ history: [] }), result({ history: [{ id, name: "candidate.dmg", createdDate: new Date().toISOString() }] }), result({ history: [{ id }] })], submit: [result({ id }, 1), result({ id: "abcdefab-1234-1234-1234-123456789abc" })], info: [result({ status: "In Progress" }), result({ status: "In Progress" }), result({ status: "Accepted" })], wait: [result({})], log: [result({ ticketContents: [] })] });
    await notarizeArtifact(f.options);
    expect(f.sleeps).toEqual([600_000]);
    expect(f.calls.filter(args => args[0] === "wait")).toEqual([["wait", "abcdefab-1234-1234-1234-123456789abc", "--timeout", "3h"]]);
    expect(f.calls.filter(args => args[0] === "submit").every(args => args.includes("--no-progress") && args.includes("--no-s3-acceleration") && !args.includes("--wait"))).toBe(true);
    const attempts = fs.readdirSync(f.receipts).filter(name => /^attempt-\d+-\d+/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(f.receipts, name), "utf8")));
    expect(attempts[0]).toMatchObject({ id, uploaded: false, status: "In Progress" });
  });

  it("recovers a SIGBUS submission from new history and requires terminal Apple proof", async () => {
    const f = fixture({ history: [result({ history: [] }), result({ history: [{ id, name: "candidate.dmg", createdDate: new Date().toISOString() }] })], submit: [{ stdout: "", stderr: "Bus error: 10", status: 138 }], info: [result({ status: "Accepted" }), result({ status: "Accepted" })], log: [result({ ticketContents: [] })] });
    expect(await notarizeArtifact(f.options)).toBe(id);
    expect(f.calls.some(args => args[0] === "wait")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.receipts, "submission.json"), "utf8"))).toMatchObject({ recovered: true, uploaded: false, id });
  });

  it("rechecks a crashed upload after backoff before uploading again", async () => {
    const f = fixture({ history: [result({ history: [] }), result({ history: [{ id, name: "candidate.dmg", createdDate: new Date().toISOString() }] })], submit: [{ stdout: "", stderr: "SIGBUS", status: 138 }], info: [result({ status: "In Progress" }), result({ status: "Accepted" }), result({ status: "Accepted" })], log: [result({ ticketContents: [] })] });
    await notarizeArtifact(f.options);
    expect(f.calls.filter(args => args[0] === "submit")).toHaveLength(1);
    expect(f.calls.some(args => args[0] === "wait")).toBe(false);
    expect(f.sleeps).toEqual([600_000]);
  });

  it("rejects an exit-zero response without an ID and ignores old or ambiguous history", async () => {
    const f = fixture({ history: [result({ history: [{ id }] }), result({ history: [{ id, name: "candidate.dmg", createdDate: new Date().toISOString() }, { id: "abcdefab-1234-1234-1234-123456789abc", name: "other.dmg", createdDate: new Date().toISOString() }] })], submit: [result({})] });
    await expect(notarizeArtifact({ ...f.options, tries: 1 })).rejects.toThrow("exhausted");
    expect(f.calls.some(args => args[0] === "wait")).toBe(false);
  });

  it("resumes a timed-out clean upload without submitting again", async () => {
    const f = fixture({ history: [result({ history: [] })], submit: [result({ id })], wait: [result({}, 1), result({})], info: [result({ status: "In Progress" }), result({ status: "Accepted" })], log: [result({}, 1), result({ ticketContents: [] })] });
    await expect(notarizeArtifact(f.options)).rejects.toThrow("In Progress");
    await notarizeArtifact(f.options);
    expect(f.calls.filter(args => args[0] === "submit")).toHaveLength(1);
    await expect(notarizeArtifact({ ...f.options, binding: "other" })).rejects.toThrow("different candidate");
  });

  it("fetches rejection logs and never retries a completed rejection", async () => {
    const f = fixture({ history: [result({ history: [] })], submit: [result({ id })], wait: [result({}, 1)], info: [result({ status: "Invalid" })], log: [result({ issues: ["invalid signature"] })] });
    await expect(notarizeArtifact(f.options)).rejects.toThrow("Invalid");
    expect(f.calls.at(-1)).toEqual(["log", id]);
    expect(f.sleeps).toEqual([]);
  });

  it("does not upload when history cannot establish a recovery baseline", async () => {
    const f = fixture({ history: [result({}, 1)] });
    await expect(notarizeArtifact(f.options)).rejects.toThrow("history");
    expect(f.calls).toEqual([["history"]]);
  });
  it("reuses a successful upload when the runner stops before selecting it", async () => {
    const f = fixture({ wait: [result({})], info: [result({ status: "Accepted" })], log: [result({})] });
    fs.writeFileSync(path.join(f.receipts, "attempt-1-1.json"), JSON.stringify({ binding: "sha256", id, uploaded: true, attempt: 1 }));
    await notarizeArtifact(f.options);
    expect(f.calls.some(args => args[0] === "submit")).toBe(false);
  });

  it("journals history before submit and recovers after the runner itself stops", async () => {
    const f = fixture({ history: [result({ history: [] })] });
    await expect(notarizeArtifact({ ...f.options, run: async (step: string, args: string[]) => {
      if (args[0] === "submit") throw new Error("runner interrupted");
      return f.options.run(step, args);
    } })).rejects.toThrow("runner interrupted");
    const recovered = fixture({ history: [result({ history: [{ id, name: "candidate.dmg", createdDate: new Date().toISOString() }] })], info: [result({ status: "Accepted" }), result({ status: "Accepted" })], log: [result({})] });
    await notarizeArtifact({ ...recovered.options, receipts: f.receipts });
    expect(recovered.calls.some(args => args[0] === "submit" || args[0] === "wait")).toBe(false);
  });

  it("stops on ambiguous recovery while retaining every matching ID", async () => {
    const ids = [id, "abcdefab-1234-1234-1234-123456789abc"];
    const f = fixture({ history: [result({ history: [] }), result({ history: ids.map(id => ({ id, name: "candidate.dmg", createdDate: new Date().toISOString() })) })], submit: [result({}, 138)] });
    await expect(notarizeArtifact(f.options)).rejects.toThrow("Ambiguous");
    const attempt = fs.readdirSync(f.receipts).find(name => /^attempt-\d+-\d+\.json$/.test(name));
    expect(JSON.parse(fs.readFileSync(path.join(f.receipts, attempt!), "utf8")).matchingIds).toEqual(ids);
    expect(f.calls.filter(args => args[0] === "submit")).toHaveLength(1);
  });

  it("retains the retry limit across resumes", async () => {
    const f = fixture({ history: [result({ history: [] }), result({ history: [] }), result({ history: [] })], submit: [result({}, 138)] });
    for (let run = 0; run < 2; run++) {
      await expect(notarizeArtifact({ ...f.options, tries: 1 })).rejects.toThrow("exhausted");
    }
    expect(f.calls.filter(args => args[0] === "submit")).toHaveLength(1);
  });

});
