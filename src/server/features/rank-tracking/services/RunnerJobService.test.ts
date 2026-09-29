import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerResult } from "@/types/schemas/runner";
import { RunnerJobService } from "./RunnerJobService";

type NewJobRow = {
  id: string;
  runId: string;
  configId: string;
  trackingKeywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  includeLocalPack: boolean;
};

const jobMocks = vi.hoisted(() => ({
  createJobs: vi.fn<(rows: NewJobRow[]) => Promise<void>>(),
  claimJobs: vi.fn(),
  getClaimedJob: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  releaseExpiredClaims: vi.fn(),
  countJobsByStatusForRun: vi.fn(),
  getRunnerHeartbeat: vi.fn(),
  markConfigChecked:
    vi.fn<
      (
        configId: string,
        input: { lastCheckedAt: string; nextCheckAt: string | null },
      ) => Promise<void>
    >(),
  upsertRunnerHeartbeat: vi.fn(),
}));

const trackingMocks = vi.hoisted(() => ({
  tryCreateRun: vi.fn(),
  updateRun: vi.fn(),
  insertSnapshots: vi.fn(),
  getKeywordsForConfig: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankCheckJobRepository",
  () => ({ RankCheckJobRepository: jobMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: trackingMocks }),
);

const scopeOrgA = { organizationIds: ["orgA"] };

const claimedJob = {
  id: "job_1",
  runId: "run_1",
  configId: "cfg_1",
  trackingKeywordId: "kw_1",
  keyword: "税理士",
  device: "desktop" as const,
  includeLocalPack: false,
  status: "claimed" as const,
  scheduleInterval: "weekly" as const,
  targetDomain: "acme.com",
  languageCode: "ja",
  locationCode: 2392,
  locationName: null,
  serpDepth: 20,
};

const okResult: RunnerResult = {
  jobId: "job_1",
  status: "ok",
  position: 3,
  url: "https://acme.com/x",
  serpFeatures: ["organic"],
  localPackPosition: null,
  errorMessage: null,
};

beforeEach(() => {
  jobMocks.countJobsByStatusForRun.mockResolvedValue({
    open: 1,
    done: 1,
    failed: 0,
  });
});

describe("RunnerJobService.submitResults", () => {
  it("writes a snapshot and marks the job done for an ok result", async () => {
    jobMocks.getClaimedJob.mockResolvedValue(claimedJob);
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(trackingMocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: "run_1",
        trackingKeywordId: "kw_1",
        keyword: "税理士",
        device: "desktop",
        provider: "runner",
        position: 3,
        localPackPosition: null,
        serpFeatures: JSON.stringify(["organic"]),
      }),
    ]);
    expect(jobMocks.markJobDone).toHaveBeenCalledWith("job_1");
  });

  it("rejects a result for a job outside the caller's org scope", async () => {
    jobMocks.getClaimedJob.mockResolvedValue(undefined);
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out).toEqual({ accepted: 0, rejected: 1 });
    expect(trackingMocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("is idempotent: a job no longer claimed is rejected without writes", async () => {
    jobMocks.getClaimedJob.mockResolvedValue({
      ...claimedJob,
      status: "done" as const,
    });
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out.rejected).toBe(1);
    expect(trackingMocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("marks the job failed for an error result", async () => {
    jobMocks.getClaimedJob.mockResolvedValue(claimedJob);
    const out = await RunnerJobService.submitResults(scopeOrgA, [
      { ...okResult, status: "error", position: null, errorMessage: "captcha" },
    ]);
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(jobMocks.markJobFailed).toHaveBeenCalledWith("job_1", "captcha");
    expect(trackingMocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("completes the run and stamps the config when the last job finishes", async () => {
    jobMocks.getClaimedJob.mockResolvedValue(claimedJob);
    jobMocks.countJobsByStatusForRun.mockResolvedValue({
      open: 0,
      done: 4,
      failed: 0,
    });
    await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(trackingMocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "completed", keywordsChecked: 4 }),
    );
    expect(jobMocks.markConfigChecked).toHaveBeenCalledTimes(1);
    const [stampedConfigId, stamp] = jobMocks.markConfigChecked.mock.calls[0];
    expect(stampedConfigId).toBe("cfg_1");
    expect(typeof stamp.nextCheckAt).toBe("string");
  });

  it("marks the run failed when all jobs terminated but some failed", async () => {
    jobMocks.getClaimedJob.mockResolvedValue(claimedJob);
    jobMocks.countJobsByStatusForRun.mockResolvedValue({
      open: 0,
      done: 3,
      failed: 1,
    });
    await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(trackingMocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "failed" }),
    );
  });
});

describe("RunnerJobService.startRunnerRun", () => {
  it("creates a run and one job per keyword x device", async () => {
    trackingMocks.tryCreateRun.mockResolvedValue(true);
    trackingMocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "税理士" },
      { id: "kw_2", keyword: "会計士" },
    ]);
    const out = await RunnerJobService.startRunnerRun({
      config: {
        id: "cfg_1",
        domain: "acme.com",
        languageCode: "ja",
        locationCode: 2392,
        locationName: null,
        devices: "both",
        serpDepth: 20,
        scheduleInterval: "weekly",
        trackLocalPack: true,
      },
      projectId: "p1",
    });
    expect(out).toHaveProperty("runId");
    const rows = jobMocks.createJobs.mock.calls[0][0];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      device: "desktop",
      includeLocalPack: true,
      keyword: "税理士",
      trackingKeywordId: "kw_1",
    });
  });

  it("reports already_running when the run slot is taken", async () => {
    trackingMocks.tryCreateRun.mockResolvedValue(false);
    trackingMocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "税理士" },
    ]);
    const out = await RunnerJobService.startRunnerRun({
      config: {
        id: "cfg_1",
        domain: "acme.com",
        languageCode: "ja",
        locationCode: 2392,
        locationName: null,
        devices: "desktop",
        serpDepth: 20,
        scheduleInterval: "weekly",
        trackLocalPack: false,
      },
      projectId: "p1",
    });
    expect(out).toEqual({ error: "already_running" });
    expect(jobMocks.createJobs).not.toHaveBeenCalled();
  });
});

describe("RunnerJobService.recordHeartbeat", () => {
  it("upserts per org, and under 'selfhost' for a token scope", async () => {
    await RunnerJobService.recordHeartbeat(scopeOrgA, "idle");
    expect(jobMocks.upsertRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "orgA", status: "idle" }),
    );
    await RunnerJobService.recordHeartbeat(
      { organizationIds: null },
      "cooldown",
    );
    expect(jobMocks.upsertRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "selfhost",
        status: "cooldown",
      }),
    );
  });
});
