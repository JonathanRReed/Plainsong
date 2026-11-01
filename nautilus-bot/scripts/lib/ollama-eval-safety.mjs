import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const GIB = 1024 ** 3;
const EVAL_CONTEXT_TOKENS = 8192;
const EVAL_OUTPUT_TOKENS = 1024;
export const EVAL_PENDING_PATH = path.join(os.homedir(), '.cache/plainsong/qa/ollama-eval-pending.json');

export function parseMacResources(vm, pressure, processes) {
  const page = Number(vm.match(/page size of (\d+)/)?.[1]);
  const counts = ['Pages free:', 'Pages inactive:', 'Pages speculative:'].map(label =>
    Number(vm.match(new RegExp(`${label}\\s+(\\d+)`))?.[1]));
  const availableBytes = counts.reduce((sum, count) => sum + count, 0) * page;
  const pressureFreePercent = Number(pressure.match(/free percentage:\s*(\d+)/)?.[1]);
  if (!Number.isSafeInteger(availableBytes) || availableBytes <= 0 || !Number.isFinite(pressureFreePercent) || pressureFreePercent < 0 || pressureFreePercent > 100) {
    throw new Error('Current memory headroom could not be verified');
  }
  const busy = processes.split('\n').some(line =>
    /\/(?:rustc|cargo|plainsong-sidecar|plainsong-cli|llama-server|llama-cli)(?:\s|$)/.test(line)
    || /\b(?:mlx_lm|vllm|ollama runner)\b/.test(line));
  return { availableBytes, pressureFreePercent, busy };
}

export function sampleMacResources() {
  if (process.platform !== 'darwin') throw new Error('This evaluation requires verified macOS resource checks');
  const read = (command, args = []) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Current workload could not be verified');
    return result.stdout;
  };
  return parseMacResources(read('/usr/bin/vm_stat'), read('/usr/bin/memory_pressure', ['-Q']), read('/bin/ps', ['-axo', 'pid,comm,args']));
}

export function assertEvaluationAdmission(installed, metadata, resources, body) {
  const size = installed?.size;
  const parameters = metadata?.model_info?.['general.parameter_count'];
  const architecture = metadata?.model_info?.['general.architecture'];
  if (!/^[a-f0-9]{64}$/.test(installed?.digest ?? '') || !Number.isSafeInteger(size) || size <= 0 || size > GIB
      || !Number.isSafeInteger(parameters) || parameters <= 0 || parameters > 2_000_000_000
      || typeof architecture !== 'string' || !architecture
      || metadata.remote_host || metadata.remote_model
      || !metadata.capabilities?.includes('completion')) {
    throw new Error('Evaluation refused: model is large, remote, or lacks verified local text-model metadata');
  }
  const requiredBytes = 6 * GIB + 3 * size + 2 * GIB + GIB;
  if (!Number.isSafeInteger(resources?.availableBytes) || resources.availableBytes < requiredBytes
      || !Number.isFinite(resources.pressureFreePercent) || resources.pressureFreePercent < 35 || resources.pressureFreePercent > 100 || resources.busy !== false) {
    throw new Error('Evaluation refused: insufficient current headroom or another native workload is active');
  }
  const bytes = Buffer.byteLength(JSON.stringify(body.messages ?? []));
  if (bytes > 5120) throw new Error('Evaluation refused: fixture exceeds the bounded context budget');
  return { availableBytes: resources.availableBytes, requiredBytes, diskBytes: size, parameterCount: parameters };
}

// The marker survives a timeout or process exit. An empty /api/ps response alone
// cannot prove that a delayed request will never load weights, so do not recover
// an uncertain marker automatically or dispatch another evaluation behind it.
export async function guardedOllamaChat({ model, installed, metadata, body, request,
  runtimeEvidence, sample = sampleMacResources, markerPath = EVAL_PENDING_PATH, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const parent = path.dirname(markerPath);
  const firstCreated = await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)
      || await fs.realpath(parent) !== parent) throw new Error('Evaluation marker directory is not private');
  const marker = await fs.open(markerPath, 'wx', 0o600);
  let dispatched = false;
  let released = false;
  try {
    await marker.writeFile(JSON.stringify({ pid: process.pid, model, digest: installed?.digest, runtime: runtimeEvidence, createdAt: new Date().toISOString() }));
    await marker.sync();
    const directoryHandle = await fs.open(parent, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    if (firstCreated) {
      const stop = path.dirname(firstCreated);
      for (let cursor = path.dirname(parent); ; cursor = path.dirname(cursor)) {
        const ancestor = await fs.open(cursor, 'r');
        try { await ancestor.sync(); } finally { await ancestor.close(); }
        if (cursor === stop) break;
        if (path.dirname(cursor) === cursor) throw new Error('Could not persist evaluation marker ancestry');
      }
    }
    const running = await request('/api/ps');
    if (!Array.isArray(running.models) || running.models.length) throw new Error('Evaluation refused: Ollama already has a loaded model');
    const admission = assertEvaluationAdmission(installed, metadata, sample(), body);
    dispatched = true;
    const result = await request('/api/chat', { ...body, model, stream: false, keep_alive: 0,
      options: { ...body.options, num_ctx: EVAL_CONTEXT_TOKENS, num_predict: EVAL_OUTPUT_TOKENS } });
    if (result.done !== true) throw new Error('Evaluation completion is uncertain; pending marker retained');
    // Never send unload commands for shared model names. keep_alive:0 belongs
    // to this request. Confirm that its runner actually disappears afterward.
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await request('/api/ps');
      if (!Array.isArray(state.models)) throw new Error('Ollama residency could not be verified');
      if (!state.models.some(entry => entry.name === model || entry.model === model || entry.digest === installed.digest)) {
        released = true;
        return { result, admission };
      }
      await pause(200);
    }
    throw new Error('Evaluation model is still resident; pending marker retained');
  } finally {
    await marker.close();
    if (!dispatched || released) await fs.unlink(markerPath);
  }
}
