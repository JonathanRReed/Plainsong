# Electron shell size and startup — measurement receipt

**Date:** 2026-09-02
**Machine:** Apple M4 Pro (14 cores), 24 GB, macOS 27.0 (build 26A5406e)
**Branch:** `worktree-agent-ab2ebdb6db772dbeb`, cut from `parity-waves` at
`8f529920`
**Artifact under test:** `release/mac-arm64/Plainsong.app`, an **unsigned
`--dir` pack**. Not a release artifact. A signed, notarized `release:mac`
bundle carries signatures and a stapled ticket and will read slightly larger.

## How the build was produced, and one thing that is not the standard command

The brief asks for `bun run electron:pack`. That script is

    sidecar:build:release && shortcut-helper:build && calendar-helper:build
      && language-model-helper:build && build:renderer && build:electron
      && build-electron-release.mjs pack

and it was run in that form first. Two things came out of it that the numbers
below depend on, so both are stated rather than smoothed over.

1. **The cargo step was run once and then skipped.** With the shared
   `CARGO_TARGET_DIR` every lane is told to use, `sidecar:build:release` blocks
   on another lane's artifact lock and, when it gets in, rebuilds whatever that
   lane invalidated — ten minutes per pack, against a sidecar this lane does
   not change. So `plainsong-sidecar` and `plainsong-cli` were built once from
   this worktree's source (cargo `Finished release profile in 10m 11s`,
   `plainsong-sidecar` sha256
   `6a877d0735a292d2a40aff48080ea1b35af8b5bcdf703f0b6658a5714548383c`), copied
   into this worktree's own `rust-sidecar/target/release/`, and every pack in
   this receipt used those exact bytes. Both audits that step runs after cargo
   were run separately and passed: `verify-macos-system-audio.mjs`
   (`"pass":true`, `processTapImports":"dynamic-only"`) and
   `verify-macos-speech-helper.mjs` (`"pass":true`, deployment target 13.0,
   arm64). Every other step of `electron:pack` ran normally for every build
   below.

2. **`electron:pack` cannot finish on this machine, before or after any change
   in this lane.** Its `afterPack` hook fails with

       Packaged native helper verification failed:
       plainsong CLI has no readable entitlement property list

   `scripts/verify-packaged-native-helpers.mjs` requires each helper's
   signature to carry an entitlements plist. A `--dir` pack signs nothing, and
   `codesign -d --entitlements` on the linker's ad-hoc signature emits no
   plist, so the check cannot pass without `scripts/sign-macos.mjs`, i.e.
   without `release:mac` and credentials. This is pre-existing and unrelated to
   this lane — `plainsong-cli` is not in the `0.9.0-beta.3` bundle in the main
   checkout at all, so this gate has probably never run against it in an
   unsigned pack. **The failure is after the bundle is assembled**: the hook
   fires from `emitAfterPack`, so `Plainsong.app` on disk is complete, and it
   was verified complete each time (asar, sidecar, all three native helpers,
   framework). Only `app-update.yml`, which the publish step writes, is absent.

No signing prompt appeared at any point. No `electron-builder` process from
another lane was running during any of these packs (`pgrep -f
electron-builder` checked before each).

## Load caveat — read before quoting a timing number

The machine was shared with other lanes throughout. `uptime` 1-minute load
averages during this work ranged from **29 to 117**. **Every size figure below
is exact and load-independent** — they are file sizes. **Every timing and
memory figure carries its load average inline**, and any run taken above load
~6 is marked provisional. Where a number is provisional it is because a quiet
machine would only make it better, and that is said explicitly.

## Size — before and after

`bun run gate:size` on the same bundle at each step:

| | bytes | MiB | delta |
|---|---:|---:|---|
| Baseline (`parity-waves` @ `8f529920`) | 402,526,694 | 383.88 | — |
| + only the English Chromium locale | 354,435,398 | 338.02 | −48,091,296 (−12.5%) |
| + renderer packages out of `app.asar` | 311,653,390 | 297.22 | −42,782,008 (−12.1%) |
| **Total** | | | **−90,873,304 (−22.6%)** |

The `codeCache` change adds 1,085 bytes to `app.asar` (a comment and a flag);
the final bundle is 311,654,475 bytes / 297.22 MiB.

### Where the bundle's weight is, baseline → after

