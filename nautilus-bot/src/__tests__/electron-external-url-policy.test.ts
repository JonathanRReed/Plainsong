import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EXTERNAL_HOSTS,
  isAllowedExternalUrl,
} from "../../electron/external-url-policy";

describe("external URL policy", () => {
  it("refuses attacker content and redirects on otherwise approved hosts", () => {
    for (const url of [
      "https://huggingface.co/spaces/attacker/collector?text=private",
      "https://huggingface.co/spaces/attacker/collector/private-transcript",
      "https://huggingface.co/attacker/model/resolve/main/redirect.html",
      "https://github.com/attacker/collector/releases/download/v1/private-transcript",
      "https://github.com/attacker/collector",
      "https://github.com/login?return_to=https://attacker.example",
      "https://docs.x.ai/?text=private",
      "https://huggingface.co/openai/whisper-large-v3#private",
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
  });
  it("keeps the static provider model cards, files and license links reachable", () => {
    const directory = path.resolve(process.cwd(), "rust-sidecar/src/asr");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".rs"))) {
      const source = readFileSync(path.join(directory, file), "utf8");
      const urls = [...source.matchAll(/(?:source_url|upstream_url|url):\s*"(https:\/\/[^"{}]+)"/g)]
        .map((match) => match[1]);
      const repositories = [...source.matchAll(/const \w*(?:HF_REPO|V[23]_REPO|LEGACY_REPO|ORUKEET_REPO)\w*: &str = "([^"/]+\/[^"/]+)"/g)]
        .map((match) => `https://huggingface.co/${match[1]}`);
      for (const url of [...urls, ...repositories]) {
        const parsed = new URL(url);
        if (!["github.com", "huggingface.co", "docs.cohere.com", "console.groq.com",
          "developers.openai.com", "elevenlabs.io", "developers.deepgram.com",
          "docs.mistral.ai", "docs.x.ai", "ai.google.dev", "developer.apple.com",
          "learn.microsoft.com"].includes(parsed.hostname)) continue;
        // Download endpoints are not renderer links. Whisper exposes its model file.
        if (parsed.pathname.includes("/resolve/") && file !== "whisper.rs" &&
          !/(?:LICENSE-WEIGHTS|NOTICE.md|README.md)$/.test(parsed.pathname)) continue;
        expect(isAllowedExternalUrl(url), `${file}: ${url}`).toBe(true);
      }
    }
  });

  it("allows only the fixed ChatGPT usage page", () => {
    expect(isAllowedExternalUrl("https://chatgpt.com/settings/usage")).toBe(true);
    for (const url of [
      "https://chatgpt.com/",
      "https://chatgpt.com/settings/usage?data=private",
      "https://chatgpt.com/settings/usage#private",
      "https://chatgpt.com/settings/usage/",
      "https://chatgpt.com:444/settings/usage",
      "https://user@chatgpt.com/settings/usage",
      "https://chatgpt.com.evil.example/settings/usage",
      "http://chatgpt.com/settings/usage",
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });

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

  it("does not carry key-setup hosts the renderer never links to", () => {
    // Both appear in the Deepgram and Gemini setup copy, but that copy is a
    // provider description and a runtime-diagnostics message, and both render
    // as plain text: the renderer's only external `href` is
    // `provider.modelInfo.sourceUrl` and its only `window.open` is
    // RELEASES_URL. An allowlist entry with no caller is extra egress surface,
    // which is exactly why `mailto:` was removed.
    expect(isAllowedExternalUrl("https://console.deepgram.com")).toBe(false);
    expect(isAllowedExternalUrl("https://aistudio.google.com/apikey")).toBe(
      false,
    );
    // Same for xAI: its key-setup host is named only in a diagnostics string.
    expect(isAllowedExternalUrl("https://console.x.ai")).toBe(false);
    expect(isAllowedExternalUrl("https://docs.x.ai")).toBe(true);
    // The documentation hosts those two providers *do* link, through
    // `sourceUrl`, are allowed.
    expect(
      isAllowedExternalUrl(
        "https://developers.deepgram.com/docs/pre-recorded-audio",
      ),
    ).toBe(true);
    expect(
      isAllowedExternalUrl("https://ai.google.dev/gemini-api/docs/transcribe"),
    ).toBe(true);
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

  it("rejects non-standard ports on allowed hosts", () => {
    // Non-standard ports should be rejected to prevent connecting to arbitrary services.
    expect(isAllowedExternalUrl("https://github.com:8443/")).toBe(false);
    expect(isAllowedExternalUrl("https://github.com:8080/")).toBe(false);
    expect(isAllowedExternalUrl("https://huggingface.co:80/")).toBe(false);
    // Explicit standard HTTPS port 443 parses with an empty port string and is allowed.
    expect(isAllowedExternalUrl("https://github.com:443/")).toBe(true);
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

  it("normalizes case, punycode, and trailing dots before comparing", () => {
    expect(isAllowedExternalUrl("https://GitHub.COM/JonathanRReed/Plainsong")).toBe(true);
    expect(isAllowedExternalUrl("https://github.com./JonathanRReed/Plainsong")).toBe(true);
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
