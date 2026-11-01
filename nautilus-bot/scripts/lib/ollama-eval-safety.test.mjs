import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertEvaluationAdmission, guardedOllamaChat, parseMacResources } from './ollama-eval-safety.mjs';
const installed = { name: 'fixture:latest', size: 512 * 1024 ** 2, digest: 'a'.repeat(64) };
const metadata = { capabilities: ['completion'], model_info: { 'general.parameter_count': 800_000_000, 'general.architecture': 'llama' } };
const resources = { availableBytes: 20 * 1024 ** 3, pressureFreePercent: 60, busy: false };
const body = { messages: [{ role: 'user', content: 'Public fixture.' }] };
async function fixture(run) {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plainsong-eval-safety-test-')));
 const markerPath = path.join(root, 'pending.json');
 try { await run(markerPath); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const options = markerPath => ({ model: installed.name, installed, metadata, body, markerPath, sample: () => resources, pause: async () => {} });
test('large, unknown, remote, busy, low-memory and oversized fixtures are refused', () => {
 for (const [i, m, r, b] of [
  [{ ...installed, size: 13 * 1024 ** 3 }, metadata, resources, body],
  [installed, { ...metadata, model_info: { 'general.parameter_count': 20_000_000_000, 'general.architecture': 'llama' } }, resources, body],
  [{ ...installed, digest: undefined }, metadata, resources, body],
  [installed, { ...metadata, remote_host: 'example.invalid' }, resources, body],
  [installed, {}, resources, body],
  [installed, metadata, { ...resources, busy: true }, body],
  [installed, metadata, { ...resources, availableBytes: 8 * 1024 ** 3 }, body],
  [installed, metadata, { ...resources, pressureFreePercent: 5 }, body],
  [installed, metadata, resources, { messages: [{ content: 'x'.repeat(6000) }] }],
 ]) assert.throws(() => assertEvaluationAdmission(i, m, r, b));
 assert.ok(assertEvaluationAdmission(installed, metadata, resources, body).requiredBytes > 10 * 1024 ** 3);
});
test('macOS sample refuses unknown metrics and identifies native work', () => {
 const vm = 'page size of 16384\nPages free: 100000.\nPages inactive: 100000.\nPages speculative: 100000.';
 assert.equal(parseMacResources(vm, 'free percentage: 50%', '5 /usr/bin/normal').availableBytes, 300000 * 16384);
 assert.equal(parseMacResources(vm, 'free percentage: 50%', '6 /bin/rustc').busy, true);
 assert.throws(() => parseMacResources('unknown', 'free percentage: 50%', ''));
 assert.throws(() => parseMacResources(vm, 'unknown', ''));
});
test('loaded foreign model refuses before dispatch and is never unloaded', () => fixture(async markerPath => {
 const calls = [];
 await assert.rejects(guardedOllamaChat({ ...options(markerPath), request: async route => { calls.push(route); return { models: [{ name: 'foreign' }] }; } }));
 assert.deepEqual(calls, ['/api/ps']);
 await assert.rejects(fs.stat(markerPath), { code: 'ENOENT' });
}));
test('headroom is resampled per request and refusal never dispatches', () => fixture(async markerPath => {
 const calls = []; let samples = 0;
 await assert.rejects(guardedOllamaChat({ ...options(markerPath), sample: () => { samples++; return { ...resources, availableBytes: 1 }; }, request: async route => { calls.push(route); return { models: [] }; } }));
 assert.equal(samples, 1); assert.deepEqual(calls, ['/api/ps']);
 await assert.rejects(fs.stat(markerPath), { code: 'ENOENT' });
}));
test('completed request requests immediate unload and clears marker after residency disappears', () => fixture(async markerPath => {
 let sent;
 const response = await guardedOllamaChat({ ...options(markerPath), body: { ...body, keep_alive: '1h', options: { num_ctx: 1000000, num_predict: 1000000 } }, request: async (route, value) => {
  if (route === '/api/chat') { sent = value; return { done: true, message: { content: 'Public fixture.' } }; }
  assert.equal(route, '/api/ps'); return { models: [] };
 } });
 assert.equal(sent.keep_alive, 0); assert.equal(sent.options.num_ctx, 8192); assert.equal(sent.options.num_predict, 1024);
 assert.equal(response.result.done, true); await assert.rejects(fs.stat(markerPath), { code: 'ENOENT' });
}));
test('timeout retains marker and blocks the next request before any network call', () => fixture(async markerPath => {
 await assert.rejects(guardedOllamaChat({ ...options(markerPath), request: async route => { if (route === '/api/chat') throw new Error('timeout'); return { models: [] }; } }), /timeout/);
 assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).model, installed.name);
 let calls = 0;
 await assert.rejects(guardedOllamaChat({ ...options(markerPath), request: async () => { calls++; } }), { code: 'EEXIST' });
 assert.equal(calls, 0);
}));
test('nonterminal response or persistent residency retains the marker', async () => {
 for (const done of [false, true]) await fixture(async markerPath => {
  let checks = 0;
  await assert.rejects(guardedOllamaChat({ ...options(markerPath), request: async route => {
   if (route === '/api/chat') return { done };
   return { models: checks++ === 0 ? [] : [{ name: installed.name, digest: installed.digest }] };
  } }));
  assert.ok(await fs.stat(markerPath));
 });
});
test('private marker directories and existing markers are mandatory', () => fixture(async markerPath => {
 await fs.chmod(path.dirname(markerPath), 0o755);
 await assert.rejects(guardedOllamaChat({ ...options(markerPath), request: async () => { throw new Error('must not dispatch'); } }), /not private/);
}));

test('new nested marker directories persist before dispatch', () => fixture(async markerPath => {
 const nested = path.join(path.dirname(markerPath), 'new', 'nested', 'pending.json');
 const result = await guardedOllamaChat({ ...options(nested), request: async route => route === '/api/chat' ? { done: true } : { models: [] } });
 assert.equal(result.result.done, true);
 await assert.rejects(fs.stat(nested), { code: 'ENOENT' });
}));