`du -sk`, both bundles measured the same way from the preserved copies:

| | baseline | after | |
|---|---:|---:|---|
| `Contents/Frameworks` | 282,056 KB | 234,320 KB | Electron |
| `Contents/Resources` | 111,876 KB | 70,100 KB | ours + attributions |
| `Contents/MacOS` | 36 KB | 36 KB | launcher stub |
| `Electron Framework.framework` | 280,472 KB | 232,736 KB | 76% of the bundle |
|  · `Electron Framework` (binary) | 187,700 KB | 187,700 KB | untouchable |
|  · `Resources` | 67,024 KB | 19,288 KB | the locales were here |
|  · `Libraries` | 24,564 KB | 24,564 KB | see below |
|  · `Helpers` | 1,184 KB | 1,184 KB | crashpad |
| framework `.lproj` directories | 220 (48,288 KB) | 1 (552 KB) | `en.lproj` |
| `app.asar` | 47,061,399 B | 4,280,476 B | |

### Files over 1 MB under `Resources`, after

| | |
|---|---|
| `sidecar/plainsong-sidecar` | 39.02 MB |
| `LICENSES.chromium.html` | 19.03 MB |
| `app.asar` | 4.08 MB |
| `sidecar/plainsong-cli` | 2.49 MB |
| `icon.icns` | 2.03 MB |
| `THIRD-PARTY-NOTICES.txt` | 1.16 MB |

### Inside `app.asar`

| | baseline | after |
|---|---:|---:|
| payload | 42.90 MB | 4.00 MB |
| files | 7,916 | 340 |
| `node_modules` | 40.90 MB, 79 packages | 1.99 MB, 16 packages |
| `dist` (the renderer Vite built) | 1.68 MB | 1.68 MB |
| `dist-electron` (the main process) | 0.31 MB | 0.31 MB |

The four heaviest things in the baseline archive were `lucide-react`
(18.90 MB), `@base-ui/react` (8.10 MB), `react-dom` (6.98 MB) and
`tailwind-merge` (0.84 MB) — every one of them already compiled into the
1.68 MB `dist` beside them. The 16 packages that remain are electron-updater
and its dependency closure, which the main process genuinely loads.

## What was checked and deliberately not changed

- **Fonts.** Eight `.woff2` files in `src/assets/fonts`, and `src/index.css`
  has exactly eight `@font-face` rules pointing at them, one each. Nothing to
  trim; no change.
- **Duplicated assets in `dist/`.** 51 files, 1.68 MB, largest is a 214 KB JS
  chunk. Vite emits hashed chunks and the eight fonts once each. `Logo.png`
  (91 KB) is the only `public/` asset. No duplication; no change.
- **Source maps, tests, fixtures, docs.** `vite.config.ts` already sets
  `sourcemap: false`, and `tsconfig.electron.json` emits none, so
  `!dist-electron/preload.js.map` in `files` is matching a file that no longer
  exists. electron-builder already drops `README`, `CHANGELOG`, `test`,
  `tests`, `__tests__`, `example`, `examples` and `*.d.ts` from every packed
  package by default. Nothing left to exclude; no change.
- **`Electron Framework.framework/Versions/A/Libraries` (24 MB).**
  `libvk_swiftshader.dylib` alone is 16 MB, Chromium's software Vulkan
  fallback for machines whose GPU is blocklisted. electron-builder exposes no
  option to exclude it, and deleting a file inside a framework bundle
  invalidates a signature that notarization cannot walk back. **Cannot be
  removed safely.** Same for `libGLESv2.dylib` (5.9 MB) and `libffmpeg.dylib`
  (2.1 MB).
- **`LICENSES.chromium.html` (19 MB).** Chromium's licences require it to be
  distributed with the binary. Stays.
- **The 182 MB `Electron Framework` binary.** Nothing here can touch it. It is
  now 61% of the installed application and is the whole of the case for the
  Tauri migration.

## Disk image compression

Measured with `hdiutil` on the trimmed 297 MB `Plainsong.app`, one source
folder, four formats, `-imagekey <codec>-level=9` in each case:

| format | bytes | vs default |
|---|---:|---|
| UDZO (electron-builder's default, zlib) | 132,494,542 | — |
| ULFO (lzfse) | 129,218,471 | −2.5% |
| UDBZ (bzip2) | 121,123,816 | −8.6% |
| ULMO (lzma) | 97,964,404 | −26.1% |

**ULMO is the best and is unusable.** electron-builder 26.15.3's configuration
schema enumerates `UDBZ, UDCO, UDRO, UDRW, UDZO, ULFO` and rejects
`dmg.format: ULMO` before packaging starts. That was found by setting it and
running the pack, not by reading documentation. The format itself is sound —
the vendored `dmgbuild` (dmg-builder@1.2.5) maps ULMO to `-imagekey
lzma-level=`, hdiutil accepted it, and the resulting image attached read-only
with its `Plainsong.app` intact at 297 MB. **34 MB is left on the table** until
electron-builder widens that enum.

**ULFO was taken.** Of the allowed formats it is the only one better than the
default on both axes: lzfse packs smaller than zlib *and* decodes faster, so
the download shrinks and the drag to `/Applications` speeds up. UDBZ saves
8 MB more, but bzip2 decompresses several times slower than zlib — that cost
lands in the one visible moment of installing, to save roughly four seconds of
download on a 20 Mbit line. A trade, not a win. lzfse has been mountable since
macOS 10.11 against this bundle's 13.0 floor; the ULFO image was attached
read-only and read back whole before being detached.

**Not verified:** electron-builder's dmg target end-to-end. It signs and
notarizes and this machine has no credentials. `bun run electron:pack` was
re-run after the change, so the configuration validates and packs; the first
`release:mac` after this change must confirm a DMG was produced and mounts
before anything is distributed.

## Startup

**The quiet machine never came.** The 1-minute load average was sampled every
60 seconds for 40 minutes waiting to drop under 6; it ranged 29–165 and never
went below 29. Every number here was taken at a load average above 100, and
that is stated per run rather than averaged away.

`bun run gate:cold-start`'s exact invocation — 2,500 ms threshold, fresh
`--isolate-plainsong-data` profile every run, ready when the app prints
`App rendered` — six runs per bundle, the two bundles interleaved in sets of
three:

| run | baseline (383.88 MB) | after (297.22 MB) |
|---|---:|---:|
| 1 | 1,574 ms (load 126.6) | 1,093 ms (load 120.3) |
| 2 | 727 ms (load 124.5) | 608 ms (load 119.2) |
| 3 | 728 ms (load 126.3) | 978 ms (load 119.2) |
| 4 | 1,089 ms (load 114.4) | 970 ms (load 109.0) |
| 5 | 734 ms (load 110.0) | 852 ms (load 109.5) |
| 6 | 608 ms (load 109.0) | 732 ms (load 109.1) |
| median | **730 ms** | **911 ms** |
| range | 608–1,574 | 608–1,093 |

**Read this as "no measurable change", not as a 180 ms regression.** Each
bundle's own spread is wider than the gap between their medians, the baseline's
own fastest and slowest runs differ by 2.6×, and there is no mechanism by which
deleting files that were never opened would slow a launch. What the table does
establish is the thing worth knowing: **every run of both bundles passed the
2,500 ms gate, on a machine carrying a load average above 100** — the shipped
gate has a wide margin even under abuse.

### V8 snapshot and bytecode cache — tried, measured, not kept

Electron 43 already loads its own `v8_context_snapshot.arm64.bin`; a *custom*
app snapshot means `electron/mksnapshot` and restructuring the main-process
entry, which is not a bounded reversible change and was not attempted. There
are no relevant `app.commandLine` switches; the one real option is Chromium's
V8 code cache, which is automatic for `http(s)` and has to be asked for on a
custom scheme — and the whole renderer is served over `plainsong://`. So
`codeCache: true` was added to `registerSchemesAsPrivileged`, packed, and
measured.

**It works and it does not help.** With the flag, a profile's
`Code Cache/js` grows from 8 KB / 5 files to 668–812 KB / 25 files, so
Chromium is genuinely caching the renderer's compiled bytecode. Interleaved
warm-start A/B, each build with its own profile primed by one throwaway launch,
six alternating rounds:

| round | `codeCache` off | `codeCache` on | load1 |
|---|---:|---:|---:|
| 1 | 849 ms | 736 ms | 96.9 |
| 2 | 737 ms | 975 ms | 99.6 |
| 3 | 853 ms | 982 ms | 114.7 |
| 4 | 972 ms | 974 ms | 124.5 |
| 5 | 850 ms | 1,592 ms | 135.0 |
| 6 | 2,221 ms | 2,217 ms | 146.1 |
| median | **851 ms** | **978 ms** | |

Not one round favours it by more than noise, and the median is worse. That is
what you would expect from the size of the thing being cached: the renderer is
~700 KB of JS across lazy chunks, whose parse and compile is tens of
milliseconds, against the cost of reading and deserializing the cache from a
contended disk. **Reverted.** The finding is worth keeping even though the
change was not: the option exists, it functions, and at this bundle size it
buys nothing. Revisit if the renderer bundle grows several-fold.

`backgroundThrottling` on the hidden overlays was left alone, as instructed —
nothing measured here says otherwise.

## Idle memory

**This measurement could not be made honestly on this machine, and the attempt
is written up rather than a number.**

Method: launch the packaged bundle with an isolated data directory and profile,
leave it idle 60 s, then read `ps -o rss` and `top`'s `MEM` (phys_footprint,
the number Activity Monitor shows) for all eight processes.

