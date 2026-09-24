#!/usr/bin/env node
/**
 * Print the immutable pin for a Hugging Face file: the repo commit, the LFS
 * SHA-256 and the byte size, which is what every model spec in the sidecar
 * needs (`hf_revision`, `sha256`, `size_bytes`).
 *
 *   node scripts/pin-hf-artifact.mjs handy-computer/Qwen3-ASR-1.7B-gguf Qwen3-ASR-1.7B-Q8_0.gguf
 *   node scripts/pin-hf-artifact.mjs altunenes/parakeet-rs nemotron-3-diarization/nemotron3_diar_v3.onnx
 *
 * Optional third argument: a revision (branch or commit) to pin instead of main.
 * The SHA-256 comes from Hugging Face's LFS metadata; the download manager
 * re-hashes the bytes it receives and rejects any mismatch, so a wrong pin
 * fails closed.
 */

const [repo, filePath, revision = "main"] = process.argv.slice(2);
if (!repo || !filePath) {
  console.error("Usage: node scripts/pin-hf-artifact.mjs <owner/repo> <path/in/repo> [revision]");
  process.exit(2);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return response.json();
}

try {
  const info = await getJson(
    `https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}`,
  );
  const commit = info.sha;
  const directory = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const tree = await getJson(
    `https://huggingface.co/api/models/${repo}/tree/${commit}/${directory}`,
  );
  const entry = tree.find((item) => item.path === filePath);
  if (!entry) {
    throw new Error(`${filePath} not found in ${repo}@${commit}`);
  }
  if (!entry.lfs?.oid) {
    throw new Error(`${filePath} is not an LFS file; hash it after download instead`);
  }
  const license = info.cardData?.license ?? null;
  console.log(
    JSON.stringify(
      {
        repo,
        file: filePath,
        revision: commit,
        sha256: entry.lfs.oid,
        sizeBytes: entry.lfs.size ?? entry.size,
        license,
        url: `https://huggingface.co/${repo}/resolve/${commit}/${filePath}`,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
