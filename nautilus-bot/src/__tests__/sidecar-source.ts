/**
 * Reading the Rust sidecar's own source from a TypeScript test.
 *
 * Several contracts can only be asserted against the source: a dispatcher arm
 * needs a whole `AppState` to call, and a "this appears nowhere" guard has no
 * runtime form at all. Those tests used to read one file, `rust-sidecar/src/
 * lib.rs`, because it held every handler. It was split into modules (the map is
 * in that file's crate docs), so reading it alone now silently narrows every
 * such assertion to whatever is left behind.
 *
 * Use `dispatcher()` when the subject is a JSON-RPC arm, and `sidecarSource()`
 * when the subject could be in any module -- especially for a negative
 * assertion, where reading too little is the failure mode that does not show up
 * as a failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SIDECAR_SRC = path.resolve(import.meta.dirname, "../../rust-sidecar/src");

/** One named module under `rust-sidecar/src`, e.g. `"dispatch.rs"`. */
export function sidecarModule(name: string): string {
  return readFileSync(path.join(SIDECAR_SRC, name), "utf8");
}

/**
 * `dispatch.rs`: the router, and the only file that can hold a `"command" =>`
 * arm the renderer is able to reach.
 */
export function dispatcher(): string {
  return sidecarModule("dispatch.rs");
}

let allModules: string | undefined;

/**
 * Every `.rs` file directly under `rust-sidecar/src`, concatenated in name
 * order. Read once and cached; these files do not change during a test run.
 */
export function sidecarSource(): string {
  if (allModules === undefined) {
    allModules = readdirSync(SIDECAR_SRC)
      .filter((entry) => entry.endsWith(".rs"))
      .sort()
      .map((entry) => readFileSync(path.join(SIDECAR_SRC, entry), "utf8"))
      .join("\n");
  }
  return allModules;
}

const VISIBILITIES = ["", "pub(crate) ", "pub "];
const ITEM_KINDS = [
  "fn ",
  "async fn ",
  "struct ",
  "enum ",
  "impl ",
  "const ",
  "static ",
  "type ",
];

/**
 * The source of one top-level item, from its declaration to the next one.
 *
 * Items moved into modules had to be widened to `pub(crate)` so `lib.rs` can
 * re-export them, so neither end of the region can assume a declaration starts
 * its line with a bare keyword.
 */
export function topLevelItem(source: string, declaration: string): string {
  const starts = VISIBILITIES.map((visibility) =>
    source.indexOf(`\n${visibility}${declaration}`),
  ).filter((offset) => offset !== -1);
  if (starts.length === 0) {
    throw new Error(`${declaration} not found in the sidecar source`);
  }
  const start = Math.min(...starts) + 1;
  const body = source.slice(start);

  const ends = ITEM_KINDS.flatMap((kind) =>
    VISIBILITIES.map((visibility) => body.indexOf(`\n${visibility}${kind}`)),
  ).filter((offset) => offset > 0);
  return ends.length === 0 ? body : body.slice(0, Math.min(...ends));
}

/** The body of one `"name" => { … }` dispatcher arm, arm header included. */
export function dispatcherArm(name: string): string {
  const source = dispatcher();
  const start = source.indexOf(`        "${name}" => {`);
  if (start === -1) {
    throw new Error(`no dispatcher arm for ${name}`);
  }
  const end = source.indexOf('\n        "', start + 1);
  if (end === -1) {
    throw new Error(`the ${name} arm is not followed by another arm`);
  }
  return source.slice(start, end);
}
