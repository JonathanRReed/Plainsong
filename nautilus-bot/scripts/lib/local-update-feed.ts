import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Transform } from "node:stream";
import { parseMacUpdateManifest } from "./public-update-feed.ts";

export type FeedScenario = "success" | "interrupted" | "corrupt";

export async function hashFile(file: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64") {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function startLocalUpdateFeed(manifestPath: string, scenario: FeedScenario) {
  const text = fs.readFileSync(manifestPath, "utf8");
  const manifest = parseMacUpdateManifest(text);
  const zipName = manifest.zipName;
  if (!manifest.version || !zipName || path.basename(zipName) !== zipName ||
      !/^[\w .+-]+\.zip$/.test(zipName)) {
    throw new Error("Feed needs a version and a relative ZIP basename");
  }
  const sourceZip = path.join(path.dirname(manifestPath), zipName);
  if (await hashFile(sourceZip, "sha512", "base64") !== manifest.sha512 ||
      fs.statSync(sourceZip).size !== manifest.size) {
    throw new Error("Candidate ZIP does not match beta-mac.yml");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-qa-feed-"));
  const requests: { name: string; range: string | null; status: number; dropped: boolean }[] = [];
  let dropped = false;
  const files = new Set(["beta-mac.yml", zipName, `${zipName}.blockmap`]);
  try {
    fs.copyFileSync(manifestPath, path.join(root, "beta-mac.yml"));
    for (const name of [zipName, `${zipName}.blockmap`]) {
      fs.copyFileSync(path.join(path.dirname(manifestPath), name), path.join(root, name));
    }
    if (scenario === "corrupt") {
      const fd = fs.openSync(path.join(root, zipName), "r+");
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, 0);
        byte[0] ^= 0xff;
        fs.writeSync(fd, byte, 0, 1, 0);
      } finally { fs.closeSync(fd); }
    }
    const server = createServer((request, response) => {
      let name: string;
      try { name = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1)); }
      catch { response.writeHead(400).end(); return; }
      if (!files.has(name) || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(404).end(); return;
      }
      const file = path.join(root, name);
      const size = fs.statSync(file).size;
      const range = request.headers.range;
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : size - 1;
      if ((range && !match) || start > end || end >= size) {
        response.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return;
      }
      const drop = scenario === "interrupted" && name === zipName && !dropped && request.method === "GET";
      if (drop) dropped = true;
      const status = range ? 206 : 200;
      requests.push({ name, range: range ?? null, status, dropped: drop });
      response.writeHead(status, {
        "Content-Length": end - start + 1,
        "Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD") { response.end(); return; }
      // A failed first transfer advertises the full file but closes mid-body.
      const stream = fs.createReadStream(file, { start, end: drop ? Math.min(end, start + Math.max(0, Math.floor((end - start) / 2)), start + 1024 * 1024) : end, highWaterMark: 256 * 1024 });
      const pace = new Transform({ transform(chunk, _encoding, callback) {
        setTimeout(() => callback(null, chunk), name === zipName ? 2 : 0);
      } });
      stream.on("error", () => response.destroy());
      response.on("close", () => { stream.destroy(); pace.destroy(); });
      if (drop) {
        stream.pipe(pace).pipe(response, { end: false });
        pace.on("end", () => setTimeout(() => response.destroy(), 100));
      } else stream.pipe(pace).pipe(response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local feed address");
    return {
      url: `http://127.0.0.1:${address.port}/`, version: manifest.version, zipName, requests,
      async close() {
        const closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closing;
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
