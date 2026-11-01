import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const HEX_64 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 4096;
const MAX_MODEL_BYTES = 1024 ** 3;
const MAX_DESCRIPTOR_OVERHEAD = 1024 * 1024;
const MODEL = 'plainsong-eval:fixture';
const execFileAsync = promisify(execFile);
const DARWIN_CLONE = `
import ctypes
import os
import sys

lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
clonefile = lib.clonefile
clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
clonefile.restype = ctypes.c_int
result = clonefile(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0)
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), sys.argv[2])
`;

function refuse(message) {
  throw new Error(`Isolated Ollama evaluation refused: ${message}`);
}

async function assertCanonicalDirectory(directory, label) {
  const info = await fs.lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    refuse(`${label} is not a canonical directory`);
  }
}

async function readBoundedRegularFile(filename, limit, label) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) refuse(`${label} is not a bounded regular file`);
  const handle = await fs.open(filename, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== before.size || current.dev !== before.dev || current.ino !== before.ino) {
      refuse(`${label} changed while it was opened`);
    }
    const data = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) refuse(`${label} ended before its declared size`);
      offset += bytesRead;
    }
    return data;
  } finally {
    await handle.close();
  }
}

async function findManifest(manifestsRoot, expectedDigest) {
  await assertCanonicalDirectory(manifestsRoot, 'manifest store');
  const pending = [manifestsRoot];
  let entries = 0;
  let bytesRead = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await fs.readdir(directory)) {
      if (++entries > MAX_MANIFEST_ENTRIES) refuse('manifest store exceeds the scan bound');
      const candidate = path.join(directory, name);
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink()) refuse('manifest store contains a symbolic link');
      if (info.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!info.isFile()) refuse('manifest store contains a non-file entry');
      bytesRead += info.size;
      if (bytesRead > MAX_MANIFEST_BYTES) refuse('manifest scan exceeds the read bound');
      const bytes = await readBoundedRegularFile(candidate, MAX_MANIFEST_BYTES, 'manifest');
      if (createHash('sha256').update(bytes).digest('hex') === expectedDigest) return bytes;
    }
  }
  refuse('no local manifest matches the installed digest');
}

