import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePublicReleaseRollout, siteMetadataMatches } from "../../scripts/lib/public-release-rollout.ts";

const version = "0.9.0-beta.7";
const base = `https://github.com/JonathanRReed/Plainsong/releases/download/v${version}/`;
const dmgBody = "candidate DMG bytes";
const zipBody = "candidate ZIP bytes";
function asset(name: string, body: string) {
  return { name, url: base + name, bytes: Buffer.byteLength(body),
    sha256: crypto.createHash("sha256").update(body).digest("hex") };
}
const dmg = asset(`Plainsong-${version}-arm64.dmg`, dmgBody);
const zip = asset(`Plainsong-${version}-arm64-mac.zip`, zipBody);
const siteUrl = "https://plainsong.example/";
const downloadHtml = `<a href="${dmg.url}">${dmg.name}</a><code>${dmg.sha256}</code><a href="${zip.url}">${zip.name}</a>`;
const llmsText = `Plainsong ${version} is a public pre-release, published October 30, 2026: ${dmg.name}, SHA-256 ${dmg.sha256}.`;

function mockPublicResponses(overrides: Record<string, { body: string; status?: number }> = {}) {
  const responses: Record<string, { body: string; status?: number }> = {
    [dmg.url]: { body: dmgBody }, [zip.url]: { body: zipBody },
    [siteUrl + "download/"]: { body: downloadHtml }, [siteUrl + "llms.txt"]: { body: llmsText },
    ...overrides,
  };
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const fixture = responses[url];
    if (!fixture) throw new Error(`Unexpected request: ${url}`);
    const response = new Response(fixture.body, { status: fixture.status ?? 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("public release rollout", () => {
  it("accepts matching public downloads and site metadata using only unauthenticated GETs", async () => {
    const fetchMock = mockPublicResponses();
    const receipt = await capturePublicReleaseRollout({ siteUrl, version, dmg, zip });
    expect(receipt.downloadsPass).toBe(true);
    expect(receipt.sitePass).toBe(true);
    expect(receipt.downloads.map((download) => download.sha256)).toEqual([dmg.sha256, zip.sha256]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toBeUndefined();
    }
  });

  it("rejects a same-sized public download with different bytes", async () => {
    mockPublicResponses({ [zip.url]: { body: "x".repeat(zip.bytes) } });
    const receipt = await capturePublicReleaseRollout({ siteUrl, version, dmg, zip });
    expect(receipt.downloadsPass).toBe(false);
    expect(receipt.downloads[1].pass).toBe(false);
    expect(receipt.sitePass).toBe(true);
  });

  it("rejects failed HTTP responses even if their bodies match", async () => {
    mockPublicResponses({ [dmg.url]: { body: dmgBody, status: 403 },
      [siteUrl + "download/"]: { body: downloadHtml, status: 404 } });
    const receipt = await capturePublicReleaseRollout({ siteUrl, version, dmg, zip });
    expect(receipt.downloadsPass).toBe(false);
    expect(receipt.sitePass).toBe(false);
  });

  it.each([
    { downloadHtml: downloadHtml.replace(dmg.sha256, "0".repeat(64)), llmsText },
    { downloadHtml: downloadHtml.replace(zip.url, "https://example.com/other.zip"), llmsText },
    { downloadHtml, llmsText: llmsText.replace(version, "0.9.0-beta.5") },
    { downloadHtml: downloadHtml + '<span data-launch-pending="date"></span>', llmsText },
  ])("rejects stale, pending or mismatched site metadata", (pages) => {
    expect(siteMetadataMatches({ ...pages, version, dmg, zip })).toBe(false);
  });
});
