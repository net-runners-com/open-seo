import { beforeEach, describe, expect, it, vi } from "vitest";
import { RankTrackingService } from "./RankTrackingService";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  beginRankCheckRun: vi.fn(),
  startRunnerRun: vi.fn(),
  customerHasPaidPlan: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: vi.fn(),
  fetchKeywordMetricsForList: vi.fn(),
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
    },
  }),
);
vi.mock("./rankCheckRunGuards", () => ({
  beginRankCheckRun: mocks.beginRankCheckRun,
  reconcileActiveRankCheckRun: vi.fn(),
}));
vi.mock("./RunnerJobService", () => ({
  RunnerJobService: { startRunnerRun: mocks.startRunnerRun },
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: mocks.customerHasPaidPlan,
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));

const runnerConfig = {
  id: "cfg_1",
  projectId: "p1",
  domain: "acme.com",
  locationCode: 2392,
  languageCode: "ja",
  locationName: null,
  devices: "desktop" as const,
  serpDepth: 20,
  scheduleInterval: "weekly" as const,
  isActive: true,
  provider: "runner" as const,
  trackLocalPack: false,
};

const billingCustomer = {
  userId: "u1",
  userEmail: "u@example.com",
  organizationId: "orgA",
  projectId: "p1",
};

describe("RankTrackingService.triggerCheck with a runner config", () => {
  beforeEach(() => {
    mocks.getConfigById.mockResolvedValue(runnerConfig);
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "税理士" },
    ]);
    mocks.isHostedServerAuthMode.mockResolvedValue(true);
    mocks.customerHasPaidPlan.mockResolvedValue(false);
    mocks.startRunnerRun.mockResolvedValue({ runId: "run_r1" });
  });

  it("queues runner jobs without the workflow or the billing gate", async () => {
    const result = await RankTrackingService.triggerCheck({
      configId: "cfg_1",
      projectId: "p1",
      billingCustomer,
      keywordIds: ["kw_1"],
    });
    expect(result).toEqual({ ok: true, runId: "run_r1" });
    expect(mocks.startRunnerRun).toHaveBeenCalledWith({
      config: runnerConfig,
      projectId: "p1",
      keywordIds: ["kw_1"],
    });
    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    // 0-cost: a free hosted org can still run its self-hosted runner.
    expect(mocks.customerHasPaidPlan).not.toHaveBeenCalled();
  });

  it("maps already_running to the standard trigger result", async () => {
    mocks.startRunnerRun.mockResolvedValue({ error: "already_running" });
    const result = await RankTrackingService.triggerCheck({
      configId: "cfg_1",
      projectId: "p1",
      billingCustomer,
    });
    expect(result).toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: null,
    });
  });
});
