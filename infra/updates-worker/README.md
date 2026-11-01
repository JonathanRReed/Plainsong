# Update feed

Installed apps check `https://updates.plainsong.jonathanrreed.com/<channel>/`
for a new build (`nautilus-bot/electron/updater-channel.ts`). This Cloudflare
Worker answers that host from the public GitHub releases:

- `/beta/beta-mac.yml` is the manifest of the newest pre-release that ships one.
- `/stable/latest-mac.yml` is the manifest of the newest full release, and 404
  until a 1.0 exists.
- Versioned files are located in that channel's release history, including
  byte-range requests. An older cached manifest can finish downloading its ZIP
  after a newer release appears. Downloads remain on the update-feed origin.
  Lookup covers GitHub's newest 20 releases, filtered by channel.
- If the release API fails or returns an unreadable response, beta requests
  use `FALLBACK_BETA_TAG`. Stable requests return 404 without crossing into
  beta. The fallback still requires GitHub's asset downloads to work.

Run the worker's isolated HTTP tests from `nautilus-bot/`:

```bash
node --test --test-concurrency=1 ../infra/updates-worker/test/worker.test.mjs
```

Once this Worker is deployed, publishing a compatible GitHub release makes it
available to the feed. Manifests and release-list responses are cached for ten
minutes. Check the public manifest and download bytes after publication;
installed-version updating requires separate verification. Use the authenticated
Cloudflare `cf` CLI for Worker changes. Check its commands with anonymous
`cf cli search` queries, then the discovered command's `--help`. Never put
account details, domains or credentials in search queries.

```bash
cd infra/updates-worker
cf auth whoami
cf workers deployments list --worker plainsong-updates
```

`cf` 1.0.0-beta.20 does not read this directory's `wrangler.toml`. Do not run
bare `cf deploy` here: automatic configuration can change files and install
packages even with `--dry-run`. First prepare reviewed cf Build Output under
`.cloudflare/output/v0/`, preserving `src/index.js`, the compatibility date,
variables and existing custom domain from `wrangler.toml`. This preparation
remains open for future Worker changes. The October 30 rehearsal of the
following dry run failed because that output does not exist. Read-only retrieval
of active version `0787d629-2232-46dc-81cc-c4b5a363b1fc` matched the current
source bundled with esbuild 0.28.2, excluding only its source-map annotation.
All 13 existing mocked HTTP tests pass against the retrieved module. This
release needs no Worker code deploy for that source. No deployment was attempted.

Once the output exists, validate it without uploading:

```bash
cf deploy --prebuilt --dry-run --tag v0.9.0-beta.7 \
  --message "Prepare beta 7 update Worker"
```

After release authorization, deploy those reviewed inputs, then record the
active deployment and its version allocation:

```bash
cf deploy --prebuilt --provision=false --tag v0.9.0-beta.7 \
  --message "Release beta 7 update Worker"
cf workers deployments list --worker plainsong-updates
```

Save the prior active version allocation before deploying. To restore one
prior version that served 100% of traffic, use the recorded version ID:

```bash
cf workers deployments create --worker plainsong-updates \
  --strategy percentage \
  --versions "[{\"version_id\":\"$WORKER_OLD_VERSION_ID\",\"percentage\":100}]"
```

Add `--dry-run` to inspect the rollback request without sending it. Preserve
all allocations if the prior deployment used multiple versions. Do not bypass
deployment checks. Verify the canonical feed and downloads after any change.
The custom domain requires the `jonathanrreed.com` zone on the same account.
See [cf build and deploy](https://developers.cloudflare.com/cf/projects/) for
Build Output and the automatic-configuration boundary.

The release gate records the beta-only deployment policy in
`nautilus-bot/release-channel-policy.json`. Until the first stable release,
`stableReleaseExists: false` requires the stable manifest's exact URL to return
404. Change it to `true` in reviewed source when stable is published. The gate
then requires a valid stable manifest and rejects prerelease versions. This
config controls verification only; the Worker continues to select releases
from GitHub.
