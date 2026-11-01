import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

function release(version, prerelease = true) {
  return {
    tag_name: 'v' + version, draft: false, prerelease,
    assets: [{ name: prerelease ? 'beta-mac.yml' : 'latest-mac.yml' },
      { name: `Plainsong-${version}-arm64-mac.zip`, size: 4096 }],
  };
}

async function withFeed(initial, run) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new Map();
  const state = { releases: initial, apiAvailable: true, apiFailure: null, calls: [] };
  globalThis.caches = { default: {
    match: async request => cache.get(request.url)?.clone(),
    put: async (request, response) => { cache.set(request.url, response.clone()); },
  } };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    state.calls.push({ url: url.href, ...init });
    if (url.hostname === 'api.github.com') {
      if (state.apiFailure === 'network') throw new TypeError('Synthetic network failure');
      if (state.apiFailure === 'json') return new Response('Invalid JSON');
      if (state.apiFailure === 'rate-limit') return new Response('Rate limited', { status: 403 });
      if (state.apiFailure === 'shape') return Response.json({ message: 'Unexpected API response' });
      return state.apiAvailable
        ? Response.json(state.releases)
        : new Response('API unavailable', { status: 503 });
    }
    assert.equal(url.hostname, 'github.com');
    const match = url.pathname.match(/^\/sample\/app\/releases\/download\/([^/]+)\/(.+)$/);
    assert.ok(match, url.href);
    const chosen = state.releases.find(item => item.tag_name === match[1]);
    const name = decodeURIComponent(match[2]);
    if (!chosen?.assets.some(asset => asset.name === name)) return new Response('Missing asset', { status: 404 });
    if (name.endsWith('.yml')) {
      const zip = chosen.assets.find(asset => asset.name.endsWith('.zip'));
      return new Response(`version: ${chosen.tag_name.slice(1)}\npath: ${zip.name}\n`);
    }
    const bytes = new Uint8Array(4096).fill(chosen.prerelease ? 5 : 4);
    bytes.set([0x50, 0x4b, 0x03, 0x04]);
    const range = new Headers(init.headers).get('range');
    if (range) {
      assert.equal(range, 'bytes=0-127');
      return new Response(bytes.slice(0, 128), { status: 206, headers: { 'Content-Range': 'bytes 0-127/4096' } });
    }
    return new Response(init.method === 'HEAD' ? null : bytes);
  };
  const env = { GITHUB_REPO: 'sample/app', FALLBACK_BETA_TAG: 'v0.9.0-beta.5' };
  const request = async (pathname, headers = {}, method = 'GET') => {
    const pending = [];
    const response = await worker.fetch(new Request('https://updates.example/' + pathname, { headers, method }), env, { waitUntil: task => pending.push(task) });
    await Promise.all(pending);
    return response;
  };
  try { await run({ state, cache, request }); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('a cached manifest keeps its versioned ZIP available after a newer release appears', async () => {
  const old = release('0.9.0-beta.5');
  const next = release('0.9.0-beta.6');
  await withFeed([old], async ({ state, cache, request }) => {
    assert.match(await (await request('beta/beta-mac.yml')).text(), /0\.9\.0-beta\.5/);
    state.releases = [next, old];
    const cached = await request('beta/beta-mac.yml');
    assert.equal(cached.headers.get('x-plainsong-release'), old.tag_name);
    assert.match(await cached.text(), /0\.9\.0-beta\.5/);
    const asset = await request('beta/' + old.assets[1].name, { Range: 'bytes=0-127' });
    assert.equal(asset.status, 206);
    assert.equal(asset.headers.get('Content-Range'), 'bytes 0-127/4096');
    assert.equal((await asset.arrayBuffer()).byteLength, 128);
    assert.ok(state.calls.some(call => call.url.endsWith('/' + old.tag_name + '/' + old.assets[1].name)));
    cache.clear();
    assert.match(await (await request('beta/beta-mac.yml')).text(), /0\.9\.0-beta\.6/);
    assert.equal((await request('beta/' + next.assets[1].name)).status, 200);
  });
});

test('stable never serves a prerelease asset', async () => {
  const beta = release('0.9.0-beta.6');
  const stable = release('0.8.0', false);
  await withFeed([beta, stable], async ({ request }) => {
    assert.equal((await request('stable/' + beta.assets[1].name)).status, 404);
    assert.equal((await request('stable/' + stable.assets[1].name)).status, 200);
  });
});

test('the configured beta fallback remains usable when the release API is unavailable', async () => {
  const old = release('0.9.0-beta.5');
  await withFeed([old], async ({ state, request }) => {
    state.apiAvailable = false;
    const response = await request('beta/' + old.assets[1].name, { Range: 'bytes=0-127' });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 128);
  });
});

for (const failure of ['network', 'json', 'shape']) {
  test(`the beta fallback survives a release API ${failure} failure without serving beta to stable`, async () => {
    const old = release('0.9.0-beta.5');
    await withFeed([old], async ({ state, request }) => {
      state.apiFailure = failure;
      const manifest = await request('beta/beta-mac.yml');
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers.get('x-plainsong-release'), old.tag_name);
      assert.match(await manifest.text(), /0\.9\.0-beta\.5/);
      const asset = await request('beta/' + old.assets[1].name, { Range: 'bytes=0-127' });
      assert.equal(asset.status, 206);
      assert.equal(asset.headers.get('Content-Range'), 'bytes 0-127/4096');
      assert.equal((await asset.arrayBuffer()).byteLength, 128);
      assert.equal((await request('stable/latest-mac.yml')).status, 404);
      assert.equal((await request('stable/' + old.assets[1].name)).status, 404);
    });
  });
}

