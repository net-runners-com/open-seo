import {
  RankCheckJobRepository,
  type ClaimedJobRow,
} from "@/server/features/rank-tracking/repositories/RankCheckJobRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  computeNextCheckAt,
  devicesCount,
  isScheduledRankTrackingInterval,
} from "@/shared/rank-tracking";
import type {
  RunnerHeartbeatStatus,
  RunnerJob,
  RunnerResult,
} from "@/types/schemas/runner";

export interface RunnerAuthScope {
  // null = RUNNER_TOKEN auth (self-host): every organization is in scope.
  organizationIds: string[] | null;
}

// Heartbeat row key for token-authenticated (self-host) runners, which have
// no organization of their own.
const SELFHOST_HEARTBEAT_ID = "selfhost";

const CLAIM_LIMIT_MAX = 50;
const CLAIM_TIMEOUT_MS = 30 * 60_000;
const CLAIM_MAX_ATTEMPTS = 3;

interface RunnerRunConfig {
  id: string;
  domain: string;
  languageCode: string;
  locationCode: number;
  locationName: string | null;
  devices: "both" | "desktop" | "mobile";
  serpDepth: number;
  scheduleInterval: "daily" | "weekly" | "monthly" | "manual";
  trackLocalPack: boolean;
}

function toRunnerJob(row: ClaimedJobRow): RunnerJob {
  return {
    id: row.id,
    runId: row.runId,
    keyword: row.keyword,
    device: row.device,
    includeLocalPack: row.includeLocalPack,
    targetDomain: row.targetDomain,
    languageCode: row.languageCode,
    locationCode: row.locationCode,
    locationName: row.locationName,
    serpDepth: row.serpDepth,
  };
}

async function claimJobs(
  scope: RunnerAuthScope,
  limit: number,
): Promise<RunnerJob[]> {
  const clamped = Math.min(
    Math.max(1, Math.trunc(limit) || 1),
    CLAIM_LIMIT_MAX,
  );
  const rows = await RankCheckJobRepository.claimJobs({
    organizationIds: scope.organizationIds,
    limit: clamped,
    nowIso: new Date().toISOString(),
  });
  return rows.map(toRunnerJob);
}

// Close out a run once no job for it is pending or claimed. keywordsChecked
// counts task units (keyword × device), matching keywordsTotal set at start.
async function completeRunIfFinished(job: {
  runId: string;
  configId: string;
  scheduleInterval: RunnerRunConfig["scheduleInterval"];
}): Promise<void> {
  const counts = await RankCheckJobRepository.countJobsByStatusForRun(
    job.runId,
  );
  if (counts.open > 0) return;
  const nowIso = new Date().toISOString();
  await RankTrackingRepository.updateRun(job.runId, {
    status: counts.failed > 0 ? "failed" : "completed",
    ...(counts.failed > 0
      ? { errorMessage: `${counts.failed} runner job(s) failed` }
      : {}),
    keywordsChecked: counts.done,
    completedAt: nowIso,
  });
  await RankCheckJobRepository.markConfigChecked(job.configId, {
    lastCheckedAt: nowIso,
    nextCheckAt: isScheduledRankTrackingInterval(job.scheduleInterval)
      ? computeNextCheckAt(job.scheduleInterval)
      : null,
  });
}

async function submitResults(
  scope: RunnerAuthScope,
  results: RunnerResult[],
): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  const touchedRuns = new Map<
    string,
    {
      runId: string;
      configId: string;
      scheduleInterval: RunnerRunConfig["scheduleInterval"];
    }
  >();

  for (const result of results) {
    const job = await RankCheckJobRepository.getClaimedJob(
      result.jobId,
      scope.organizationIds,
    );
    // Unknown, out-of-scope, or already-settled jobs are skipped: a runner
    // retrying a batch after a network error must not double-write.
    if (!job || job.status !== "claimed") {
      rejected++;
      continue;
    }
    if (result.status === "error") {
      await RankCheckJobRepository.markJobFailed(
        job.id,
        result.errorMessage ?? "runner error",
      );
    } else {
      await RankTrackingRepository.insertSnapshots([
        {
          runId: job.runId,
          trackingKeywordId: job.trackingKeywordId,
          keyword: job.keyword,
          device: job.device,
          position: result.position,
          url: result.url,
          serpFeatures: JSON.stringify(result.serpFeatures),
          localPackPosition: result.localPackPosition,
          provider: "runner",
        },
      ]);
      await RankCheckJobRepository.markJobDone(job.id);
    }
    accepted++;
    touchedRuns.set(job.runId, {
      runId: job.runId,
      configId: job.configId,
      scheduleInterval: job.scheduleInterval,
    });
  }

  for (const run of touchedRuns.values()) {
    await completeRunIfFinished(run);
  }
  return { accepted, rejected };
}