The machine was swapping hard throughout — `vm.swapusage` showed **6,819 MB of
8,192 MB used**, `vm_stat` 11,916–13,254 free pages (~200 MB), 35% system-wide
free. Under that pressure resident-set size reports how much the kernel is
letting a process keep, not how much it wants:

| bundle | time | total RSS |
|---|---|---:|
| baseline | 21:23 | 254,016 K |
| after | 21:25 | 484,160 K |
| baseline | 21:26 | 259,616 K |
| after | 21:27 | 546,976 K |
| baseline | 21:29 | 206,912 K |
| after | 21:30 | 323,056 K |
| baseline | 21:32 | 170,832 K |
| baseline | 21:33 | 352,304 K |
| after | 21:35 | 444,016 K |
| baseline | 21:36 | 480,272 K |

The same baseline bundle read 171 MB and 480 MB thirteen minutes apart. Any
"after is heavier" reading of the first six rows is an artifact of when each
run happened to land.

phys_footprint separates the signal. Across the three runs that captured it,
**the entire difference is the GPU helper**, whose footprint swings between
144 MB and 237 MB run to run *within the same bundle*:

| | baseline 21:33 | after 21:35 | baseline 21:36 |
|---|---:|---:|---:|
| main (browser) | 63,488 K | 57,344 K | 68,608 K |
| renderer ×3 | 92,160 K | 94,208 K | 98,304 K |
| GPU helper | 144,384 K | 232,448 K | 236,544 K |
| NetworkService | 7,809 K | 7,841 K | 7,793 K |
| Rust sidecar | 11,264 K | 9,825 K | 10,240 K |
| shortcut helper | 2,320 K | 3,249 K | 2,288 K |
| **total, GPU excluded** | **177,041 K** | **172,467 K** | **187,233 K** |

Everything that is not the GPU process is flat: the trimmed bundle's 172 MB
sits at the bottom of the baseline's own 177–187 MB band, and the Rust
sidecar, NetworkService and shortcut helper are unchanged to within a few
hundred KB. **The honest conclusion is that idle memory is unchanged**, which
is also the only physically sensible one — the change deletes files that were
never opened. A quiet-machine re-run is owed before any of these figures is
quoted as Plainsong's idle memory, and the "1.9 MB idle RSS on the sidecar"
that `docs/competitive-positioning.md` used to carry is not reproducible here
(the sidecar reads 10–15 MB RSS / ~10 MB footprint) and should be re-measured
before it is used again.

## Still owed

- A quiet-machine re-run of startup and idle memory (`uptime` 1-minute load
  under 6), and of the sidecar's idle RSS specifically.
- The first `release:mac` after this lane must confirm the DMG builds with
  `format: ULFO`, is signed and notarized, and mounts.
- `dmg.format: ULMO` is worth another 34 MB whenever electron-builder's schema
  accepts it.
- `scripts/verify-packaged-native-helpers.mjs` cannot pass on an unsigned
  `--dir` pack because the `plainsong` CLI carries no entitlements plist
  without `sign-macos.mjs`. Either the hook should skip the entitlement checks
  when nothing in the bundle is signed, or `electron:pack` should be documented
  as a build that always ends in that error. Out of this lane's scope, but it
  makes `electron:pack` unusable as a green gate.