for (const version of ['0.9.0-beta.4', '0.9.0-beta.6']) {
  test(`cached ${version} assets survive release API outages independently of beta.5 fallback`, async () => {
    const published = release(version);
    const zip = published.assets[1].name;
    published.assets.push({ name: zip + '.blockmap' });
    await withFeed([published], async ({ state, request }) => {
      await request('beta/beta-mac.yml');
      for (const failure of ['network', 'json', 'shape', 'rate-limit']) {
        state.apiFailure = failure;
        if (failure === 'rate-limit') state.apiAvailable = false;
        assert.equal((await request('beta/beta-mac.yml')).headers.get('x-plainsong-release'), published.tag_name);
        const ranged = await request('beta/' + zip, { Range: 'bytes=0-127' });
        assert.equal(ranged.status, 206, failure);
        assert.equal(ranged.headers.get('Content-Range'), 'bytes 0-127/4096');
        assert.equal((await ranged.arrayBuffer()).byteLength, 128);
        const head = await request('beta/' + zip + '.blockmap', {}, 'HEAD');
        assert.equal(head.status, 200);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const last = state.calls.at(-1);
        assert.equal(last.method, 'HEAD');
        assert.ok(last.url.endsWith('/' + published.tag_name + '/' + zip + '.blockmap'));
      }
    });
  });
}

test('stable versioned assets require release-list evidence even during an API outage', async () => {
  const beta = release('0.9.0-beta.6');
  const disguised = release('0.9.0');
  const stable = release('0.8.0', false);
  await withFeed([beta, disguised, stable], async ({ state, request }) => {
    for (const item of [beta, disguised]) {
      assert.equal((await request('stable/' + item.assets[1].name)).status, 404);
    }
    state.apiFailure = 'network';
    for (const item of [beta, disguised, stable]) {
      assert.equal((await request('stable/' + item.assets[1].name)).status, 404);
    }
    assert.equal(state.calls.filter(call => new URL(call.url).hostname === 'github.com').length, 0);
  });
});

test('malformed or ambiguous filenames do not derive a release tag', async () => {
  const next = release('0.9.0-beta.6');
  const names = [
    'Plainsong-00.9.0-beta.6-arm64-mac.zip',
    'Plainsong-0.9.0-beta.06-arm64-mac.zip',
    'Plainsong-0.9.0-beta.6-beta.5-arm64-mac.zip',
    'Plainsong-0.9.0-beta.6-arm64-mac.zip.extra',
    'Plainsong-0.9.0-beta.6-arm64-mac.zip.blockmap.extra',
    'Other-0.9.0-beta.6-arm64-mac.zip',
    'Plainsong-0.9.0-beta.6-unknown-mac.zip',
    'nested/Plainsong-0.9.0-beta.6-arm64-mac.zip',
  ];
  next.assets.push(...names.map(name => ({ name })));
  await withFeed([next], async ({ state, request }) => {
    state.apiFailure = 'network';
    for (const name of names) {
      assert.equal((await request('beta/' + name)).status, 404, name);
      assert.ok(state.calls.at(-1).url.includes('/v0.9.0-beta.5/'), name);
    }
  });
});

test('unknown filenames retain release-list lookup and configured fallback behavior', async () => {
  const old = release('0.9.0-beta.5');
  old.assets.push({ name: 'release-notes.txt' });
  await withFeed([old], async ({ state, request }) => {
    assert.equal((await request('beta/release-notes.txt')).status, 200);
    state.apiFailure = 'network';
    assert.equal((await request('beta/release-notes.txt')).status, 200);
    assert.equal((await request('other/' + old.assets[1].name)).status, 404);
  });
});

test('the beta feed resolves canonical x64 release ZIPs and ranged blockmaps without an API listing', async () => {
  const published = release('1.0.0', false);
  const zip = 'Plainsong-1.0.0-x64-mac.zip';
  published.assets.push({ name: zip }, { name: zip + '.blockmap' });
  await withFeed([published], async ({ state, request }) => {
    state.apiFailure = 'network';
    assert.equal((await request('beta/' + zip)).status, 200);
    const blockmap = await request('beta/' + zip + '.blockmap', { Range: 'bytes=0-127' });
    assert.equal(blockmap.status, 206);
    assert.equal((await blockmap.arrayBuffer()).byteLength, 128);
    assert.ok(state.calls.every(call => call.url.includes('/v1.0.0/')));
  });
});

test('stable manifest is absent while GitHub contains only beta releases', async () => {
  await withFeed([release('0.9.0-beta.7')], async ({ request }) => {
    const stable = await request('stable/latest-mac.yml');
    assert.equal(stable.status, 404);
    assert.equal(await stable.text(), 'no stable release yet\n');
    assert.equal((await request('beta/beta-mac.yml')).status, 200);
  });
});
