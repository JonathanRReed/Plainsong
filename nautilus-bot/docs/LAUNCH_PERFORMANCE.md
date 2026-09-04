# Launch performance receipts

Plainsong has two launch measurements. They answer different questions.

`bun run gate:process-start-diagnostic` starts the packaged executable directly
and stops when the renderer schedules its React root. Keep it for quick source
diagnosis. It does not measure LaunchServices, first paint, or interactivity.

`bun run gate:packaged:macos:launch-performance` starts the arm64 `.app` through
macOS LaunchServices with `open -na`. Typed renderer acknowledgements record the
first post-commit frame, first contentful paint, and first interactive workspace
or setup dialog. `--verify-dom-contract` reserves the existing inherited private
CDP transport for a separate DOM cross-check. LaunchServices cannot carry those
file descriptors into the app, so the measured run never opens a debugging port.

The packaged gate defaults to a fresh isolated profile and a 1,500 ms
interactive threshold. A warm run must name a profile previously primed by the
same candidate:

```sh
node scripts/capture-packaged-macos-launch-performance.mjs \
  --profile-condition warm \
  --profile-root /private/tmp/plainsong-launch-profile
```

`--diagnostic-allow-unqualified` changes only the process exit decision. The
receipt still records separate `timingPass`, `trustPass`, and
`releaseQualifiedPass` values. Without that flag, Developer ID signing,
notarization, stapling, arm64 architecture, and latency must all pass.

Run the release gate only against the exact signed, notarized, and stapled
candidate. The JSON receipt records the source SHA, executable hash, code-signing
assessment, architecture, macOS and hardware identity, display refresh rate,
load average, profile condition, DOM timings, and raw structured milestones.
The gate reports failed signing evidence instead of treating an unsigned local
package as a release result.