async function recordHeartbeat(
  scope: RunnerAuthScope,
  status: RunnerHeartbeatStatus,
): Promise<void> {
  const lastSeenAt = new Date().toISOString();
  const ids = scope.organizationIds ?? [SELFHOST_HEARTBEAT_ID];
  for (const organizationId of ids) {
    await RankCheckJobRepository.upsertRunnerHeartbeat({
      organizationId,
      status,
      lastSeenAt,
    });
  }
}

async function getRunnerStatus(
  organizationId: string,
): Promise<{ status: RunnerHeartbeatStatus; lastSeenAt: string } | null> {
  // A self-host token runner reports under "selfhost"; show whichever
  // heartbeat is fresher for this workspace.
  const [own, selfhost] = await Promise.all([
    RankCheckJobRepository.getRunnerHeartbeat(organizationId),
    RankCheckJobRepository.getRunnerHeartbeat(SELFHOST_HEARTBEAT_ID),
  ]);
  const newest = [own, selfhost]
    .filter((hb) => hb !== undefined)
    .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  return newest ?? null;
}

async function startRunnerRun(input: {
  config: RunnerRunConfig;
  projectId: string;
  keywordIds?: string[];
}): Promise<{ runId: string } | { error: "already_running" | "no_keywords" }> {
  const { config } = input;
  const keywords = await RankTrackingRepository.getKeywordsForConfig(config.id);
  const selected = input.keywordIds?.length
    ? keywords.filter((kw) => input.keywordIds!.includes(kw.id))
    : keywords;
  if (selected.length === 0) return { error: "no_keywords" };

  const devices: Array<"desktop" | "mobile"> =
    config.devices === "both" ? ["desktop", "mobile"] : [config.devices];

  const runId = crypto.randomUUID();
  const created = await RankTrackingRepository.tryCreateRun({
    id: runId,
    configId: config.id,
    projectId: input.projectId,
    keywordsTotal: selected.length * devicesCount(config.devices),
    isSubsetRun: (input.keywordIds?.length ?? 0) > 0,
  });
  if (!created) return { error: "already_running" };

  await RankCheckJobRepository.createJobs(
    selected.flatMap((kw) =>
      devices.map((device) => ({
        id: crypto.randomUUID(),
        runId,
        configId: config.id,
        trackingKeywordId: kw.id,
        keyword: kw.keyword,
        device,
        includeLocalPack: config.trackLocalPack,
      })),
    ),
  );
  // Jobs are queued and waiting on the runner: the run is in flight now, not
  // pending like a DataForSEO run waiting for its workflow.
  await RankTrackingRepository.updateRun(runId, { status: "running" });
  return { runId };
}

async function reconcileRunnerJobs(nowIso: string): Promise<void> {
  const cutoffIso = new Date(
    new Date(nowIso).getTime() - CLAIM_TIMEOUT_MS,
  ).toISOString();
  const { releasedRunIds } = await RankCheckJobRepository.releaseExpiredClaims({
    cutoffIso,
    maxAttempts: CLAIM_MAX_ATTEMPTS,
  });
  for (const runId of releasedRunIds) {
    // A run whose expired jobs all aged into "failed" must still close.
    const run = await RankTrackingRepository.getRunById(runId);
    if (!run || run.status === "completed" || run.status === "failed") continue;
    const config = await RankTrackingRepository.getConfigById({
      configId: run.configId,
      projectId: run.projectId,
    });
    if (!config) continue;
    await completeRunIfFinished({
      runId,
      configId: run.configId,
      scheduleInterval: config.scheduleInterval,
    });
  }
}

export const RunnerJobService = {
  claimJobs,
  submitResults,
  recordHeartbeat,
  getRunnerStatus,
  startRunnerRun,
  reconcileRunnerJobs,
};
