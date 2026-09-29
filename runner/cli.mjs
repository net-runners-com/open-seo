#!/usr/bin/env node
// OpenSEO self-hosted rank runner.
// Usage: node runner/cli.mjs --server https://app.example.com --key oseo_xxx
// Env fallback: OPENSEO_SERVER / OPENSEO_RUNNER_KEY. --headed shows the browser.
import { launch } from "cloakbrowser";
import { createApiClient } from "./lib/api.mjs";
import { executeJob, CaptchaError } from "./lib/scrape.mjs";

const CLAIM_BATCH = 10;
const RESULTS_FLUSH = 20;
const IDLE_SLEEP_MS = 60_000;
const IDLE_JITTER_MS = 15_000;
const JOB_SLEEP_MIN_MS = 10_000;
const JOB_SLEEP_MAX_MS = 30_000;
const COOLDOWN_MS = 45 * 60_000;
const QUERIES_PER_SESSION = 30;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const serverOrigin = arg("server") ?? process.env.OPENSEO_SERVER;
const token = arg("key") ?? process.env.OPENSEO_RUNNER_KEY;
const headed = process.argv.includes("--headed");
if (!serverOrigin || !token) {
  console.error(
    "usage: node cli.mjs --server <origin> --key <api key or RUNNER_TOKEN> [--headed]",
  );
  process.exit(1);
}

const api = createApiClient({ serverOrigin, token });

let stopping = false;
process.on("SIGINT", () => {
  console.log("\n[runner] finishing the current job, then exiting…");
  stopping = true;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (base, spread) => base + Math.floor(Math.random() * spread);

let browser = null;
let sessionQueries = 0;

async function getBrowser() {
  // Restart the browser periodically to rotate the fingerprint.
  if (browser && sessionQueries >= QUERIES_PER_SESSION) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (!browser) {
    browser = await launch({ headless: !headed, humanize: true });
    sessionQueries = 0;
  }
  return browser;
}

async function flush(buffer) {
  if (buffer.length === 0) return;
  const outcome = await api.submitResults(buffer.splice(0));
  console.log(
    `[runner] submitted results: accepted=${outcome.accepted} rejected=${outcome.rejected}`,
  );
}

async function runJob(job) {
  for (;;) {
    try {
      sessionQueries++;
      const result = await executeJob(await getBrowser(), job);
      return { jobId: job.id, ...result };
    } catch (error) {
      if (error instanceof CaptchaError) {
        console.warn(`[runner] captcha hit — cooling down ${COOLDOWN_MS / 60000} min`);
        await api.heartbeat("cooldown").catch(() => {});
        await browser?.close().catch(() => {});
        browser = null;
        await sleep(COOLDOWN_MS);
        if (stopping) throw error;
        continue; // retry the same job with a fresh session
      }
      return {
        jobId: job.id,
        status: "error",
        position: null,
        url: null,
        serpFeatures: [],
        localPackPosition: null,
        errorMessage: String(error?.message ?? error).slice(0, 2000),
      };
    }
  }
}

console.log(`[runner] polling ${serverOrigin}`);
const buffer = [];
while (!stopping) {
  try {
    await api.heartbeat("idle");
    const jobs = await api.claimJobs(CLAIM_BATCH);
    if (jobs.length === 0) {
      await sleep(jitter(IDLE_SLEEP_MS - IDLE_JITTER_MS, IDLE_JITTER_MS * 2));
      continue;
    }
    console.log(`[runner] claimed ${jobs.length} job(s)`);
    await api.heartbeat("scraping");
    for (const job of jobs) {
      if (stopping) break;
      buffer.push(await runJob(job));
      if (buffer.length >= RESULTS_FLUSH) await flush(buffer);
      await sleep(jitter(JOB_SLEEP_MIN_MS, JOB_SLEEP_MAX_MS - JOB_SLEEP_MIN_MS));
    }
    await flush(buffer);
  } catch (error) {
    console.error("[runner] loop error:", error?.message ?? error);
    await sleep(jitter(IDLE_SLEEP_MS, IDLE_JITTER_MS));
  }
}
await flush(buffer).catch(() => {});
await browser?.close().catch(() => {});
console.log("[runner] bye");
