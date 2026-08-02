/**
 * Machine read-back strategies for the packaged macOS app matrix insertion harness.
 *
 * WHY THIS EXISTS
 * ---------------
 * `smoke_test_cursor_insert` returns `pasted: true` as soon as `CGEvent::post` returns
 * (rust-sidecar/src/lib.rs paste_text_systemwide -> dispatch_paste_from_clipboard).
 * `CGEvent::post` returns nothing, so `pasted: true` says only "we dispatched a keystroke",
 * never "the text landed". Worse, `smoke_test_cursor_insert` calls `paste_text_systemwide`
 * with `keep_text_in_clipboard: true`, so the sample text is copied to the system clipboard
 * *after* the paste attempt on every code path. A naive post-insert `pbpaste` would therefore
 * always "match" even if nothing was inserted anywhere.
 *
 * Every strategy in this module reads the inserted text back out of something OUTSIDE the app
 * under test: an HTTP beacon from a page the app never sees, a file's bytes on disk, the focused
 * native accessibility value, or the system clipboard seeded with a sentinel the app did not
 * write.
 *
 * Dependencies: node builtins plus the macOS `open`, `pbcopy`, `pbpaste` and `osascript`
 * binaries. No package.json dependency is added.
 *
 * SESSION CONTRACT
 * ----------------
 * Each strategy returns a session with the same three phases:
 *
 *   const session = await createReadBackSession(mode, options);
 *   const prepared = await session.prepare();   // stage surface + PRE-INSERT read
 *   // ... caller performs the insert ...
 *   const observed = await session.readBack();  // POST-INSERT read
 *   const cleanup  = await session.cleanup();   // restore anything mutated
 *
 * `prepare()` and `readBack()` both resolve to `{ ok, blockedReason, ... }`. A false `ok` with a
 * `blockedReason` means "this check could not be made externally" and must produce a BLOCKED
 * artifact, never a PASS and never a silent FAIL.
 *
 * A successful `prepare()` also reports `surfaceIdentityEstablished`: true only when an EXTERNAL
 * read proved the staged surface belongs to the matrix row the caller named. Callers must refuse
 * to call a run row-closing when it is false.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const VERIFY_MODES = Object.freeze([
  "local-http-probe",
  "file-on-disk",
  "native-accessibility",
  "clipboard-sentinel",
]);

/** Beacons are capped in the artifact so a long run cannot produce an unreadable file. */
const MAX_RECORDED_BEACONS = 60;

const DEFAULT_PROBE_PAGE_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "app-matrix",
  "insertion-probe.html"
);

const KNOWN_BROWSER_APPS = Object.freeze([
  "Google Chrome",
  "Google Chrome Canary",
  "Chromium",
  "Microsoft Edge",
  "Brave Browser",
  "Arc",
  "Safari",
  "Firefox",
]);

export function isBrowserApp(appName) {
  const value = String(appName ?? "").trim().toLowerCase();
  return KNOWN_BROWSER_APPS.some((name) => name.toLowerCase() === value);
}

export function makeNonce() {
  return crypto.randomBytes(9).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Trailing-whitespace-only normalisation. Editors append a final newline on save and some
 * fields report a trailing space; nothing else is touched, so a partial or mangled insertion
 * still fails the comparison.
 */
export function normalizeReadBackValue(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replace(/[\s ]+$/u, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value ?? "").digest("hex");
}

function runProcess(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    command: `${command} ${argv.join(" ")}`.trim(),
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
    spawnError: result.error ? result.error.message : null,
  };
}

function runOsascript(script) {
  const argv = [];
  for (const line of Array.isArray(script) ? script : [script]) {
    argv.push("-e", line);
  }
  const result = runProcess("osascript", argv);
  return { ...result, stdout: result.stdout.trim() };
}

/**
 * Posts a keystroke through System Events. Requires the *terminal running this harness* to hold
 * Accessibility and Automation permission; a denial surfaces as a non-zero exit, which callers
 * must translate into BLOCKED rather than FAIL.
 */
function pressKeystroke(character, modifiers = ["command"]) {
  const using = modifiers.length
    ? ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}`
    : "";
  const escaped = String(character).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return runOsascript(`tell application "System Events" to keystroke "${escaped}"${using}`);
}

/** Virtual key codes. `keystroke` cannot send these, so they go through `key code`. */
const KEY_CODE_RIGHT_ARROW = 124;
const KEY_CODE_DELETE = 51;

/**
 * Posts a raw virtual key code. Used for selection hygiene: after a Cmd+A the whole field is
 * selected, and ANY subsequent typing or paste replaces that selection. Collapsing the selection
 * before we type or before we hand control back is what keeps the harness from destroying text it
 * failed to read.
 */
function pressKeyCode(keyCode, modifiers = []) {
  const using = modifiers.length
    ? ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}`
    : "";
  return runOsascript(`tell application "System Events" to key code ${Number(keyCode)}${using}`);
}

function keystrokeBlockedReason(label, result) {
  if (result.status === 0) return null;
  const detail = result.stderr || result.spawnError || `exit ${result.status}`;
  return (
    `Could not post ${label} through System Events, so no external read-back was possible. ` +
    "A human must grant the terminal running this harness Accessibility and Automation " +
    `permission (System Settings > Privacy & Security), then re-run. Detail: ${detail}`
  );
}

function pbpaste() {
  const result = runProcess("pbpaste", []);
  return {
    ok: result.status === 0,
    text: result.stdout,
    stderr: result.stderr,
    spawnError: result.spawnError,
  };
}

function pbcopy(text) {
  const result = runProcess("pbcopy", [], { input: String(text ?? "") });
  return {
    ok: result.status === 0,
    stderr: result.stderr,
    spawnError: result.spawnError,
  };
}

/** `clipboard info` lists the flavours present, so the artifact can admit what a text-only restore loses. */
function clipboardInfo() {
  const result = runOsascript("clipboard info");
  return result.status === 0 ? result.stdout : null;
}

/**
 * External frontmost-application read via System Events. This is NOT the app under test talking
 * about itself, so it is legitimate pass-carrying evidence: it is the only thing that ties a
 * read-back to the application a matrix row names.
 */
export function readFrontmostApplication() {
  const result = runOsascript([
    'tell application "System Events" to set frontProcess to first application process whose frontmost is true',
    'tell application "System Events" to return (name of frontProcess) & "|" & (bundle identifier of frontProcess)',
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      name: null,
      bundleId: null,
      error: result.stderr || result.spawnError || `osascript exit ${result.status}`,
    };
  }
  const [name, bundleId] = result.stdout.split("|");
  return {
    ok: true,
    name: (name ?? "").trim() || null,
    bundleId: (bundleId ?? "").trim() || null,
    error: null,
  };
}

