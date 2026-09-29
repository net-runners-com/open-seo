import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRunnerRequest } from "./runner-http";

const mocks = vi.hoisted(() => ({
  claimJobs: vi.fn(),
  submitResults: vi.fn(),
  recordHeartbeat: vi.fn(),
  verifyApiKey: vi.fn(),
  getOrganizationIdsForUser: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { RUNNER_TOKEN: "runtok" },
}));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { verifyApiKey: mocks.verifyApiKey } }),
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: {
    getOrganizationIdsForUser: mocks.getOrganizationIdsForUser,
  },
}));
vi.mock("@/server/features/rank-tracking/services/RunnerJobService", () => ({
  RunnerJobService: {
    claimJobs: mocks.claimJobs,
    submitResults: mocks.submitResults,
    recordHeartbeat: mocks.recordHeartbeat,
  },
}));

const job = {
  id: "job_1",
  runId: "run_1",
  keyword: "税理士",
  device: "desktop",
  includeLocalPack: false,
  targetDomain: "acme.com",
  languageCode: "ja",
  locationCode: 2392,
  locationName: null,
  serpDepth: 20,
};

const okResult = {
  jobId: "job_1",
  status: "ok",
  position: 3,
  url: "https://acme.com/x",
  serpFeatures: ["organic"],
  localPackPosition: null,
  errorMessage: null,
};

function req(path: string, init?: RequestInit) {
  return new Request(`https://app.example.com${path}`, init);
}

describe("handleRunnerRequest", () => {
  beforeEach(() => {
    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { referenceId: "u1" },
    });
    mocks.getOrganizationIdsForUser.mockResolvedValue(["org1"]);
    mocks.claimJobs.mockResolvedValue([job]);
    mocks.submitResults.mockResolvedValue({ accepted: 1, rejected: 0 });
  });

  it("returns null for unrelated paths", async () => {
    expect(await handleRunnerRequest(req("/api/other"))).toBeNull();
  });

  it("401s without a bearer token", async () => {
    const res = await handleRunnerRequest(req("/api/runner/jobs"));
    expect(res?.status).toBe(401);
  });

  it("401s for an invalid api key", async () => {
    mocks.verifyApiKey.mockResolvedValue({ valid: false, key: null });
    const res = await handleRunnerRequest(
      req("/api/runner/jobs", {
        headers: { authorization: "Bearer oseo_bad" },
      }),
    );
    expect(res?.status).toBe(401);
  });

  it("claims jobs with a valid oseo_ key scoped to the key user's orgs", async () => {
    const res = await handleRunnerRequest(
      req("/api/runner/jobs?limit=5", {
        headers: { authorization: "Bearer oseo_abc" },
      }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ jobs: [job] });
    expect(mocks.claimJobs).toHaveBeenCalledWith({ organizationIds: ["org1"] }, 5);
  });

  it("accepts RUNNER_TOKEN and passes the all-orgs scope", async () => {
    const res = await handleRunnerRequest(
      req("/api/runner/jobs", {
        headers: { authorization: "Bearer runtok" },
      }),
    );
    expect(res?.status).toBe(200);
    expect(mocks.claimJobs).toHaveBeenCalledWith(
      { organizationIds: null },
      expect.any(Number),
    );
    expect(mocks.verifyApiKey).not.toHaveBeenCalled();
  });

  it("submits results and 400s on an invalid payload", async () => {
    const ok = await handleRunnerRequest(
      req("/api/runner/results", {
        method: "POST",
        headers: { authorization: "Bearer oseo_abc" },
        body: JSON.stringify({ results: [okResult] }),
      }),
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.json()).toEqual({ accepted: 1, rejected: 0 });

    const bad = await handleRunnerRequest(
      req("/api/runner/results", {
        method: "POST",
        headers: { authorization: "Bearer oseo_abc" },
        body: JSON.stringify({ results: [] }),
      }),
    );
    expect(bad?.status).toBe(400);
  });

  it("records heartbeats with 204", async () => {
    const res = await handleRunnerRequest(
      req("/api/runner/heartbeat", {
        method: "POST",
        headers: { authorization: "Bearer runtok" },
        body: JSON.stringify({ status: "cooldown" }),
      }),
    );
    expect(res?.status).toBe(204);
    expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
      { organizationIds: null },
      "cooldown",
    );
  });

  it("404s unknown runner paths and 405s wrong methods", async () => {
    const notFound = await handleRunnerRequest(
      req("/api/runner/nope", {
        headers: { authorization: "Bearer runtok" },
      }),
    );
    expect(notFound?.status).toBe(404);
    const wrongMethod = await handleRunnerRequest(
      req("/api/runner/jobs", {
        method: "POST",
        headers: { authorization: "Bearer runtok" },
      }),
    );
    expect(wrongMethod?.status).toBe(405);
  });
});
