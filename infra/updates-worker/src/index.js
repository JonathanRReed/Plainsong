// Update feed for installed Plainsong apps.
//
//   GET /beta/beta-mac.yml     manifest of the newest pre-release that has one
//   GET /stable/latest-mac.yml manifest of the newest full release (404 until 1.0)
//   GET /<channel>/<file>      proxy that release's asset from GitHub
//
// Manifests are fetched from GitHub and cached at the edge for ten minutes.
// Nothing here is authenticated; the repository and its releases are public.

const MANIFEST = { beta: "beta-mac.yml", stable: "latest-mac.yml" };
const CACHE_SECONDS = 600;
const UA = "plainsong-updates-worker (+https://plainsong.jonathanrreed.com)";

async function releasesFor(env, channel) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases?per_page=20`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) return null;
  const all = await res.json();
  const wanted = MANIFEST[channel];
  // newest first; a stable install must never be offered a pre-release
  return all.filter((r) => !r.draft && (channel === "beta" ? true : !r.prerelease) && r.assets.some((a) => a.name === wanted));
}

function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const [, channel, ...rest] = url.pathname.split("/");
    const file = rest.join("/");

    if (!channel) return text("Plainsong update feed. Channels: /beta/ and /stable/.\n");
    if (!MANIFEST[channel]) return text("unknown channel\n", 404);
    if (!file) return text(`channel ${channel}\n`);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (request.method === "GET" && file === MANIFEST[channel]) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    let releases = await releasesFor(env, channel);
    let tag = releases && releases[0] ? releases[0].tag_name : null;
    if (!tag && channel === "beta" && env.FALLBACK_BETA_TAG) tag = env.FALLBACK_BETA_TAG;
    if (!tag) return text(`no ${channel} release yet\n`, 404);

    const asset = `https://github.com/${env.GITHUB_REPO}/releases/download/${tag}/${encodeURIComponent(file)}`;

    if (file === MANIFEST[channel]) {
      const upstream = await fetch(asset, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!upstream.ok) return text(`manifest missing on ${tag}\n`, 404);
      const body = await upstream.text();
      const res = new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/yaml; charset=utf-8",
          "cache-control": `public, max-age=${CACHE_SECONDS}`,
          "x-plainsong-release": tag,
        },
      });
      if (request.method === "GET") ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // Keep assets on the feed origin so the release gate can verify them. Forward
    // ranges because electron-updater and the gate use them for large downloads.
    const headers = { "User-Agent": UA };
    const range = request.headers.get("range");
    if (range) headers.Range = range;
    const upstream = await fetch(asset, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });
    return new Response(upstream.body, upstream);
  },
};