function parseDescriptor(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} is malformed`);
  const match = typeof value.digest === 'string' ? value.digest.match(DIGEST) : null;
  if (!match || !Number.isSafeInteger(value.size) || value.size < 0) refuse(`${label} has an unknown content reference`);
  if ('urls' in value || 'url' in value) refuse(`${label} contains a remote reference`);
  return { hex: match[1], size: value.size };
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('matching manifest is not valid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) {
    refuse('matching manifest has an unsupported shape');
  }
  const descriptors = [parseDescriptor(manifest.config, 'config')];
  for (let index = 0; index < manifest.layers.length; index++) {
    descriptors.push(parseDescriptor(manifest.layers[index], `layer ${index}`));
  }
  if (!manifest.layers.length) refuse('matching manifest has no layers');
  return descriptors;
}

async function verifyBlob(filename, expectedSize, expectedHex) {
  const before = await fs.lstat(filename).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size !== expectedSize) {
    refuse(`blob sha256:${expectedHex} is missing or has the wrong size`);
  }
  const handle = await fs.open(filename, 'r');
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      refuse(`blob sha256:${expectedHex} changed while it was opened`);
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!bytesRead) refuse(`blob sha256:${expectedHex} ended before its declared size`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || hash.digest('hex') !== expectedHex) {
      refuse(`blob sha256:${expectedHex} failed integrity verification`);
    }
  } finally {
    await handle.close();
  }
}

async function cloneBlob(source, destination) {
  const flags = fsConstants.COPYFILE_FICLONE_FORCE | fsConstants.COPYFILE_EXCL;
  try {
    await fs.copyFile(source, destination, flags);
  } catch (error) {
    if (error?.code !== 'ENOSYS') throw error;
    // Node's macOS copyfile binding does not implement FICLONE_FORCE. Call
    // clonefile(2) itself. It provides COW semantics and never copies as a fallback.
    await execFileAsync('/opt/homebrew/bin/python3', ['-c', DARWIN_CLONE, source, destination], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, env: {},
    });
    const cloned = await fs.lstat(destination).catch(() => null);
    if (!cloned?.isFile() || cloned.isSymbolicLink()) refuse('forced private blob clone did not create a regular file');
  }
}

export async function prepareIsolatedOllamaModelStore({ installed, modelStore }) {
  if (!installed || typeof installed.name !== 'string' || !installed.name
      || !Number.isSafeInteger(installed.size) || installed.size <= 0 || installed.size > MAX_MODEL_BYTES
      || !HEX_64.test(installed.digest ?? '')) {
    refuse('installed model identity is malformed or too large');
  }
  if (typeof modelStore !== 'string' || !path.isAbsolute(modelStore)) refuse('model store must be an absolute path');
  await assertCanonicalDirectory(modelStore, 'model store');
  await assertCanonicalDirectory(path.join(modelStore, 'blobs'), 'blob store');

  const manifestBytes = await findManifest(path.join(modelStore, 'manifests'), installed.digest);
  const descriptors = parseManifest(manifestBytes);
  const unique = new Map();
  for (const descriptor of descriptors) {
    const prior = unique.get(descriptor.hex);
    if (prior !== undefined && prior !== descriptor.size) refuse('manifest assigns conflicting sizes to one blob');
    unique.set(descriptor.hex, descriptor.size);
  }
  const referencedBytes = [...unique.values()].reduce((total, size) => total + size, 0);
  if (!Number.isSafeInteger(referencedBytes) || referencedBytes > MAX_MODEL_BYTES + MAX_DESCRIPTOR_OVERHEAD) {
    refuse('manifest exceeds the isolated disk bound');
  }

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'plainsong-ollama-eval-'));
  const root = await fs.realpath(temporary);
  await fs.chmod(root, 0o700);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077)) {
    await fs.rm(root, { recursive: true, force: true });
    refuse('private evaluation directory could not be secured');
  }

  try {
    const privateModels = path.join(root, 'models');
    const privateBlobs = path.join(privateModels, 'blobs');
    const privateManifest = path.join(privateModels, 'manifests', 'registry.ollama.ai', 'library', 'plainsong-eval', 'fixture');
    const privateHome = path.join(root, 'home');
    const privateTmp = path.join(root, 'tmp');
    await Promise.all([
      fs.mkdir(privateBlobs, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.dirname(privateManifest), { recursive: true, mode: 0o700 }),
      fs.mkdir(privateHome, { mode: 0o700 }),
      fs.mkdir(privateTmp, { mode: 0o700 }),
    ]);
    for (const [hex, size] of unique) {
      const source = path.join(modelStore, 'blobs', `sha256-${hex}`);
      const destination = path.join(privateBlobs, `sha256-${hex}`);
      await verifyBlob(source, size, hex);
      await cloneBlob(source, destination);
      await fs.chmod(destination, 0o400);
      await verifyBlob(destination, size, hex);
      const [sourceInfo, destinationInfo] = await Promise.all([fs.stat(source), fs.stat(destination)]);
      if (sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino) {
        refuse(`private blob sha256:${hex} does not have an independent inode`);
      }
    }
    await fs.writeFile(privateManifest, manifestBytes, { mode: 0o600, flag: 'wx' });
    return {
      model: MODEL,
      originalManifestSha256: installed.digest,
      modelStoreRoot: privateModels,
      privateRoot: root,
      privateHome,
      privateTmp,
      async cleanup() { await fs.rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') refuse('could not reserve a local port');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function stopOwnedGroup(child) {
  if (!groupExists(child.pid)) {
    await childExit(child);
    return;
  }
  process.kill(-child.pid, 'SIGTERM');
  const exited = childExit(child);
  let timer;
  await Promise.race([
    exited.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
  ]);
  clearTimeout(timer);
  if (groupExists(child.pid)) process.kill(-child.pid, 'SIGKILL');
  await exited;
  for (let attempt = 0; attempt < 20 && groupExists(child.pid); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (groupExists(child.pid)) refuse('owned Ollama process group did not terminate');
}

async function waitUntilReady(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) refuse('owned Ollama server exited before readiness');
    try {
      const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  refuse('owned Ollama server did not become ready within 10 seconds');
}

async function assertOwnedListener(port, child) {
  if (child.exitCode !== null || child.signalCode !== null || !groupExists(child.pid)) {
    refuse('owned Ollama server is no longer running');
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp',
    ], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 }));
  } catch {
    refuse('local listener ownership could not be verified');
  }
  const listeners = [...new Set([...stdout.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1])))];
  if (listeners.length !== 1 || listeners[0] !== child.pid
      || child.exitCode !== null || child.signalCode !== null || !groupExists(child.pid)) {
    refuse('local listener is not owned solely by the isolated Ollama process');
  }
  return true;
}

export async function createIsolatedOllamaSession({ installed, modelStore, binary = '/opt/homebrew/bin/ollama' }) {
  const prepared = await prepareIsolatedOllamaModelStore({ installed, modelStore });
  let child;
  let log;
  try {
    const port = await reservePort();
    const host = `127.0.0.1:${port}`;
    const baseUrl = `http://${host}`;
    log = await fs.open(path.join(prepared.privateRoot, 'ollama.log'), 'wx', 0o600);
    child = spawn(binary, ['serve'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        PATH: `${path.dirname(binary)}:/usr/bin:/bin`,
        HOME: prepared.privateHome,
        TMPDIR: prepared.privateTmp,
        OLLAMA_MODELS: prepared.modelStoreRoot,
        OLLAMA_HOST: host,
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_KEEP_ALIVE: '0',
      },
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await log.close();
    log = null;
    await waitUntilReady(baseUrl, child);
    await assertOwnedListener(port, child);
    let closed = false;
    return {
      model: prepared.model,
      runtimePid: child.pid,
      privateRoot: prepared.privateRoot,
      baseUrl,
      originalManifestSha256: prepared.originalManifestSha256,
      modelStoreRoot: prepared.modelStoreRoot,
      async assertOwnership() {
        if (closed) refuse('isolated Ollama session is closed');
        return assertOwnedListener(port, child);
      },
      async close() {
        if (closed) return;
        await stopOwnedGroup(child);
        await prepared.cleanup();
        closed = true;
      },
    };
  } catch (error) {
    if (log) await log.close().catch(() => {});
    if (child?.pid) await stopOwnedGroup(child).catch(() => {});
    if (!child?.pid || !groupExists(child.pid)) await prepared.cleanup().catch(() => {});
    throw error;
  }
}
