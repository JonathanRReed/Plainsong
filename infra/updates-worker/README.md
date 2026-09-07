# Update feed

Installed apps check `https://updates.plainsong.jonathanrreed.com/<channel>/`
for a new build (`nautilus-bot/electron/updater-channel.ts`). This Cloudflare
Worker answers that host from the public GitHub releases:

- `/beta/beta-mac.yml` is the manifest of the newest pre-release that ships one.
- `/stable/latest-mac.yml` is the manifest of the newest full release, and 404
  until a 1.0 exists.
- Any other file under a channel is proxied from that release's asset, including
  byte-range requests, so downloads remain on the update-feed origin.

Publishing a release on GitHub is the whole deployment; the feed follows it
within ten minutes. To change the Worker itself:

```bash
cd infra/updates-worker
npx wrangler@4 deploy
```

The custom domain is created by the `routes` entry in `wrangler.toml`; it
needs the `jonathanrreed.com` zone on the same Cloudflare account.
