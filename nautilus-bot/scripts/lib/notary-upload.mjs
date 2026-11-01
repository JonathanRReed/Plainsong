import fs from "node:fs";
import path from "node:path";

const submissionId = value =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const terminal = status => ["Accepted", "Invalid", "Rejected"].includes(status);
function parse(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Failed uploads can leave permanent In Progress records. Never wait on those.
export async function notarizeArtifact({
  file, binding, receipts, run,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  tries = 6, spacingMs = 600_000, waitTimeout = "3h",
}) {
  if (!Number.isInteger(tries) || tries < 1 || !Number.isFinite(spacingMs) || spacingMs < 0) {
    throw new Error("Invalid notarization retry settings");
  }
  fs.mkdirSync(receipts, { recursive: true });
  const statePath = path.join(receipts, "submission.json");
  const save = (file, value) => {
    const staging = `${file}.partial`;
    const fd = fs.openSync(staging, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(staging, file);
  };
  const attempts = fs.readdirSync(receipts)
    .filter(name => /^attempt-\d+-\d+\.json$/.test(name))
    .map(name => ({ path: path.join(receipts, name), record: JSON.parse(fs.readFileSync(path.join(receipts, name), "utf8")) }))
    .sort((a, b) => a.record.attempt - b.record.attempt);
  if (attempts.some(({ record }) => record.binding !== binding)) {
    throw new Error("Upload attempts belong to different candidate bytes");
  }
  const recover = async entry => {
    const record = entry.record;
    if (!submissionId(record.id) && Array.isArray(record.knownIds)) {
      const after = await run(`attempt-${record.attempt}-history-after`, ["history"]);
      const history = parse(after.stdout).history;
      if (after.status !== 0 || !Array.isArray(history)) {
        throw new Error("Cannot recover interrupted upload history; resume before uploading again");
      }
      const matches = history.filter(item =>
        submissionId(item?.id) && !record.knownIds.includes(item.id) &&
        item.name === path.basename(file) &&
        Date.parse(item.createdDate) >= Date.parse(record.startedAt) - 10_000 &&
        Date.parse(item.createdDate) <= Date.parse(record.endedAt ?? new Date().toISOString()) + 10_000);
      record.matchingIds = matches.map(item => item.id);
      if (matches.length === 1) {
        record.id = matches[0].id;
        record.recovered = true;
      }
      save(entry.path, record);
      if (matches.length > 1) throw new Error("Ambiguous notarization history; inspect the recorded IDs before resuming");
    }
    if (submissionId(record.id)) {
      const info = await run(`attempt-${record.attempt}-recovery-info`, ["info", record.id]);
      if (info.status === 0) record.status = parse(info.stdout).status;
      save(entry.path, record);
    }
    return terminal(record.status);
  };
  let selected;
  if (fs.existsSync(statePath)) {
    selected = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (selected.binding !== binding || !submissionId(selected.id)) {
      throw new Error("Submission belongs to different candidate bytes");
    }
  } else {
    for (;;) {
      // A clean upload may have completed just before the runner was killed.
      // Reuse its durable receipt even if submission.json was never written.
      for (const entry of attempts) {
        if ((entry.record.uploaded && submissionId(entry.record.id)) || await recover(entry)) {
          selected = entry.record;
          break;
        }
      }
      if (selected) {
        save(statePath, selected);
        break;
      }
      const attempt = (attempts.at(-1)?.record.attempt ?? 0) + 1;
      if (attempt > tries) break;
      const before = await run(`attempt-${attempt}-history-before`, ["history"]);
      const previous = parse(before.stdout).history;
      if (before.status !== 0 || !Array.isArray(previous)) {
        throw new Error("Cannot read notarization history before upload");
      }
      const started = Date.now();
      const record = {
        attempt, startedAt: new Date(started).toISOString(),
        knownIds: previous.map(entry => entry?.id).filter(submissionId),
        id: null, matchingIds: [], recovered: false, uploaded: false, status: null, binding,
      };
      const entry = { path: path.join(receipts, `attempt-${attempt}-${started}.json`), record };
      // Save the recovery baseline BEFORE the upload, including when this
      // process is killed before it can save notarytool's response.
      save(entry.path, record);
      const result = await run(`attempt-${attempt}-submit`, [
        "submit", file, "--no-s3-acceleration", "--no-progress",
      ]);
      const id = parse(result.stdout).id;
      Object.assign(record, {
        endedAt: new Date().toISOString(),
        id: submissionId(id) ? id : null,
        uploaded: result.status === 0 && !result.error && submissionId(id),
      });
      save(entry.path, record);
      attempts.push(entry);
      if (record.uploaded || await recover(entry)) {
        selected = record;
        save(statePath, selected);
        break;
      }
      if (attempt >= tries) break;
      await sleep(spacingMs);
    }
  }
  if (!selected) {
    throw new Error("Notarization uploads exhausted; interrupted submission IDs were recorded and were not waited on");
  }
  if (!terminal(selected.status)) {
    await run("wait", ["wait", selected.id, "--timeout", waitTimeout]);
  }
  const info = await run("info", ["info", selected.id]);
  const status = parse(info.stdout).status;
  const log = await run("log", ["log", selected.id]);
  if (info.status !== 0 || status !== "Accepted") {
    throw new Error(`Notarization ${selected.id}: ${status ?? "unknown"}; resume this candidate, do not rebuild`);
  }
  if (log.status !== 0) throw new Error("Could not retrieve accepted notarization log");
  return selected.id;
}