/**
 * Hard gate: the application whose field we are about to read MUST be the one the matrix row
 * names, proven by a System Events read of the frontmost process. Every failure mode here is
 * BLOCKED, not FAIL: "we could not prove whose field this is" is not "the product is broken".
 *
 * Without this gate a run named after one application can be satisfied by any other application
 * that happens to own a focused, empty text field.
 */
function frontmostGate({ expectedBundleIds, appLabel, phase }) {
  const frontmost = readFrontmostApplication();
  if (!frontmost.ok) {
    return {
      frontmost,
      matched: false,
      blockedReason:
        `System Events could not report the frontmost application ${phase}, so there is no ` +
        `external proof that anything read back came from ${appLabel}. A human must grant the ` +
        "terminal running this harness Accessibility and Automation permission (System Settings > " +
        `Privacy & Security), then re-run. Detail: ${frontmost.error}`,
    };
  }
  if (!Array.isArray(expectedBundleIds) || expectedBundleIds.length === 0) {
    return {
      frontmost,
      matched: false,
      blockedReason:
        `No expected bundle identifier was supplied for ${appLabel}, so the harness cannot prove ` +
        "externally that the read-back happened inside the application this matrix row names. " +
        "Refusing to guess.",
    };
  }
  if (!frontmost.bundleId) {
    return {
      frontmost,
      matched: false,
      blockedReason:
        `System Events reported the frontmost process ${phase} as ` +
        `${frontmost.name ?? "an unnamed process"} with no bundle identifier, so it cannot be ` +
        `matched against ${appLabel} (expected one of ${expectedBundleIds.join(", ")}).`,
    };
  }
  const matched = expectedBundleIds.some(
    (expected) => String(expected).toLowerCase() === frontmost.bundleId.toLowerCase()
  );
  if (!matched) {
    return {
      frontmost,
      matched: false,
      blockedReason:
        `${appLabel} is not frontmost ${phase}: System Events reports ` +
        `${frontmost.name ?? "unknown"} / ${frontmost.bundleId}, expected one of ` +
        `${expectedBundleIds.join(", ")}. Whatever is read back now would belong to a different ` +
        "application, so it can never be evidence about this matrix row. A human must focus the " +
        "staged surface in the right application and re-run.",
    };
  }
  return { frontmost, matched: true, blockedReason: null };
}

