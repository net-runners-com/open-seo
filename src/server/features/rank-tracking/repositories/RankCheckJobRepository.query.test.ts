import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as RankCheckJobRepositoryModule from "./RankCheckJobRepository";

// Real in-memory SQLite so the claim queue's org scoping, oldest-first
// ordering, double-claim protection, and expired-claim release run against
// actual SQL — the parts mocked service tests can't see.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let RankCheckJobRepository: typeof RankCheckJobRepositoryModule.RankCheckJobRepository;

const T0 = "2026-09-29T00:00:00.000Z";

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT
    );
    CREATE TABLE rank_tracking_configs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      devices TEXT NOT NULL DEFAULT 'both',
      serp_depth INTEGER NOT NULL,
      schedule_interval TEXT NOT NULL DEFAULT 'weekly',
      location_name TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      next_check_at TEXT,
      last_skip_reason TEXT,
      provider TEXT NOT NULL DEFAULT 'dataforseo',
      track_local_pack INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      keywords_total INTEGER NOT NULL DEFAULT 0,
      keywords_checked INTEGER NOT NULL DEFAULT 0,
      is_subset_run INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE rank_check_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      tracking_keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      device TEXT NOT NULL,
      include_local_pack INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE runner_heartbeats (
      organization_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);

  ({ RankCheckJobRepository } = await import("./RankCheckJobRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM rank_check_jobs;
    DELETE FROM rank_check_runs;
    DELETE FROM rank_tracking_configs;
    DELETE FROM projects;
    DELETE FROM runner_heartbeats;
  `);
  await client.executeMultiple(`
    INSERT INTO projects (id, organization_id, name) VALUES
      ('proj_a', 'orgA', 'A'),
      ('proj_b', 'orgB', 'B');
    INSERT INTO rank_tracking_configs
      (id, project_id, domain, location_code, language_code, devices,
       serp_depth, location_name, provider, track_local_pack)
    VALUES
      ('cfg_a', 'proj_a', 'acme.com', 2392, 'ja', 'both', 20, '東京都新宿区', 'runner', 1),
      ('cfg_b', 'proj_b', 'other.com', 2840, 'en', 'desktop', 20, NULL, 'runner', 0);
    INSERT INTO rank_check_runs (id, config_id, project_id, status) VALUES
      ('run_1', 'cfg_a', 'proj_a', 'running'),
      ('run_2', 'cfg_b', 'proj_b', 'running');
    INSERT INTO rank_check_jobs
      (id, run_id, config_id, tracking_keyword_id, keyword, device,
       include_local_pack, status, attempts, claimed_at, created_at)
    VALUES
      ('job_a1', 'run_1', 'cfg_a', 'kw_1', '税理士', 'desktop', 1, 'pending', 0, NULL, '2026-09-28T00:00:01.000Z'),
      ('job_a2', 'run_1', 'cfg_a', 'kw_1', '税理士', 'mobile',  1, 'pending', 0, NULL, '2026-09-28T00:00:02.000Z'),
      ('job_b1', 'run_2', 'cfg_b', 'kw_2', 'plumber', 'desktop', 0, 'pending', 0, NULL, '2026-09-28T00:00:03.000Z');
  `);
});

describe("RankCheckJobRepository.claimJobs", () => {
  it("claims only pending jobs for the caller's organizations, oldest first", async () => {
    const claimed = await RankCheckJobRepository.claimJobs({
      organizationIds: ["orgA"],
      limit: 10,
      nowIso: T0,
    });
    expect(claimed.map((j) => j.id)).toEqual(["job_a1", "job_a2"]);
    expect(claimed[0].status).toBe("claimed");
    expect(claimed[0].targetDomain).toBe("acme.com");
    expect(claimed[0].locationName).toBe("東京都新宿区");
    expect(claimed[0].scheduleInterval).toBe("weekly");
    expect(claimed[0].includeLocalPack).toBe(true);
  });

  it("claims across all orgs when organizationIds is null (selfhost token)", async () => {
    const claimed = await RankCheckJobRepository.claimJobs({
      organizationIds: null,
      limit: 10,
      nowIso: T0,
    });
    expect(claimed).toHaveLength(3);
  });

  it("does not claim an already-claimed job twice", async () => {
    await RankCheckJobRepository.claimJobs({
      organizationIds: null,
      limit: 1,
      nowIso: T0,
    });
    const second = await RankCheckJobRepository.claimJobs({
      organizationIds: null,
      limit: 10,
      nowIso: T0,
    });
    expect(second.map((j) => j.id)).not.toContain("job_a1");
    expect(second).toHaveLength(2);
  });
});

describe("RankCheckJobRepository.getClaimedJob", () => {
  it("hides jobs outside the caller's org scope", async () => {
    await RankCheckJobRepository.claimJobs({
      organizationIds: null,
      limit: 10,
      nowIso: T0,
    });
    const visible = await RankCheckJobRepository.getClaimedJob("job_b1", [
      "orgB",
    ]);
    expect(visible?.id).toBe("job_b1");
    const hidden = await RankCheckJobRepository.getClaimedJob("job_b1", [
      "orgA",
    ]);
    expect(hidden).toBeUndefined();
  });
});

describe("RankCheckJobRepository.releaseExpiredClaims", () => {
  it("returns old claims to pending and fails jobs at maxAttempts", async () => {
    await client.executeMultiple(`
      UPDATE rank_check_jobs SET status='claimed', attempts=1,
        claimed_at='2026-09-29T00:00:00.000Z' WHERE id='job_a1';
      UPDATE rank_check_jobs SET status='claimed', attempts=3,
        claimed_at='2026-09-29T00:00:00.000Z' WHERE id='job_a2';
      UPDATE rank_check_jobs SET status='claimed', attempts=1,
        claimed_at='2026-09-29T00:59:00.000Z' WHERE id='job_b1';
    `);
    const { releasedRunIds } =
      await RankCheckJobRepository.releaseExpiredClaims({
        cutoffIso: "2026-09-29T00:30:00.000Z",
        maxAttempts: 3,
      });
    expect(releasedRunIds).toEqual(["run_1"]);

    const rows = await client.execute(
      "SELECT id, status, claimed_at, last_error FROM rank_check_jobs ORDER BY id",
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get("job_a1")?.status).toBe("pending");
    expect(byId.get("job_a1")?.claimed_at).toBeNull();
    expect(byId.get("job_a2")?.status).toBe("failed");
    expect(byId.get("job_a2")?.last_error).toBe("claim expired");
    expect(byId.get("job_b1")?.status).toBe("claimed"); // 期限内は触らない
  });
});

describe("RankCheckJobRepository.countJobsByStatusForRun", () => {
  it("buckets pending+claimed as open", async () => {
    await client.executeMultiple(`
      UPDATE rank_check_jobs SET status='done' WHERE id='job_a1';
      UPDATE rank_check_jobs SET status='claimed' WHERE id='job_a2';
    `);
    const counts =
      await RankCheckJobRepository.countJobsByStatusForRun("run_1");
    expect(counts).toEqual({ open: 1, done: 1, failed: 0 });
  });
});

describe("RankCheckJobRepository heartbeats", () => {
  it("upserts and reads back the latest heartbeat", async () => {
    await RankCheckJobRepository.upsertRunnerHeartbeat({
      organizationId: "orgA",
      status: "idle",
      lastSeenAt: T0,
    });
    await RankCheckJobRepository.upsertRunnerHeartbeat({
      organizationId: "orgA",
      status: "cooldown",
      lastSeenAt: "2026-09-29T01:00:00.000Z",
    });
    const hb = await RankCheckJobRepository.getRunnerHeartbeat("orgA");
    expect(hb).toEqual({
      status: "cooldown",
      lastSeenAt: "2026-09-29T01:00:00.000Z",
    });
  });
});
