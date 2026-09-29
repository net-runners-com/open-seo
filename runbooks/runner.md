# Self-hosted rank runner (zero-cost rank checks)

The runner is a small CLI (in `runner/`) that polls your OpenSEO server for
queued rank-check jobs, scrapes Google with a stealth browser
([cloakbrowser](https://www.npmjs.com/package/cloakbrowser)), and posts the
results back. Configs with **Data Source: Self-hosted runner** never call
DataForSEO and consume no credits.

## Setup

```bash
cd runner
npm install
```

Requires Node 20+. The stealth Chromium binary downloads automatically on
first launch.

## Run

Hosted (app.openseo.so or your own hosted deployment): create an API key in
Settings (it starts with `oseo_`), then:

```bash
node cli.mjs --server https://app.openseo.so --key oseo_xxxxxxxx
```

Self-host without API keys: set `RUNNER_TOKEN` in the server environment
(`.dev.vars` locally) and pass the same value as `--key`:

```bash
node cli.mjs --server https://seo.example.com --key <RUNNER_TOKEN value>
```

Environment variable fallbacks: `OPENSEO_SERVER`, `OPENSEO_RUNNER_KEY`.
`--headed` shows the browser window.

## Behavior

- Polls `/api/runner/jobs` (10 jobs per claim), sleeps ~60s when idle.
- 10–30s jitter between queries; the browser restarts every 30 queries to
  rotate its fingerprint.
- On a Google captcha the runner reports a `cooldown` heartbeat, sleeps
  45 minutes, and retries. Jobs it holds are reclaimed by the server after
  30 minutes and retried up to 3 times.
- The rank tracking page shows a banner when no heartbeat has arrived for
  30+ minutes.

## One-off check without a server

```bash
node smoke.mjs --keyword "高田馬場 税理士" --domain example.jp \
  --location "東京都新宿区" --local-pack
```

## Limitations

- Local pack matching is by **website link**: a Google Business Profile
  without a website button cannot be matched and reports null.
- One runner per API key/token is assumed; run multiple runners only behind
  the same key if you accept duplicate claims being rejected.
- Keyword search volume/difficulty still requires DataForSEO — the runner
  only covers positions.
