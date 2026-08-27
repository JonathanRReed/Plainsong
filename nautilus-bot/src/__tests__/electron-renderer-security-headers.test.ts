import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RENDERER_CSP_HEADER,
  RENDERER_CSP_META_DIRECTIVES,
  RENDERER_SECURITY_HEADERS,
  withRendererSecurityHeaders,
} from "../../electron/renderer-protocol";

function indexHtmlCsp(): string {
  const html = readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
  const match = html.match(
    /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/,
  );
  expect(match).toBeTruthy();
  return match![1].replace(/\s+/g, " ").trim();
}

describe("renderer security headers", () => {
  it("serves the same policy the index.html meta tag carries", () => {
    // The meta tag stays as a redundant second layer; it must not drift from
    // the header, which is now the authoritative copy.
    expect(indexHtmlCsp()).toBe(RENDERER_CSP_META_DIRECTIVES);
  });

  it("adds frame-ancestors, which a meta tag cannot express", () => {
    // frame-ancestors is ignored in <meta> — it only takes effect as a header,
    // which is the reason the CSP could not live in index.html alone.
    expect(RENDERER_CSP_META_DIRECTIVES).not.toContain("frame-ancestors");
    expect(RENDERER_CSP_HEADER).toBe(
      `${RENDERER_CSP_META_DIRECTIVES}; frame-ancestors 'none'`,
    );
    expect(RENDERER_SECURITY_HEADERS["Content-Security-Policy"]).toBe(
      RENDERER_CSP_HEADER,
    );
  });

  it("keeps the directives that make the renderer's egress story hold", () => {
    // `connect-src 'self'` is what makes the shell.openExternal allowlist the
    // renderer's ONLY egress; the rest close the obvious injection routes.
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(RENDERER_CSP_HEADER).toContain(directive);
    }
  });

  it("attaches all three headers to a served asset", () => {
    const decorated = withRendererSecurityHeaders(
      new Response("body", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    expect(decorated.headers.get("content-security-policy")).toBe(RENDERER_CSP_HEADER);
    expect(decorated.headers.get("x-content-type-options")).toBe("nosniff");
    expect(decorated.headers.get("referrer-policy")).toBe("no-referrer");
    // Unrelated headers survive.
    expect(decorated.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("preserves the status and body of the upstream response", async () => {
    const ok = withRendererSecurityHeaders(new Response("<html></html>", { status: 200 }));
    expect(ok.status).toBe(200);
    await expect(ok.text()).resolves.toBe("<html></html>");

    const missing = withRendererSecurityHeaders(new Response("Not found", { status: 404 }));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe(RENDERER_CSP_HEADER);
  });

  it("does not let an upstream response weaken the policy", () => {
    const decorated = withRendererSecurityHeaders(
      new Response("body", {
        headers: {
          "Content-Security-Policy": "default-src *",
          "X-Content-Type-Options": "",
          "Referrer-Policy": "unsafe-url",
        },
      }),
    );

    expect(decorated.headers.get("content-security-policy")).toBe(RENDERER_CSP_HEADER);
    expect(decorated.headers.get("x-content-type-options")).toBe("nosniff");
    expect(decorated.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("survives a status that cannot carry a body", () => {
    // `new Response(body, { status: 204 })` throws; a null-body status must not
    // take the protocol handler down.
    for (const status of [204, 304]) {
      const decorated = withRendererSecurityHeaders(new Response(null, { status }));
      expect(decorated.status).toBe(status);
      expect(decorated.headers.get("content-security-policy")).toBe(RENDERER_CSP_HEADER);
    }
  });

  it("wraps both the asset and the refusal path in main.ts", () => {
    const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const start = source.indexOf("await protocol.handle(RENDERER_SCHEME");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("if (devServerUrlIsUsable)", start));

    expect(handler.match(/withRendererSecurityHeaders\(/g)).toHaveLength(2);
    // The bare pass-through of net.fetch is gone.
    expect(handler).not.toMatch(/return net\.fetch\(/);
  });
});
