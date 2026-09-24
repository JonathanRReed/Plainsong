// Entitlement tokens: a compact HS256 JWT the Worker signs after a license
// check and verifies on every request. Only this Worker holds the secret, so
// a symmetric signature is enough. Web Crypto only, so it runs unchanged in
// Workers and in Node's test runner.

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret) {
  if (!secret || secret.length < 32) {
    throw new Error("TOKEN_SECRET must be at least 32 characters");
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export async function signToken(claims, secret, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ ...claims, iat: issuedAt, exp: issuedAt + TOKEN_LIFETIME_SECONDS })),
  );
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Claims when the token is genuine and unexpired, else null. Never throws on bad input. */
export async function verifyToken(token, secret, now = Date.now()) {
  try {
    const [header, payload, signature] = String(token ?? "").split(".");
    if (!header || !payload || !signature) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64url(signature),
      encoder.encode(`${header}.${payload}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
