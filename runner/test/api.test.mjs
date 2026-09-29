import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../lib/api.mjs";

let calls;
beforeEach(() => {
  calls = [];
});

function stubFetch(responses) {
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

const client = () =>
  createApiClient({ serverOrigin: "https://app.example.com", token: "oseo_k" });

test("claimJobs GETs /api/runner/jobs with the bearer token", async () => {
  stubFetch([{ status: 200, body: { jobs: [{ id: "j1" }] } }]);
  const jobs = await client().claimJobs(10);
  assert.deepEqual(jobs, [{ id: "j1" }]);
  assert.equal(calls[0].url, "https://app.example.com/api/runner/jobs?limit=10");
  assert.equal(calls[0].init.headers.Authorization, "Bearer oseo_k");
});

test("submitResults POSTs in chunks of at most 50", async () => {
  stubFetch([{ status: 200, body: { accepted: 50, rejected: 0 } }]);
  const results = Array.from({ length: 60 }, (_, i) => ({ jobId: `j${i}` }));
  await client().submitResults(results);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).results.length, 50);
  assert.equal(JSON.parse(calls[1].init.body).results.length, 10);
});

test("non-2xx responses throw", async () => {
  stubFetch([{ status: 401, body: { error: "unauthorized" } }]);
  await assert.rejects(() => client().claimJobs(5), /401/);
});