function readFocusedAccessibilityElement(appName) {
  const encodedName = JSON.stringify(String(appName ?? ""));
  const script = `
const systemEvents = Application("System Events");
const process = systemEvents.processes.byName(${encodedName});
if (!process.exists()) {
  throw new Error("Application process is not running");
}
const focused = process.attributes.byName("AXFocusedUIElement").value();
const readAttribute = (name) => {
  try {
    const value = focused.attributes.byName(name).value();
    return value === undefined || value === null ? null : String(value);
  } catch (_) {
    return null;
  }
};
const readValue = () => {
  try {
    const value = focused.attributes.byName("AXValue").value();
    return {
      available: true,
      value: value === undefined || value === null ? "" : String(value),
    };
  } catch (_) {
    return { available: false, value: null };
  }
};
const focusedValue = readValue();
JSON.stringify({
  role: readAttribute("AXRole"),
  subrole: readAttribute("AXSubrole"),
  identifier: readAttribute("AXIdentifier"),
  description: readAttribute("AXDescription"),
  valueAvailable: focusedValue.available,
  value: focusedValue.value,
});
`;
  const result = runProcess("osascript", ["-l", "JavaScript", "-e", script]);
  if (result.status !== 0) {
    return {
      ok: false,
      element: null,
      error: result.stderr || result.spawnError || `osascript exit ${result.status}`,
    };
  }
  try {
    const element = JSON.parse(result.stdout.trim());
    return {
      ok: element?.valueAvailable === true && typeof element?.value === "string",
      element,
      error:
        element?.valueAvailable === true && typeof element?.value === "string"
          ? null
          : "The focused element exposed no string AXValue.",
    };
  } catch (error) {
    return {
      ok: false,
      element: null,
      error: `The accessibility read returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function openWithApp({ bundleId, appName, argument }) {
  if (bundleId) {
    const byBundle = runProcess("open", argument ? ["-b", bundleId, argument] : ["-b", bundleId]);
    if (byBundle.status === 0) {
      return { ...byBundle, resolvedBy: "bundle-id", bundleId, appName: appName ?? null };
    }
    if (!appName) {
      return { ...byBundle, resolvedBy: "bundle-id", bundleId, appName: null };
    }
  }
  const byName = runProcess("open", argument ? ["-a", appName, argument] : ["-a", appName]);
  return { ...byName, resolvedBy: "app-name", bundleId: bundleId ?? null, appName: appName ?? null };
}

/* ------------------------------------------------------------------------------------------ */
/* Strategy 1: local HTTP probe                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Serves scripts/fixtures/app-matrix/insertion-probe.html from an ephemeral 127.0.0.1 port and
 * collects the beacons it POSTs back. The observed value never passes through the app under
 * test: the browser reads its own textarea and reports it to this process.
 *
 * SCOPE HONESTY: the probe page is a bare textarea. It is not Google Docs, not HubSpot, and not
 * any other product surface. It proves that insertion lands in a *browser text field*, nothing
 * more. `surfaceIdentityEstablished` is therefore always false here, and callers must never let
 * such a run close the matrix row it names.
 */
async function startLocalProbeServer(options = {}) {
  const {
    probePagePath = DEFAULT_PROBE_PAGE_PATH,
    nonce = makeNonce(),
    sampleText = "",
    browserApp = "Google Chrome",
    browserBundleId = null,
    openPage = true,
    readyTimeoutMs = 20000,
    readBackTimeoutMs = 20000,
    pollIntervalMs = 250,
    closeTab = true,
  } = options;

  if (!fs.existsSync(probePagePath)) {
    throw new Error(`Insertion probe page not found at ${probePagePath}`);
  }

  const beacons = [];
  const rejectedBeacons = [];
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount += 1;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/probe")) {
      let html;
      try {
        html = fs.readFileSync(probePagePath, "utf8");
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`probe page unreadable: ${error instanceof Error ? error.message : error}`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/beacon") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        if (body.length < 262144) body += chunk;
      });
      req.on("end", () => {
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
        if (payload && payload.nonce === nonce) {
          beacons.push({ ...payload, receivedAt: new Date().toISOString() });
        } else {
          rejectedBeacons.push({
            receivedAt: new Date().toISOString(),
            reason: payload ? "nonce-mismatch" : "unparsable-body",
            nonce: payload?.nonce ?? null,
          });
        }
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address();
  const probeUrl = `http://127.0.0.1:${port}/probe?nonce=${nonce}`;
  let openResult = null;
  let closeTabResult = null;
  let preparedBeaconCount = 0;
  let preparedSequence = 0;

  function latestBeacon() {
    return beacons.length > 0 ? beacons[beacons.length - 1] : null;
  }

  async function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
      const match = beacons.find((beacon) => predicate(beacon));
      if (match) return match;
      if (Date.now() - startedAt >= timeoutMs) return null;
      await sleep(pollIntervalMs);
    }
  }

  function beaconEvidence() {
    const truncated = beacons.length > MAX_RECORDED_BEACONS;
    return {
      probeUrl,
      nonce,
      port,
      totalBeacons: beacons.length,
      recordedBeacons: truncated ? beacons.slice(-MAX_RECORDED_BEACONS) : beacons.slice(),
      recordedBeaconCap: MAX_RECORDED_BEACONS,
      beaconsTruncated: truncated,
      rejectedBeacons: rejectedBeacons.slice(0, 20),
      rejectedBeaconCount: rejectedBeacons.length,
      httpRequestCount: requestCount,
    };
  }

  return {
    mode: "local-http-probe",
    surface: probeUrl,
    surfaceDescription:
      `Local ephemeral probe page at ${probeUrl} rendered by ${browserApp}. ` +
      "This is a bare textarea served from 127.0.0.1 - it is NOT Google Docs, HubSpot, or any " +
      "other product surface.",
    surfaceIsRealTargetApplication: false,

    async prepare() {
      if (openPage) {
        openResult = openWithApp({
          bundleId: browserBundleId,
          appName: browserApp,
          argument: probeUrl,
        });
        if (openResult.status !== 0) {
          return {
            ok: false,
            blockedReason:
              `Could not open the probe page in ${browserApp} (open exited ${openResult.status}). ` +
              `Detail: ${openResult.stderr || openResult.spawnError || "no stderr"}`,
            preInsertValue: null,
            evidence: { openResult, ...beaconEvidence() },
          };
        }
      }

      const ready = await waitFor((beacon) => beacon.phase === "ready", readyTimeoutMs);
      if (!ready) {
        return {
          ok: false,
          blockedReason:
            `The probe page never reported ready within ${readyTimeoutMs} ms. ` +
            `A human must confirm ${browserApp} can load ${probeUrl} (proxy, content blocker, or ` +
            "a browser that refuses plain-http localhost will all cause this).",
          preInsertValue: null,
          evidence: { openResult, ...beaconEvidence() },
        };
      }
      if (ready.focused !== true) {
        return {
          ok: false,
          blockedReason:
            "The probe page loaded but its textarea was not focused, so a paste would not land " +
            "in the field being read back. A human must click the field and re-run.",
          preInsertValue: null,
          evidence: { openResult, readyBeacon: ready, ...beaconEvidence() },
        };
      }

      // Let a heartbeat or two land so the pre-insert snapshot is as close to the insert as possible.
      await sleep(Math.min(1200, Math.max(0, pollIntervalMs * 4)));
      const settled = latestBeacon() ?? ready;
      if (settled.windowFocused === false) {
        return {
          ok: false,
          blockedReason:
            `${browserApp} does not hold keyboard focus, so the insert would be delivered to a ` +
            "different application. A human must bring the probe window to the front and re-run.",
          preInsertValue: null,
          evidence: { openResult, readyBeacon: ready, settledBeacon: settled, ...beaconEvidence() },
        };
      }

      preparedBeaconCount = beacons.length;
      preparedSequence = Number(settled.sequence ?? 0);
      return {
        ok: true,
        blockedReason: null,
        // The surface is a page this harness serves. No external read can ever make it the
        // product a matrix row names, so this is a hard false.
        surfaceIdentityEstablished: false,
        surfaceIdentity: {
          status: "harness-owned-surface",
          detail:
            `The read-back surface is ${probeUrl}, a textarea served by this harness and rendered ` +
            `by ${browserApp}. It is not a product surface.`,
        },
        preInsertValue: normalizeReadBackValue(settled.value),
        preInsertValueRaw: settled.value ?? "",
        evidence: {
          openResult,
          readyBeacon: ready,
          settledBeacon: settled,
          autofocusHeld: ready.autofocusHeld === true,
          beaconCountAtPrepare: preparedBeaconCount,
          ...beaconEvidence(),
        },
      };
    },

    async readBack() {
      const target = normalizeReadBackValue(sampleText);
      // Only beacons emitted after the pre-insert snapshot can count as evidence of this insert.
      const matched = await waitFor(
        (beacon) =>
          target.length > 0 &&
          Number(beacon.sequence ?? 0) > preparedSequence &&
          normalizeReadBackValue(beacon.value) === target,
        readBackTimeoutMs
      );
      const settled = latestBeacon() ?? null;
      const chosen = matched ?? settled;
      return {
        ok: true,
        blockedReason: null,
        observedValue: normalizeReadBackValue(chosen?.value),
        observedValueRaw: chosen?.value ?? "",
        evidence: {
          matchedBeacon: matched ?? null,
          latestBeacon: settled,
          beaconCountAtPrepare: preparedBeaconCount,
          sequenceAtPrepare: preparedSequence,
          ...beaconEvidence(),
        },
      };
    },

    async cleanup() {
      if (closeTab) {
        closeTabResult = runOsascript([
          `tell application "${String(browserApp).replaceAll('"', '\\"')}"`,
          "  try",
          "    set targets to {}",
          "    repeat with w in windows",
          "      repeat with t in tabs of w",
          `        if URL of t contains "127.0.0.1:${port}" then set end of targets to t`,
          "      end repeat",
          "    end repeat",
          "    repeat with t in targets",
          "      close t",
          "    end repeat",
          "  end try",
          "end tell",
        ]);
      }
      await new Promise((resolve) => server.close(resolve));
      return {
        serverClosed: true,
        closeTabAttempted: Boolean(closeTab),
        closeTabResult,
        note: closeTab
          ? "Probe tab close is best effort; a leftover tab does not affect the verdict."
          : "Probe tab intentionally left open for human inspection.",
        ...beaconEvidence(),
      };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Strategy 2: file on disk                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Editor targets (VS Code, Cursor). Opens a per-run uniquely named scratch file, inserts, sends
 * Cmd+S, then reads the bytes back off the filesystem.
 *
 * The name is never reused: VS Code forks restore unsaved buffers by path, so a recycled name
 * could resurrect a previous run's text and read back as a success that this run did not earn.
 * The scratch file is deliberately RETAINED after the run so a human can inspect the evidence.
 */
function readFileAfterInsert(options = {}) {
  const {
    editorApp = "Visual Studio Code",
    editorBundleId = null,
    expectedBundleIds = [],
    targetLabel = editorApp,
    scratchDir = path.join(os.tmpdir(), "plainsong-app-matrix-readback"),
    nonce = makeNonce(),
    sampleText = "",
    openSettleMs = 5000,
    saveSettleMs = 900,
    readTimeoutMs = 15000,
    pollIntervalMs = 250,
    fileExtension = ".txt",
  } = options;

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const scratchFilePath = path.join(
    scratchDir,
    `plainsong-insertion-${stamp}-${nonce}${fileExtension}`
  );
  let openResult = null;
  let frontmostAtPrepare = null;

  function statEvidence() {
    if (!fs.existsSync(scratchFilePath)) return null;
    const stats = fs.statSync(scratchFilePath);
    return {
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  }

  return {
    mode: "file-on-disk",
    surface: scratchFilePath,
    surfaceDescription:
      `Per-run scratch file ${scratchFilePath} opened in ${editorApp}. The observed value is the ` +
      "file's bytes read off disk after Cmd+S, not anything the app under test reported.",
    surfaceIsRealTargetApplication: true,

    async prepare() {
      fs.mkdirSync(scratchDir, { recursive: true });
      if (fs.existsSync(scratchFilePath)) {
        return {
          ok: false,
          blockedReason:
            `Scratch file name collision at ${scratchFilePath}. Names are never reused because ` +
            "editors restore unsaved buffers by path; re-run to get a fresh name.",
          preInsertValue: null,
          evidence: { scratchFilePath },
        };
      }

      fs.writeFileSync(scratchFilePath, "", "utf8");
      const preInsertRaw = fs.readFileSync(scratchFilePath, "utf8");

      openResult = openWithApp({
        bundleId: editorBundleId,
        appName: editorApp,
        argument: scratchFilePath,
      });
      if (openResult.status !== 0) {
        return {
          ok: false,
          blockedReason:
            `Could not open the scratch file in ${editorApp} (open exited ${openResult.status}). ` +
            `Detail: ${openResult.stderr || openResult.spawnError || "no stderr"}`,
          preInsertValue: null,
          evidence: { scratchFilePath, openResult },
        };
      }

      await sleep(openSettleMs);
      // A failed or unmatched frontmost read is BLOCKED, not "carry on": without it the insert
      // could land in any other application and the file read-back would simply be empty.
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "after opening the scratch file",
      });
      frontmostAtPrepare = gate.frontmost;
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          preInsertValue: null,
          evidence: { scratchFilePath, openResult, frontmostAtPrepare },
        };
      }

      return {
        ok: true,
        blockedReason: null,
        // The scratch file was opened in the application System Events just confirmed is
        // frontmost, so the surface and the row's application are the same thing.
        surfaceIdentityEstablished: true,
        surfaceIdentity: {
          status: "matched",
          detail:
            `${targetLabel} owns the scratch file ${scratchFilePath} and System Events confirmed ` +
            `it is frontmost (${frontmostAtPrepare.name} / ${frontmostAtPrepare.bundleId}).`,
        },
        preInsertValue: normalizeReadBackValue(preInsertRaw),
        preInsertValueRaw: preInsertRaw,
        evidence: {
          scratchFilePath,
          openResult,
          frontmostAtPrepare,
          preInsertStat: statEvidence(),
          preInsertSha256: sha256(preInsertRaw),
          note:
            "Pre-insert emptiness is the file's own bytes on disk. The editor buffer is assumed " +
            "to match because the file is brand new and its name has never been used before.",
        },
      };
    },

    async readBack() {
      // Cmd+S is delivered to whatever is frontmost NOW. Re-check before pressing it, so a focus
      // change cannot make this harness save some unrelated document.
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "at the post-insert save",
      });
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          observedValue: null,
          evidence: { scratchFilePath, frontmostAtPrepare, frontmostAtReadBack: gate.frontmost },
        };
      }

      const save = pressKeystroke("s", ["command"]);
      const blocked = keystrokeBlockedReason("Cmd+S", save);
      if (blocked) {
        return {
          ok: false,
          blockedReason: blocked,
          observedValue: null,
          evidence: { scratchFilePath, frontmostAtReadBack: gate.frontmost, saveKeystroke: save },
        };
      }
      await sleep(saveSettleMs);

      const target = normalizeReadBackValue(sampleText);
      const startedAt = Date.now();
      let raw = "";
      for (;;) {
        raw = fs.existsSync(scratchFilePath) ? fs.readFileSync(scratchFilePath, "utf8") : "";
        if (target.length > 0 && normalizeReadBackValue(raw) === target) break;
        if (Date.now() - startedAt >= readTimeoutMs) break;
        await sleep(pollIntervalMs);
      }

      return {
        ok: true,
        blockedReason: null,
        observedValue: normalizeReadBackValue(raw),
        observedValueRaw: raw,
        evidence: {
          scratchFilePath,
          frontmostAtReadBack: gate.frontmost,
          saveKeystroke: { status: save.status, stderr: save.stderr },
          postInsertStat: statEvidence(),
          postInsertSha256: sha256(raw),
          waitedMs: Date.now() - startedAt,
        },
      };
    },

    async cleanup() {
      return {
        scratchFilePath,
        scratchFileRetained: fs.existsSync(scratchFilePath),
        note:
          "The scratch file is retained on purpose so a human can re-read the evidence. The " +
          `${editorApp} window it opened is left for the operator to close.`,
      };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Strategy 3: native accessibility value                                                       */
/* ------------------------------------------------------------------------------------------ */

function nativeAccessibilityReadBack(options = {}) {
  const {
    accessibilityApp = "",
    expectedBundleIds = [],
    targetLabel = accessibilityApp || "the target application",
    verifySurfaceIdentity = null,
    expectedRoles = ["AXTextArea", "AXTextField"],
  } = options;

  let frontmostAtPrepare = null;
  let preparedElement = null;
  let surfaceIdentity = null;

  function readOrBlocked(phase) {
    const read = readFocusedAccessibilityElement(accessibilityApp);
    if (!read.ok) {
      return {
        ok: false,
        blockedReason:
          `System Events could not read the focused accessibility value in ${targetLabel} ` +
          `${phase}. The harness cannot prove what the target field contains. Grant the terminal ` +
          "Accessibility and Automation permission, focus a writable text field, and re-run. " +
          `Detail: ${read.error}`,
        read,
      };
    }
    if (!expectedRoles.includes(read.element.role)) {
      return {
        ok: false,
        blockedReason:
          `The focused element in ${targetLabel} ${phase} has role ` +
          `${read.element.role ?? "unknown"}, not one of ${expectedRoles.join(", ")}. Nothing ` +
          "will be inserted until a writable text field is focused.",
        read,
      };
    }
    return { ok: true, blockedReason: null, read };
  }

  return {
    mode: "native-accessibility",
    surface: `focused native accessibility text field in ${targetLabel}`,
    surfaceDescription:
      `The focused AXTextArea or AXTextField in ${targetLabel}, read directly through System ` +
      "Events before and after insertion. The observed value never comes from Plainsong.",
    surfaceIsRealTargetApplication: true,

    async prepare() {
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "before the pre-insert accessibility read",
      });
      frontmostAtPrepare = gate.frontmost;
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          preInsertValue: null,
          evidence: { frontmostAtPrepare, expectedBundleIds },
        };
      }

      surfaceIdentity = { status: "not-required", detail: null };
      if (typeof verifySurfaceIdentity === "function") {
        surfaceIdentity = (await verifySurfaceIdentity({ frontmost: frontmostAtPrepare })) ?? {
          status: "unavailable",
          detail: "The surface identity verifier returned nothing.",
        };
        if (surfaceIdentity.status === "mismatch") {
          return {
            ok: false,
            blockedReason:
              surfaceIdentity.blockedReason ??
              `The frontmost surface in ${targetLabel} is not the one this matrix row names.`,
            preInsertValue: null,
            evidence: { frontmostAtPrepare, expectedBundleIds, surfaceIdentity },
          };
        }
      }

      const focused = readOrBlocked("before insertion");
      if (!focused.ok) {
        return {
          ok: false,
          blockedReason: focused.blockedReason,
          preInsertValue: null,
          evidence: {
            frontmostAtPrepare,
            expectedBundleIds,
            surfaceIdentity,
            accessibilityRead: focused.read,
          },
        };
      }
      preparedElement = focused.read.element;
      if (normalizeReadBackValue(preparedElement.value) !== "") {
        return {
          ok: false,
          blockedReason:
            `The focused field in ${targetLabel} already contains ` +
            `${preparedElement.value.length} characters. The harness refuses to insert because ` +
            "pre-existing text could masquerade as the sample or be overwritten. Empty the " +
            "disposable target, focus it, and re-run.",
          preInsertValue: null,
          evidence: {
            frontmostAtPrepare,
            expectedBundleIds,
            surfaceIdentity,
            focusedRole: preparedElement.role,
            focusedIdentifier: preparedElement.identifier,
            preInsertLength: preparedElement.value.length,
            preInsertSha256: sha256(preparedElement.value),
          },
        };
      }

      return {
        ok: true,
        blockedReason: null,
        surfaceIdentityEstablished:
          surfaceIdentity.status === "matched" || surfaceIdentity.status === "not-required",
        surfaceIdentity,
        preInsertValue: "",
        preInsertValueRaw: "",
        evidence: {
          frontmostAtPrepare,
          expectedBundleIds,
          surfaceIdentity,
          focusedRole: preparedElement.role,
          focusedIdentifier: preparedElement.identifier,
          preInsertLength: 0,
          preInsertSha256: sha256(""),
          note:
            "System Events read an empty string directly from the focused native text field. " +
            "No keystroke or clipboard inference was used.",
        },
      };
    },

    async readBack() {
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "at the post-insert accessibility read",
      });
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          observedValue: null,
          evidence: { frontmostAtPrepare, frontmostAtReadBack: gate.frontmost },
        };
      }

      const focused = readOrBlocked("after insertion");
      if (!focused.ok) {
        return {
          ok: false,
          blockedReason: focused.blockedReason,
          observedValue: null,
          evidence: {
            frontmostAtPrepare,
            frontmostAtReadBack: gate.frontmost,
            accessibilityRead: focused.read,
          },
        };
      }
      const observedElement = focused.read.element;
      if (
        preparedElement?.identifier &&
        observedElement.identifier &&
        preparedElement.identifier !== observedElement.identifier
      ) {
        return {
          ok: false,
          blockedReason:
            `The focused field changed between the pre-insert and post-insert reads in ` +
            `${targetLabel}. Expected ${preparedElement.identifier}, observed ` +
            `${observedElement.identifier}. The result cannot prove insertion into the staged ` +
            "surface.",
          observedValue: null,
          evidence: {
            frontmostAtPrepare,
            frontmostAtReadBack: gate.frontmost,
            preparedIdentifier: preparedElement.identifier,
            observedIdentifier: observedElement.identifier,
          },
        };
      }

      return {
        ok: true,
        blockedReason: null,
        observedValue: normalizeReadBackValue(observedElement.value),
        observedValueRaw: observedElement.value,
        evidence: {
          frontmostAtPrepare,
          frontmostAtReadBack: gate.frontmost,
          focusedRole: observedElement.role,
          focusedIdentifier: observedElement.identifier,
          observedLength: observedElement.value.length,
          observedSha256: sha256(observedElement.value),
          note:
            "System Events read the post-insert AXValue directly from the same focused native " +
            "text field used for the pre-insert read.",
        },
      };
    },

    async cleanup() {
      return {
        mutatedByReadBack: false,
        note:
          "The native accessibility strategy is read-only. It did not type a probe token or " +
          "modify the clipboard.",
      };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Strategy 4: clipboard sentinel                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Universal fallback for surfaces with no file and no DOM access (Apple Notes, Slack, Notion,
 * Messages, a signed-in web app).
 *
 * FOUR TRAPS THIS DEFEATS, every one of which would otherwise produce a false PASS or destroy
 * the operator's text:
 *
 *  1. The sidecar leaves the sample text in the clipboard after the insert
 *     (keep_text_in_clipboard: true). So a bare post-insert `pbpaste` matches even when nothing
 *     was inserted. Fix: overwrite the clipboard with a fresh sentinel immediately before the
 *     Cmd+A/Cmd+C read-back, so a clipboard still holding the sentinel proves the copy produced
 *     nothing rather than proving the field was empty.
 *  2. Any application at all could own the focused field. A row named "Slack" would then be
 *     closed by an empty TextEdit window. Fix: `frontmostGate` runs before the field is touched
 *     AND again at read-back, and a mismatch is BLOCKED.
 *  3. "The clipboard still holds the sentinel" is NOT evidence that the field was empty - it is
 *     equally what a slow pasteboard or a silently ignored Cmd+C looks like. Fix: the copy is
 *     polled rather than slept on, and emptiness is established POSITIVELY: collapse the
 *     selection, type a probe token, select all, and require the copy to return exactly that
 *     token. Only then do we know both that the field was empty and that Cmd+A/Cmd+C really
 *     reads this surface. An unchanged clipboard at prepare time is BLOCKED, never `""`.
 *  4. A Cmd+A left standing means the pending Cmd+V REPLACES whatever is selected. Fix: every
 *     select-all is collapsed (right arrow) or consumed (delete) before control is handed back,
 *     and a field found to be non-empty is never inserted into at all.
 */
function clipboardSentinelReadBack(options = {}) {
  const {
    nonce = makeNonce(),
    sampleText = "",
    targetLabel = "the target application",
    expectedBundleIds = [],
    verifySurfaceIdentity = null,
    selectSettleMs = 350,
    copyPollIntervalMs = 100,
    copyTimeoutMs = 3000,
    typeSettleMs = 400,
    restoreClipboard = true,
    acceptedPreInsertBlankValues = [],
  } = options;
  const acceptedBlankValues = new Set(
    acceptedPreInsertBlankValues.map((value) => String(value))
  );

  const sentinelPre = `PLAINSONG-READBACK-PRE-${nonce}`;
  const sentinelProbe = `PLAINSONG-READBACK-PROBE-${nonce}`;
  const sentinelPost = `PLAINSONG-READBACK-POST-${nonce}`;
  // Alphanumeric on purpose: punctuation invites autocorrect, emoji substitution and markdown
  // transforms in Slack/Notion, any of which would break the exact comparison below.
  const probeToken = `plainsongprobe${nonce}`;
  let originalClipboard = null;
  let originalClipboardCaptured = false;
  let clipboardInfoBefore = null;
  let frontmostAtPrepare = null;
  let surfaceIdentity = null;
  let probeTyped = false;
  let probeCleared = false;
  let probeUndo = null;

  /**
   * Seeds a sentinel, selects all, copies, and POLLS the pasteboard until it stops holding the
   * sentinel. The poll replaces a fixed settle: under load (Electron apps especially) the copy
   * can land well after a fixed sleep, and treating that late arrival as "nothing was copied" is
   * exactly how empty-field claims get fabricated.
   *
   * Leaves the field fully selected. Callers MUST collapse or consume that selection.
   */
  async function selectAllAndCopy(sentinel) {
    const seeded = pbcopy(sentinel);
    if (!seeded.ok) {
      return {
        blockedReason:
          "pbcopy failed while seeding the clipboard sentinel, so the clipboard read-back cannot " +
          `be trusted. Detail: ${seeded.stderr || seeded.spawnError || "no stderr"}`,
        evidence: { seeded },
      };
    }
    const seedCheck = pbpaste();
    if (!seedCheck.ok || seedCheck.text !== sentinel) {
      return {
        blockedReason:
          "The clipboard did not accept the sentinel (pbpaste read back something else), so a " +
          "clipboard read-back would be meaningless. Another process may be writing the clipboard.",
        evidence: { seeded, seedCheck: { ok: seedCheck.ok, text: seedCheck.text } },
      };
    }

    const selectAll = pressKeystroke("a", ["command"]);
    const selectBlocked = keystrokeBlockedReason("Cmd+A", selectAll);
    if (selectBlocked) {
      return { blockedReason: selectBlocked, evidence: { selectAll } };
    }
    await sleep(selectSettleMs);

    const copy = pressKeystroke("c", ["command"]);
    const copyBlocked = keystrokeBlockedReason("Cmd+C", copy);
    if (copyBlocked) {
      return { blockedReason: copyBlocked, evidence: { selectAll, copy } };
    }

    const startedAt = Date.now();
    let read = pbpaste();
    let pollCount = 1;
    while (read.ok && read.text === sentinel && Date.now() - startedAt < copyTimeoutMs) {
      await sleep(copyPollIntervalMs);
      read = pbpaste();
      pollCount += 1;
    }
    if (!read.ok) {
      return {
        blockedReason:
          `pbpaste failed while reading the target field back. Detail: ${read.stderr || read.spawnError}`,
        evidence: { selectAll, copy, read },
      };
    }

    const clipboardUnchanged = read.text === sentinel;
    return {
      blockedReason: null,
      clipboardUnchanged,
      rawValue: read.text,
      evidence: {
        sentinel,
        selectAllStatus: selectAll.status,
        copyStatus: copy.status,
        clipboardUnchanged,
        copyPollCount: pollCount,
        copyWaitedMs: Date.now() - startedAt,
        copyTimeoutMs,
      },
    };
  }

  /** Collapses a standing select-all so nothing typed or pasted afterwards can replace it. */
  function collapseSelection() {
    const result = pressKeyCode(KEY_CODE_RIGHT_ARROW);
    return { status: result.status, stderr: result.stderr || null };
  }

  /** Best-effort removal of a probe token typed into a field that turned out not to be empty. */
  function undoProbeToken() {
    const collapse = collapseSelection();
    const undo = pressKeystroke("z", ["command"]);
    probeUndo = {
      collapseStatus: collapse.status,
      undoStatus: undo.status,
      undoStderr: undo.stderr || null,
      note:
        `Best effort only. If the undo did not take, the token ${probeToken} is still in the ` +
        "scratch target and a human must remove it.",
    };
    return probeUndo;
  }

  return {
    mode: "clipboard-sentinel",
    surface: "system clipboard via Cmd+A / Cmd+C in the target field",
    surfaceDescription:
      `The focused field of ${targetLabel}, read back by selecting all and copying, with a fresh ` +
      "sentinel seeded into the clipboard first so a failed copy cannot masquerade as a match, " +
      "and with the frontmost application proven through System Events before and after the " +
      "insert. Emptiness is established by typing and reading back a probe token, never inferred.",
    // Declares only that this strategy reads a field inside the application under test. Whether
    // that application is the row's application is decided by frontmostGate at prepare time, and
    // whether the field is the row's surface is decided by the caller's verifySurfaceIdentity.
    surfaceIsRealTargetApplication: true,

    async prepare() {
      const snapshot = pbpaste();
      originalClipboardCaptured = snapshot.ok;
      originalClipboard = snapshot.ok ? snapshot.text : null;
      clipboardInfoBefore = clipboardInfo();

      // (1) Whose field is this? Answered before a single keystroke touches it.
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "before the pre-insert read",
      });
      frontmostAtPrepare = gate.frontmost;
      const baseEvidence = () => ({
        frontmostAtPrepare,
        expectedBundleIds,
        surfaceIdentity,
        clipboardInfoBefore,
        originalClipboardCaptured,
        originalClipboardLength: originalClipboard?.length ?? null,
        probeToken,
        probeTyped,
        probeCleared,
        probeUndo,
      });
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          preInsertValue: null,
          evidence: baseEvidence(),
        };
      }

      // (2) Is this the surface the row names, not merely the right application? Only the caller
      // knows what "the right surface" means for its row, so it supplies the external read.
      surfaceIdentity = { status: "not-required", detail: null };
      if (typeof verifySurfaceIdentity === "function") {
        surfaceIdentity = (await verifySurfaceIdentity({ frontmost: frontmostAtPrepare })) ?? {
          status: "unavailable",
          detail: "The surface identity verifier returned nothing.",
        };
        if (surfaceIdentity.status === "mismatch") {
          return {
            ok: false,
            blockedReason:
              surfaceIdentity.blockedReason ??
              `The frontmost surface in ${targetLabel} is not the one this matrix row names.`,
            preInsertValue: null,
            evidence: baseEvidence(),
          };
        }
      }

      // (3) Read the field as it stands. A changed clipboard means it holds text.
      const first = await selectAllAndCopy(sentinelPre);
      if (first.blockedReason) {
        collapseSelection();
        return {
          ok: false,
          blockedReason: first.blockedReason,
          preInsertValue: null,
          evidence: { ...baseEvidence(), ...first.evidence },
        };
      }

      const acceptedCanonicalBlank =
        !first.clipboardUnchanged && acceptedBlankValues.has(first.rawValue);
      if (!first.clipboardUnchanged && !acceptedCanonicalBlank) {
        // Never insert here. The pending Cmd+V would replace exactly this selection, and
        // pre-existing text can masquerade as an inserted sample.
        const collapse = collapseSelection();
        return {
          ok: false,
          blockedReason:
            `The focused field in ${targetLabel} already holds ${first.rawValue.length} characters ` +
            "of text. The harness refuses to run: the pending Cmd+V would replace that content, " +
            "and pre-existing text is exactly what a false PASS is made of. A human must empty " +
            "the scratch target (or stage a fresh one), focus it, and re-run.",
          preInsertValue: null,
          evidence: {
            ...baseEvidence(),
            ...first.evidence,
            preInsertLength: first.rawValue.length,
            preInsertSha256: sha256(first.rawValue),
            preInsertValueRecorded:
              "Length and SHA-256 only. The harness does not copy the operator's existing text " +
              "into a QA artifact.",
            selectionCollapseStatus: collapse.status,
          },
        };
      }

      // (4) Some surfaces copy a target-specific placeholder from a visually empty editor.
      // Consume only an explicitly accepted placeholder. Otherwise the clipboard still holds the
      // sentinel, which is ambiguous because an empty field and a silently ignored Cmd+C look the
      // same. In both cases, prove emptiness positively with the probe token below.
      let canonicalBlankClear = null;
      if (acceptedCanonicalBlank) {
        const clear = pressKeyCode(KEY_CODE_DELETE);
        canonicalBlankClear = {
          valueLength: first.rawValue.length,
          valueSha256: sha256(first.rawValue),
          deleteStatus: clear.status,
          deleteStderr: clear.stderr || null,
          note:
            "The selected value matched an explicit target-specific empty-editor placeholder and " +
            "was consumed before the positive probe-token round trip.",
        };
        const clearBlocked = keystrokeBlockedReason(
          "Delete (clear the target-specific empty-editor placeholder)",
          clear
        );
        if (clearBlocked) {
          return {
            ok: false,
            blockedReason: clearBlocked,
            preInsertValue: null,
            evidence: { ...baseEvidence(), ...first.evidence, canonicalBlankClear },
          };
        }
      } else {
        const collapse = collapseSelection();
        const collapseBlocked = keystrokeBlockedReason("Right Arrow (collapse selection)", {
          status: collapse.status,
          stderr: collapse.stderr,
          spawnError: null,
        });
        if (collapseBlocked) {
          return {
            ok: false,
            blockedReason: collapseBlocked,
            preInsertValue: null,
            evidence: { ...baseEvidence(), ...first.evidence },
          };
        }
      }
      await sleep(typeSettleMs);

      const typed = pressKeystroke(probeToken, []);
      const typedBlocked = keystrokeBlockedReason("the emptiness probe token", typed);
      if (typedBlocked) {
        return {
          ok: false,
          blockedReason: typedBlocked,
          preInsertValue: null,
          evidence: { ...baseEvidence(), ...first.evidence },
        };
      }
      probeTyped = true;
      await sleep(typeSettleMs);

      const second = await selectAllAndCopy(sentinelProbe);
      if (second.blockedReason) {
        undoProbeToken();
        return {
          ok: false,
          blockedReason: second.blockedReason,
          preInsertValue: null,
          evidence: { ...baseEvidence(), preInsertRound: first.evidence, ...second.evidence },
        };
      }
      if (second.clipboardUnchanged) {
        undoProbeToken();
        return {
          ok: false,
          blockedReason:
            `Cmd+A/Cmd+C produced nothing in ${targetLabel} even after typing a probe token into ` +
            "the focused field, so this surface cannot be read back through the clipboard at all " +
            "and emptiness could not be established externally. Either the keystrokes are not " +
            "reaching the field (grant the terminal Accessibility permission) or the surface " +
            "ignores select-all/copy. A human must pick a plain text field in this application, " +
            `confirm Cmd+A then Cmd+C works there by hand, and re-run. Probe token: ${probeToken}.`,
          preInsertValue: null,
          evidence: { ...baseEvidence(), preInsertRound: first.evidence, ...second.evidence },
        };
      }
      // Case-insensitive on purpose: Notes and Messages capitalise the first letter of a new
      // sentence, which would otherwise turn an empty field into a misleading "not empty" block.
      // Anything beyond that difference is genuinely unexplained and must not be waved through.
      const probeReadBack = normalizeReadBackValue(second.rawValue);
      const probeMatchedExactly = probeReadBack === probeToken;
      const probeMatched = probeReadBack.toLowerCase() === probeToken.toLowerCase();
      if (!probeMatched) {
        undoProbeToken();
        return {
          ok: false,
          blockedReason:
            `Emptiness could not be established in ${targetLabel}: after typing the probe token ` +
            `into the focused field, select-all returned ${second.rawValue.length} characters ` +
            `instead of the ${probeToken.length}-character token alone. Either the field already ` +
            "held text that the first Cmd+C silently failed to reveal, or this surface rewrote the " +
            "typed token. Either way the harness cannot prove the field was empty, so nothing was " +
            "inserted. A human must empty the scratch target (an undo was attempted for the probe " +
            "token), focus it, and re-run.",
          preInsertValue: null,
          evidence: {
            ...baseEvidence(),
            preInsertRound: first.evidence,
            ...second.evidence,
            probeRoundLength: second.rawValue.length,
            probeRoundSha256: sha256(second.rawValue),
            probeRoundValueRecorded:
              "Length and SHA-256 only. The harness does not copy the operator's existing text " +
              "into a QA artifact.",
          },
        };
      }

      // (5) Select-all returned the probe token and nothing else, which proves BOTH that the field
      // was empty before the token was typed AND that Cmd+A/Cmd+C genuinely reads this surface.
      // Consume the standing selection with a delete: that clears the token and leaves the caret
      // in an empty field with nothing selected, so the pending Cmd+V can only append.
      const clearSelectAll = pressKeystroke("a", ["command"]);
      const clearSelectBlocked = keystrokeBlockedReason("Cmd+A (clear the probe token)", clearSelectAll);
      if (clearSelectBlocked) {
        return {
          ok: false,
          blockedReason: clearSelectBlocked,
          preInsertValue: null,
          evidence: { ...baseEvidence(), preInsertRound: first.evidence, ...second.evidence },
        };
      }
      await sleep(selectSettleMs);
      const clear = pressKeyCode(KEY_CODE_DELETE);
      const clearBlocked = keystrokeBlockedReason("Delete (clear the probe token)", clear);
      if (clearBlocked) {
        return {
          ok: false,
          blockedReason: clearBlocked,
          preInsertValue: null,
          evidence: { ...baseEvidence(), preInsertRound: first.evidence, ...second.evidence },
        };
      }
      probeCleared = true;
      await sleep(typeSettleMs);

      return {
        ok: true,
        blockedReason: null,
        surfaceIdentityEstablished:
          surfaceIdentity.status === "matched" || surfaceIdentity.status === "not-required",
        surfaceIdentity,
        preInsertValue: "",
        preInsertValueRaw: "",
        evidence: {
          ...baseEvidence(),
          preInsertRound: first.evidence,
          probeRound: second.evidence,
          canonicalBlankClear,
          probeMatchedExactly,
          probeReadBackLength: probeReadBack.length,
          preInsertInterpretation:
            "Emptiness was established positively, not inferred from silence: " +
            (canonicalBlankClear
              ? "the target-specific empty-editor placeholder was consumed, "
              : "the empty selection was collapsed, ") +
            `the token ${probeToken} was typed, and select-all/copy returned that token ` +
            (probeMatchedExactly
              ? "verbatim"
              : "differing only in letter case, which is the surface's own autocapitalisation") +
            " and nothing else - so the field held nothing before it, and Cmd+A/Cmd+C demonstrably " +
            "reads this surface. The token was then selected and deleted, leaving an empty field " +
            "with no standing selection for the insert to overwrite.",
        },
      };
    },

    async readBack() {
      // Focus can move between prepare and read-back. If it did, the field being copied is not
      // the field that was staged, and the copy proves nothing about this row.
      const gate = frontmostGate({
        expectedBundleIds,
        appLabel: targetLabel,
        phase: "at the post-insert read-back",
      });
      const frontmost = gate.frontmost;
      if (gate.blockedReason) {
        return {
          ok: false,
          blockedReason: gate.blockedReason,
          observedValue: null,
          evidence: { frontmostAtPrepare, frontmostAtReadBack: frontmost, surfaceIdentity },
        };
      }
      if (
        frontmostAtPrepare?.bundleId &&
        frontmost.bundleId &&
        frontmost.bundleId.toLowerCase() !== frontmostAtPrepare.bundleId.toLowerCase()
      ) {
        return {
          ok: false,
          blockedReason:
            `Focus moved between prepare and read-back: the field was staged in ` +
            `${frontmostAtPrepare.name} / ${frontmostAtPrepare.bundleId} but ` +
            `${frontmost.name} / ${frontmost.bundleId} is frontmost now. The read-back would come ` +
            "from a different window, so it cannot be evidence about this run.",
          observedValue: null,
          evidence: { frontmostAtPrepare, frontmostAtReadBack: frontmost, surfaceIdentity },
        };
      }

      const result = await selectAllAndCopy(sentinelPost);
      if (result.blockedReason) {
        collapseSelection();
        return {
          ok: false,
          blockedReason: result.blockedReason,
          observedValue: null,
          evidence: { frontmostAtPrepare, frontmostAtReadBack: frontmost, ...result.evidence },
        };
      }
      const collapse = collapseSelection();

      // Unchanged here is fail-safe in the honest direction: it can only produce an empty
      // observed value, which fails the exact match. It can never manufacture a PASS.
      const observedRaw = result.clipboardUnchanged ? "" : result.rawValue;
      return {
        ok: true,
        blockedReason: null,
        observedValue: normalizeReadBackValue(observedRaw),
        observedValueRaw: observedRaw,
        evidence: {
          frontmostAtPrepare,
          frontmostAtReadBack: frontmost,
          surfaceIdentity,
          readBackClipboardUnchanged: result.clipboardUnchanged,
          readBackInterpretation: result.clipboardUnchanged
            ? "Cmd+A/Cmd+C left the post-sentinel in place. Prepare already proved that Cmd+A/Cmd+C " +
              "reads this field (it returned the typed probe token verbatim), so this is read as " +
              "an empty field - the insert did not land. This direction only ever produces a FAIL."
            : "Cmd+C replaced the post-sentinel, so the observed value is the field's own content " +
              "read out through the system clipboard.",
          sampleTextLength: String(sampleText ?? "").length,
          selectionCollapseStatus: collapse.status,
          ...result.evidence,
        },
      };
    },

    async cleanup() {
      const probeEvidence = {
        probeToken,
        probeTyped,
        probeCleared,
        probeUndo,
        probeResidualRisk:
          probeTyped && !probeCleared
            ? `The probe token ${probeToken} was typed into the scratch target and the harness ` +
              "could not confirm it was removed. A human must check the scratch target."
            : null,
      };
      if (!restoreClipboard || !originalClipboardCaptured) {
        return {
          clipboardRestored: false,
          clipboardRestoreSkipped: true,
          reason: restoreClipboard
            ? "The original clipboard could not be read at prepare time, so nothing was restored."
            : "Clipboard restore disabled by caller.",
          clipboardInfoBefore,
          clipboardInfoAfter: clipboardInfo(),
          ...probeEvidence,
        };
      }
      const restored = pbcopy(originalClipboard ?? "");
      const check = pbpaste();
      return {
        clipboardRestored: restored.ok && check.ok && check.text === (originalClipboard ?? ""),
        restoreStderr: restored.stderr || null,
        clipboardInfoBefore,
        clipboardInfoAfter: clipboardInfo(),
        caveat:
          "Only the plain-text flavour of the clipboard is snapshotted and restored. If the " +
          "clipboard held images or rich data, those flavours are lost by this harness.",
        ...probeEvidence,
      };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Dispatcher                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export async function createReadBackSession(mode, options = {}) {
  switch (mode) {
    case "local-http-probe":
      return await startLocalProbeServer(options);
    case "file-on-disk":
      return readFileAfterInsert(options);
    case "native-accessibility":
      return nativeAccessibilityReadBack(options);
    case "clipboard-sentinel":
      return clipboardSentinelReadBack(options);
    default:
      throw new Error(
        `Unknown verify mode "${mode}". Expected one of: ${VERIFY_MODES.join(", ")}.`
      );
  }
}
