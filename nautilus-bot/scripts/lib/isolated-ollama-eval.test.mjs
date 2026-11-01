import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIsolatedOllamaSession, prepareIsolatedOllamaModelStore } from './isolated-ollama-eval.mjs';

async function makeStore() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plainsong-isolated-store-test-')));
  const modelStore = path.join(root, 'models');
  const manifests = path.join(modelStore, 'manifests', 'registry.ollama.ai', 'library', 'fixture');
  const blobs = path.join(modelStore, 'blobs');
  await fs.mkdir(manifests, { recursive: true });
  await fs.mkdir(blobs);
  const config = Buffer.from('{"model":"fixture"}');
  const layer = Buffer.from('local model bytes');
  const descriptor = (bytes, mediaType) => ({
    mediaType,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length,
  });
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: descriptor(config, 'application/vnd.docker.container.image.v1+json'),
    layers: [descriptor(layer, 'application/vnd.ollama.image.model')],
  }));
  for (const bytes of [config, layer]) {
    const hex = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(blobs, `sha256-${hex}`), bytes);
  }
  await fs.writeFile(path.join(manifests, 'latest'), manifest);
  return {
    root,
    modelStore,
    manifest,
    installed: { name: 'fixture:latest', size: layer.length, digest: createHash('sha256').update(manifest).digest('hex') },
  };
}

test('captures one digest-matched manifest and clones verified local blobs', async () => {
  const fixture = await makeStore();
  let prepared;
  try {
    prepared = await prepareIsolatedOllamaModelStore(fixture);
    assert.equal(prepared.model, 'plainsong-eval:fixture');
    assert.equal(prepared.originalManifestSha256, fixture.installed.digest);
    const captured = path.join(prepared.modelStoreRoot, 'manifests', 'registry.ollama.ai', 'library', 'plainsong-eval', 'fixture');
    assert.deepEqual(await fs.readFile(captured), fixture.manifest);
    const aliases = await fs.readdir(path.join(prepared.modelStoreRoot, 'blobs'));
    assert.equal(aliases.length, 2);
    for (const alias of aliases) {
      const source = path.join(fixture.modelStore, 'blobs', alias);
      const snapshot = path.join(prepared.modelStoreRoot, 'blobs', alias);
      const [sourceInfo, snapshotInfo] = await Promise.all([fs.stat(source), fs.lstat(snapshot)]);
      assert.equal(snapshotInfo.isFile(), true);
      assert.equal(snapshotInfo.isSymbolicLink(), false);
      assert.equal(snapshotInfo.mode & 0o777, 0o400);
      assert.notEqual(snapshotInfo.ino, sourceInfo.ino);
      const capturedBytes = await fs.readFile(snapshot);
      await fs.writeFile(source, Buffer.alloc(sourceInfo.size, 2));
      assert.deepEqual(await fs.readFile(snapshot), capturedBytes);
    }
    assert.equal((await fs.lstat(prepared.privateRoot)).mode & 0o077, 0);
  } finally {
    await prepared?.cleanup();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a symlink manifest and a blob that fails its digest', async () => {
  const linked = await makeStore();
  try {
    const manifestPath = path.join(linked.modelStore, 'manifests', 'registry.ollama.ai', 'library', 'fixture', 'latest');
    await fs.rename(manifestPath, `${manifestPath}.source`);
    await fs.symlink(`${manifestPath}.source`, manifestPath);
    await assert.rejects(prepareIsolatedOllamaModelStore(linked), /symbolic link/);
  } finally {
    await fs.rm(linked.root, { recursive: true, force: true });
  }

  const corrupt = await makeStore();
  try {
    const [blob] = await fs.readdir(path.join(corrupt.modelStore, 'blobs'));
    const blobPath = path.join(corrupt.modelStore, 'blobs', blob);
    const bytes = await fs.readFile(blobPath);
    await fs.writeFile(blobPath, Buffer.alloc(bytes.length, 1));
    await assert.rejects(prepareIsolatedOllamaModelStore(corrupt), /integrity verification/);
  } finally {
    await fs.rm(corrupt.root, { recursive: true, force: true });
  }
});

async function isolatedRoots() {
  return new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('plainsong-ollama-eval-')));
}

test('starts and reaps an owned mock listener, then removes its private profile', async () => {
  const fixture = await makeStore();
  const mock = path.join(fixture.root, 'mock-ollama');
  await fs.writeFile(mock, `#!${process.execPath}\n`
    + `const http = require('node:http');\n`
    + `const fs = require('node:fs');\n`
    + `const address = process.env.OLLAMA_HOST.split(':');\n`
    + `fs.writeFileSync(process.env.HOME + '/pid', String(process.pid));\n`
    + `http.createServer((request, response) => {\n`
    + `  if (request.url === '/api/version') { response.setHeader('content-type', 'application/json'); response.end('{"version":"mock"}'); return; }\n`
    + `  response.statusCode = 404; response.end();\n`
    + `}).listen(Number(address[1]), address[0]);\n`, { mode: 0o755 });
  let session;
  try {
    session = await createIsolatedOllamaSession({ ...fixture, binary: mock });
    assert.equal(await session.assertOwnership(), true);
    const privateRoot = path.dirname(session.modelStoreRoot);
    const pid = Number(await fs.readFile(path.join(privateRoot, 'home', 'pid'), 'utf8'));
    assert.ok(pid > 0);
    await session.close();
    await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(session.assertOwnership(), /closed/);
  } finally {
    await session?.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('spawn failure removes the prepared private profile', async () => {
  const fixture = await makeStore();
  const before = await isolatedRoots();
  try {
    await assert.rejects(createIsolatedOllamaSession({
      ...fixture,
      binary: path.join(fixture.root, 'does-not-exist'),
    }), { code: 'ENOENT' });
    const after = await isolatedRoots();
    assert.deepEqual(after, before);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
