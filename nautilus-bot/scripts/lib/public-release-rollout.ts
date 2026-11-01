import crypto from "node:crypto";
import { validatePublicFeedUrl } from "./public-update-feed.ts";

export interface PublishedAsset {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export function siteMetadataMatches({ downloadHtml, llmsText, version, dmg, zip }: {
  downloadHtml: string;
  llmsText: string;
  version: string;
  dmg: PublishedAsset;
  zip: PublishedAsset;
}): boolean {
  const links = Array.from(downloadHtml.matchAll(/\bhref=["']([^"']+)["']/g), (match) => match[1]);
  const hashes = Array.from(downloadHtml.matchAll(/<code\b[^>]*>\s*([a-f0-9]{64})\s*<\/code>/g), (match) => match[1]);
  return !/data-launch-pending|Coming soon|not released yet/i.test(downloadHtml + llmsText) &&
    links.includes(dmg.url) && links.includes(zip.url) && hashes.includes(dmg.sha256) &&
    downloadHtml.includes(dmg.name) && downloadHtml.includes(zip.name) &&
    llmsText.includes(`Plainsong ${version} is a public pre-release, published `) &&
    llmsText.includes(dmg.name) && llmsText.includes(`SHA-256 ${dmg.sha256}`);
}

async function get(url: string, maxBytes: number, captureText = false) {
  if (!validatePublicFeedUrl(url).valid) throw new Error(`Expected public HTTPS URL: ${url}`);
  const response = await fetch(url, {
    method: "GET", credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(180_000),
  });
  if (!validatePublicFeedUrl(response.url).valid) throw new Error(`Invalid final URL: ${response.url}`);
  const hash = crypto.createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes: ${url}`);
      hash.update(buffer);
      if (captureText) chunks.push(buffer);
    }
  }
  return { url, finalUrl: response.url, status: response.status, bytes, sha256: hash.digest("hex"),
    text: captureText ? Buffer.concat(chunks).toString("utf8") : "" };
}

export async function capturePublicReleaseRollout({ siteUrl, version, dmg, zip }: {
  siteUrl: string;
  version: string;
  dmg: PublishedAsset;
  zip: PublishedAsset;
}) {
  const downloads = [];
  for (const asset of [dmg, zip]) {
    const result = await get(asset.url, asset.bytes + 1);
    downloads.push({ ...result, pass: result.status === 200 && result.bytes === asset.bytes && result.sha256 === asset.sha256 });
  }
  const downloadPage = await get(new URL("download/", siteUrl).href, 2 * 1024 * 1024, true);
  const llms = await get(new URL("llms.txt", siteUrl).href, 1024 * 1024, true);
  return {
    methods: ["GET"], downloads,
    downloadsPass: downloads.every((download) => download.pass),
    site: { downloadPage, llms },
    sitePass: downloadPage.status === 200 && llms.status === 200 && siteMetadataMatches({
      downloadHtml: downloadPage.text, llmsText: llms.text, version, dmg, zip,
    }),
  };
}
