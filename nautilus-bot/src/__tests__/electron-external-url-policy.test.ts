import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTERNAL_HOSTS,
  isAllowedExternalUrl,
} from "../../electron/external-url-policy";

describe("external URL policy", () => {
  it("refuses to open an arbitrary https host", () => {
    // The whole point of the allowlist. `connect-src 'self'` stops the renderer
    // talking to the network directly, so openExternal was the one channel a
    // compromised renderer could push data out through.
    expect(isAllowedExternalUrl("https://evil.example/?d=secret")).toBe(false);
    expect(isAllowedExternalUrl("https://attacker.test/collect")).toBe(false);
  });

  it("allows exactly the destinations the renderer can produce", () => {
    // The manual-download fallback in UpdateStatusWidget.
    expect(
      isAllowedExternalUrl("https://github.com/JonathanRReed/Plainsong/releases"),
    ).toBe(true);
    // Every local ASR model's "Learn more" link.
    expect(
      isAllowedExternalUrl("https://huggingface.co/openai/whisper-large-v3"),
    ).toBe(true);
    // The cloud providers' documentation links, from the sidecar's static
    // provider inventory.
    expect(isAllowedExternalUrl("https://console.groq.com/docs/speech-to-text")).toBe(
      true,
    );
    expect(isAllowedExternalUrl("https://developers.openai.com/guides/stt")).toBe(true);
    expect(isAllowedExternalUrl("https://docs.cohere.com/docs/transcribe")).toBe(true);
    expect(isAllowedExternalUrl("https://elevenlabs.io/docs/api-reference")).toBe(true);
    expect(isAllowedExternalUrl("https://developer.apple.com/documentation/speech")).toBe(
      true,
    );
    expect(isAllowedExternalUrl("https://learn.microsoft.com/windows/ai/speech")).toBe(
      true,
    );
  });

  it("matches the host exactly rather than by suffix", () => {
    expect(isAllowedExternalUrl("https://evil-github.com/x")).toBe(false);
    expect(isAllowedExternalUrl("https://github.com.evil.example/x")).toBe(false);
    expect(isAllowedExternalUrl("https://notgithub.com/x")).toBe(false);
    // A subdomain of an allowed host is still a different host.
    expect(isAllowedExternalUrl("https://cdn.huggingface.co/x")).toBe(false);
  });

  it("rejects credentials that would make the authority read as an allowed host", () => {
    // `https://github.com@evil.example/` resolves to evil.example; reject it on
    // the credentials alone so the intent does not depend on parser behavior.
    expect(isAllowedExternalUrl("https://github.com@evil.example/")).toBe(false);
    expect(isAllowedExternalUrl("https://user:pass@github.com/")).toBe(false);
  });

  it("refuses every scheme other than https, mailto included", () => {
    // mailto: used to be allowed and nothing ever produced one.
    expect(isAllowedExternalUrl("mailto:support@plainsong.example")).toBe(false);
    expect(isAllowedExternalUrl("http://github.com/")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("plainsong://bundle/index.html")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
  });

  it("normalizes case and punycode before comparing", () => {
    expect(isAllowedExternalUrl("https://GitHub.COM/JonathanRReed/Plainsong")).toBe(true);
    // A homograph host is a different host once the parser has resolved it.
    expect(isAllowedExternalUrl("https://xn--githb-8va.com/")).toBe(false);
  });

  it("keeps main.ts on the shared policy instead of an inline protocol check", () => {
    // The finding was that main.ts allowlisted the protocol only. Pin the
    // import so the check cannot quietly move back inline.
    const mainSource = readFileSync(
      path.resolve(process.cwd(), "electron/main.ts"),
      "utf8",
    );
    expect(mainSource).toContain(
      'import { isAllowedExternalUrl } from "./external-url-policy"',
    );
    expect(mainSource).not.toMatch(/function isAllowedExternalUrl/);
    expect(mainSource).not.toContain('"mailto:"');
  });

  it("lists no duplicate hosts", () => {
    expect(new Set(ALLOWED_EXTERNAL_HOSTS).size).toBe(ALLOWED_EXTERNAL_HOSTS.length);
  });
});
