import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  projects,
  rankCheckJobs,
  rankTrackingConfigs,
  runnerHeartbeats,
} from "@/db/schema";

export interface ClaimedJobRow {
  id: string;
  runId: string;
  configId: string;
  trackingKeywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  includeLocalPack: boolean;
  status: "pending" | "claimed" | "done" | "failed";
  scheduleInterval: "daily" | "weekly" | "monthly" | "manual";
  targetDomain: string;
  languageCode: string;
  locationCode: number;
  locationName: string | null;
  serpDepth: number;
}

const claimedJobColumns = {
  id: rankCheckJobs.id,
  runId: rankCheckJobs.runId,
  configId: rankCheckJobs.configId,
  trackingKeywordId: rankCheckJobs.trackingKeywordId,
  keyword: rankCheckJobs.keyword,
  device: rankCheckJobs.device,
  includeLocalPack: rankCheckJobs.includeLocalPack,
  status: rankCheckJobs.status,
  scheduleInterval: rankTrackingConfigs.scheduleInterval,
  targetDomain: rankTrackingConfigs.domain,
  languageCode: rankTrackingConfigs.languageCode,
  locationCode: rankTrackingConfigs.locationCode,
  locationName: rankTrackingConfigs.locationName,
  serpDepth: rankTrackingConfigs.serpDepth,
};

function jobScopeFilter(organizationIds: string[] | null) {
  return organizationIds === null
    ? undefined
    : inArray(projects.organizationId, organizationIds);
}

async function createJobs(
  rows: Array<{
    id: string;
    runId: string;
    configId: string;
    trackingKeywordId: string;
    keyword: string;
    device: "desktop" | "mobile";
    includeLocalPack: boolean;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(rankCheckJobs).values(rows);
}

async function claimJobs(input: {
  organizationIds: string[] | null;
  limit: number;
  nowIso: string;
}): Promise<ClaimedJobRow[]> {
  // Two-phase claim: D1 has no SELECT FOR UPDATE, so select candidates first,
  // then flip them with a status='pending' guard — concurrent claimers race on
  // the UPDATE and only the winner sees the row in `.returning()`.
  const candidates = await db
    .select({ id: rankCheckJobs.id })
    .from(rankCheckJobs)
    .innerJoin(
      rankTrackingConfigs,
      eq(rankCheckJobs.configId, rankTrackingConfigs.id),
    )
    .innerJoin(projects, eq(rankTrackingConfigs.projectId, projects.id))
    .where(
      and(
        eq(rankCheckJobs.status, "pending"),
        jobScopeFilter(input.organizationIds),
      ),
    )
    .orderBy(asc(rankCheckJobs.createdAt), asc(rankCheckJobs.id))
    .limit(input.limit);
  if (candidates.length === 0) return [];

  const won = await db
    .update(rankCheckJobs)
    .set({
      status: "claimed",
      claimedAt: input.nowIso,
      attempts: sql`${rankCheckJobs.attempts} + 1`,
    })
    .where(
      and(
        inArray(
          rankCheckJobs.id,
          candidates.map((row) => row.id),
        ),
        eq(rankCheckJobs.status, "pending"),
      ),
    )
    .returning({ id: rankCheckJobs.id });
  if (won.length === 0) return [];

  const rows = await db
    .select(claimedJobColumns)
    .from(rankCheckJobs)
    .innerJoin(
      rankTrackingConfigs,
      eq(rankCheckJobs.configId, rankTrackingConfigs.id),
    )
    .where(
      inArray(
        rankCheckJobs.id,
        won.map((row) => row.id),
      ),
    )
    .orderBy(asc(rankCheckJobs.createdAt), asc(rankCheckJobs.id));
  return rows;
}

async function getClaimedJob(
  jobId: string,
  organizationIds: string[] | null,
): Promise<ClaimedJobRow | undefined> {
  const rows = await db
    .select(claimedJobColumns)
    .from(rankCheckJobs)
    .innerJoin(
      rankTrackingConfigs,
      eq(rankCheckJobs.configId, rankTrackingConfigs.id),
    )
    .innerJoin(projects, eq(rankTrackingConfigs.projectId, projects.id))
    .where(
      and(eq(rankCheckJobs.id, jobId), jobScopeFilter(organizationIds)),
    )
    .limit(1);
  return rows[0];
}

async function markJobDone(jobId: string): Promise<void> {
  await db
    .update(rankCheckJobs)
    .set({ status: "done" })
    .where(eq(rankCheckJobs.id, jobId));
}

async function markJobFailed(jobId: string, lastError: string): Promise<void> {
  await db
    .update(rankCheckJobs)
    .set({ status: "failed", lastError })
    .where(eq(rankCheckJobs.id, jobId));
}

async function releaseExpiredClaims(input: {
  cutoffIso: string;
  maxAttempts: number;
}): Promise<{ releasedRunIds: string[] }> {
  const expired = and(
    eq(rankCheckJobs.status, "claimed"),
    lt(rankCheckJobs.claimedAt, input.cutoffIso),
  );
  const failed = await db
    .update(rankCheckJobs)
    .set({ status: "failed", lastError: "claim expired" })
    .where(
      and(expired, sql`${rankCheckJobs.attempts} >= ${input.maxAttempts}`),
    )
    .returning({ runId: rankCheckJobs.runId });
  const released = await db
    .update(rankCheckJobs)
    .set({ status: "pending", claimedAt: null })
    .where(expired)
    .returning({ runId: rankCheckJobs.runId });
  return {
    releasedRunIds: [
      ...new Set([...failed, ...released].map((row) => row.runId)),
    ],
  };
}

async function countJobsByStatusForRun(
  runId: string,
): Promise<{ open: number; done: number; failed: number }> {
  const rows = await db
    .select({
      status: rankCheckJobs.status,
      count: sql<number>`count(*)`,
    })
    .from(rankCheckJobs)
    .where(eq(rankCheckJobs.runId, runId))
    .groupBy(rankCheckJobs.status);
  const counts = { open: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "done") counts.done += Number(row.count);
    else if (row.status === "failed") counts.failed += Number(row.count);
    else counts.open += Number(row.count);
  }
  return counts;
}

async function getRunnerHeartbeat(
  organizationId: string,
): Promise<
  { status: "idle" | "scraping" | "cooldown"; lastSeenAt: string } | undefined
> {
  const rows = await db
    .select({
      status: runnerHeartbeats.status,
      lastSeenAt: runnerHeartbeats.lastSeenAt,
    })
    .from(runnerHeartbeats)
    .where(eq(runnerHeartbeats.organizationId, organizationId))
    .limit(1);
  return rows[0];
}

async function upsertRunnerHeartbeat(input: {
  organizationId: string;
  status: "idle" | "scraping" | "cooldown";
  lastSeenAt: string;
}): Promise<void> {
  await db
    .insert(runnerHeartbeats)
    .values(input)
    .onConflictDoUpdate({
      target: runnerHeartbeats.organizationId,
      set: { status: input.status, lastSeenAt: input.lastSeenAt },
    });
}

export const RankCheckJobRepository = {
  createJobs,
  claimJobs,
  getClaimedJob,
  markJobDone,
  markJobFailed,
  releaseExpiredClaims,
  countJobsByStatusForRun,
  getRunnerHeartbeat,
  upsertRunnerHeartbeat,
};
