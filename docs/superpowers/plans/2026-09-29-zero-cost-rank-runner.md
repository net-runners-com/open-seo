# Zero-Cost Rank Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DataForSEO 課金なしでオーガニック順位＋ローカルパック順位を計測する Pull 型ジョブキュー＋同梱 CLI ランナーを追加する。

**Architecture:** cron が provider=runner の設定に対し `rank_check_jobs` 行を作り、同梱 CLI ランナー（`runner/`、Node + cloakbrowser）が `/api/runner/*` をポーリングして claim → スクレイプ → 結果 POST。結果は既存の `rank_snapshots` 保存パスへ流し、既存 DataForSEO パスは無変更。

**Tech Stack:** TypeScript / Drizzle (SQLite+Postgres) / TanStack Start / Cloudflare Workers / Zod / Vitest。ランナー側は Node 20+ ESM / cloakbrowser / linkedom / node:test。

**Spec:** `docs/superpowers/specs/2026-09-29-zero-cost-rank-runner-design.md`

**スペックからの変更（この計画で確定）:** ジョブの `searchType (organic | local_pack)` は廃止。`rank_snapshots` は (runId, trackingKeywordId, device) 一意のため、ローカルパックを別ジョブにすると行が衝突する。代わりにジョブへ `includeLocalPack: boolean` を持たせ、1 ジョブがオーガニック＋（フラグ時）ローカルパックの両方を返す。設定テーブルに `trackLocalPack` トグルを追加。

## Global Constraints

- スキーマ変更は `src/db/app.schema.ts`（SQLite）と `src/db/pg/app.schema.ts`（Postgres）の両方に同一フィールドで入れ、`npm run db:generate` で両 dialect のマイグレーションを生成し、`src/db/schema-parity.test.ts` を通すこと。
- 既存 DataForSEO パス（`fetchRankCheckSerp` / `RankCheckWorkflow` / task-queue）は変更しない。分岐追加のみ。
- ランナー結果では billing 記録を一切作らない。
- 新バックエンド機能は「server function → service → repository」だが、ランナー API はブラウザ外クライアントのため Worker の fetch ハンドラ直下のルート（`/api/runner/*`）とする（`server.ts` の既存分岐スタイルに従う）。
- テスト規約: service テストは repository をフラットな `vi.mock` で差し替え（`RankTrackingService.test.ts` の形式）。SQL を持つ repository は `RankTrackingRepository.query.test.ts` の形式で実 DB 評価。ORM チェーンのモック禁止。
- runner/ は独立 package（Worker バンドル外・knip 対象外）。テストは `node --test`。
- API キー prefix は `oseo_`（`src/lib/auth-api-key.ts` の `API_KEY_PREFIX`）。

## Review Focus

各行のテストは記載タスクに含めてある。

1. **他組織の API キーで結果 POST** — 自組織のジョブ以外は書き込まれず rejected になる（Task 4 のクロステナントテスト）。
2. **同一 jobId の二重 POST（ランナー再送）** — 2 回目は no-op。`rank_snapshots` の一意 index + `onConflictDoNothing` で重複行が生まれない（Task 4 の冪等テスト）。
3. **claim 後にランナー死亡** — 30 分で pending へ戻り、attempts 3 到達で failed、全ジョブ終端で run が completed/failed に落ちて永久 running にならない（Task 5 の回収テスト）。
4. **日本語ロケーション名の UULE** — 長さバイトは文字数でなくバイト数。マルチバイトで壊れない（Task 7 の「東京都新宿区」テスト）。
5. **ターゲットがローカルパック/広告にのみ出現する SERP** — オーガニック position は null になる（オーガニックブロックだけを数える。Task 7 のフィクスチャテスト）。

---

### Task 1: DB スキーマ＋マイグレーション

**Files:**
- Modify: `src/db/app.schema.ts`（`rankTrackingConfigs` / `rankSnapshots` 拡張、`rankCheckJobs` / `runnerHeartbeats` 追加）
- Modify: `src/db/pg/app.schema.ts`（同内容を pg 型で）
- Create: `drizzle/` `drizzle-pg/` に生成されるマイグレーション（`npm run db:generate`）

**Interfaces:**
- Produces: `rankCheckJobs`, `runnerHeartbeats` テーブルと、`rankTrackingConfigs.provider` / `.trackLocalPack`、`rankSnapshots.provider` / `.localPackPosition` カラム。後続タスクはこの名前を参照する。

- [ ] **Step 1: SQLite スキーマを拡張**

`src/db/app.schema.ts` の `rankTrackingConfigs` カラム定義に追加（`createdAt` の前）:

```ts
    provider: text("provider", { enum: ["dataforseo", "runner"] })
      .notNull()
      .default("dataforseo"),
    trackLocalPack: integer("track_local_pack", { mode: "boolean" })
      .notNull()
      .default(false),
```

`rankSnapshots` に追加（`checkedAt` の前）:

```ts
    localPackPosition: integer("local_pack_position"), // null = local pack 圏外 or 未計測
    provider: text("provider", { enum: ["dataforseo", "runner"] })
      .notNull()
      .default("dataforseo"),
```

`rankSnapshots` の直後に新テーブル 2 つ:

```ts
// Pull-queue rows for provider="runner" configs. One row per keyword × device.
// Results land in rank_snapshots; job rows only track claim/retry state.
export const rankCheckJobs = sqliteTable(
  "rank_check_jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    configId: text("config_id")
      .notNull()
      .references(() => rankTrackingConfigs.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    keyword: text("keyword").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    includeLocalPack: integer("include_local_pack", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status", {
      enum: ["pending", "claimed", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: text("claimed_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("rank_check_jobs_claim_idx").on(table.status, table.createdAt),
    index("rank_check_jobs_run_idx").on(table.runId, table.status),
  ],
);

// Last-seen state per runner. organizationId is "selfhost" when the runner
// authenticates with RUNNER_TOKEN instead of a hosted API key.
export const runnerHeartbeats = sqliteTable("runner_heartbeats", {
  organizationId: text("organization_id").primaryKey(),
  status: text("status", { enum: ["idle", "scraping", "cooldown"] }).notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});
```

- [ ] **Step 2: Postgres スキーマに同内容を反映**

`src/db/pg/app.schema.ts` の同名テーブルへ、そのファイルの既存流儀（`pgTable` / `text` / `integer` / `boolean`）で同一カラム・同一テーブルを追加する。boolean は pg では `boolean("track_local_pack")` 系を使う（`mode: "boolean"` は SQLite のみ）。index 名は SQLite 側と一致させる。

- [ ] **Step 3: マイグレーション生成とパリティ確認**

Run: `npm run db:generate && pnpm vitest run src/db/schema-parity.test.ts`
Expected: 両 dialect に migration ファイルが生成され、parity テスト PASS。

- [ ] **Step 4: ローカル DB へ適用して確認**

Run: `npm run db:migrate:local`
Expected: エラーなし。

- [ ] **Step 5: Commit**

```bash
git add src/db drizzle drizzle-pg
git commit -m "feat(rank-tracking): add runner provider columns, rank_check_jobs and runner_heartbeats"
```

---

### Task 2: ランナー用 Zod スキーマ

**Files:**
- Create: `src/types/schemas/runner.ts`
- Modify: `src/types/schemas/rank-tracking.ts`（provider enum の追加のみ）
- Test: `src/types/schemas/runner.test.ts`

**Interfaces:**
- Produces:

```ts
// runner.ts の公開型（後続タスクはこの名前・型を使う）
export const rankTrackingProviderSchema = z.enum(["dataforseo", "runner"]); // rank-tracking.ts に置き re-export
export const runnerJobSchema: z.ZodType<RunnerJob>;
export type RunnerJob = {
  id: string; runId: string; keyword: string;
  device: "desktop" | "mobile"; includeLocalPack: boolean;
  targetDomain: string; languageCode: string; locationCode: number;
  locationName: string | null; serpDepth: number;
};
export const claimJobsResponseSchema; // { jobs: RunnerJob[] }
export const runnerResultSchema; // 下記
export type RunnerResult = {
  jobId: string; status: "ok" | "error";
  position: number | null; url: string | null; serpFeatures: string[];
  localPackPosition: number | null; errorMessage: string | null;
};
export const submitResultsRequestSchema; // { results: RunnerResult[] } min1 max50
export const heartbeatRequestSchema; // { status: "idle" | "scraping" | "cooldown" }
```

- [ ] **Step 1: 失敗するテストを書く**

`src/types/schemas/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  runnerResultSchema,
  submitResultsRequestSchema,
} from "@/types/schemas/runner";

describe("runner schemas", () => {
  it("accepts a valid ok result", () => {
    const parsed = runnerResultSchema.parse({
      jobId: "job_1",
      status: "ok",
      position: 3,
      url: "https://example.com/a",
      serpFeatures: ["organic", "local_pack"],
      localPackPosition: null,
      errorMessage: null,
    });
    expect(parsed.position).toBe(3);
  });

  it("rejects position 0 and an empty batch", () => {
    expect(() =>
      runnerResultSchema.parse({
        jobId: "job_1",
        status: "ok",
        position: 0,
        url: null,
        serpFeatures: [],
        localPackPosition: null,
        errorMessage: null,
      }),
    ).toThrow();
    expect(() => submitResultsRequestSchema.parse({ results: [] })).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run src/types/schemas/runner.test.ts`
Expected: FAIL（モジュール未定義）。

- [ ] **Step 3: スキーマを実装**

`src/types/schemas/rank-tracking.ts` に追加:

```ts
export const rankTrackingProviderSchema = z.enum(["dataforseo", "runner"]);
export type RankTrackingProvider = z.infer<typeof rankTrackingProviderSchema>;
```

`src/types/schemas/runner.ts`:

```ts
import { z } from "zod";

const positionSchema = z.number().int().positive().nullable();

export const runnerJobSchema = z.object({
  id: z.string(),
  runId: z.string(),
  keyword: z.string(),
  device: z.enum(["desktop", "mobile"]),
  includeLocalPack: z.boolean(),
  targetDomain: z.string(),
  languageCode: z.string(),
  locationCode: z.number().int(),
  locationName: z.string().nullable(),
  serpDepth: z.number().int().positive(),
});
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export const claimJobsResponseSchema = z.object({
  jobs: z.array(runnerJobSchema),
});

export const runnerResultSchema = z.object({
  jobId: z.string(),
  status: z.enum(["ok", "error"]),
  position: positionSchema,
  url: z.string().nullable(),
  serpFeatures: z.array(z.string()).max(30),
  localPackPosition: positionSchema,
  errorMessage: z.string().max(2000).nullable(),
});
export type RunnerResult = z.infer<typeof runnerResultSchema>;

export const submitResultsRequestSchema = z.object({
  results: z.array(runnerResultSchema).min(1).max(50),
});

export const heartbeatRequestSchema = z.object({
  status: z.enum(["idle", "scraping", "cooldown"]),
});
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/types/schemas/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/schemas/runner.ts src/types/schemas/runner.test.ts src/types/schemas/rank-tracking.ts
git commit -m "feat(rank-tracking): add runner job/result zod schemas"
```

---

### Task 3: RankCheckJobRepository（実 SQL テスト付き）

**Files:**
- Create: `src/server/features/rank-tracking/repositories/RankCheckJobRepository.ts`
- Test: `src/server/features/rank-tracking/repositories/RankCheckJobRepository.query.test.ts`

**Interfaces:**
- Consumes: Task 1 のテーブル。
- Produces:

```ts
export interface ClaimedJobRow {
  id: string; runId: string; configId: string; trackingKeywordId: string;
  keyword: string; device: "desktop" | "mobile"; includeLocalPack: boolean;
  status: "pending" | "claimed" | "done" | "failed";
  scheduleInterval: "daily" | "weekly" | "monthly" | "manual";
  targetDomain: string; languageCode: string; locationCode: number;
  locationName: string | null; serpDepth: number;
}
export const RankCheckJobRepository = {
  createJobs(rows: Array<{ id: string; runId: string; configId: string;
    trackingKeywordId: string; keyword: string;
    device: "desktop" | "mobile"; includeLocalPack: boolean }>): Promise<void>;
  claimJobs(input: { organizationIds: string[] | null; limit: number;
    nowIso: string }): Promise<ClaimedJobRow[]>;
  getClaimedJob(jobId: string,
    organizationIds: string[] | null): Promise<ClaimedJobRow | undefined>;
  markJobDone(jobId: string): Promise<void>;
  markJobFailed(jobId: string, lastError: string): Promise<void>;
  releaseExpiredClaims(input: { cutoffIso: string; maxAttempts: number
    }): Promise<{ releasedRunIds: string[] }>;
  countJobsByStatusForRun(runId: string): Promise<{ open: number; done: number; failed: number }>;
  getRunnerHeartbeat(organizationId: string):
    Promise<{ status: "idle" | "scraping" | "cooldown"; lastSeenAt: string } | undefined>;
  upsertRunnerHeartbeat(input: { organizationId: string;
    status: "idle" | "scraping" | "cooldown"; lastSeenAt: string }): Promise<void>;
};
```

- [ ] **Step 1: 失敗する query テストを書く**

`RankTrackingRepository.query.test.ts` の DB セットアップ流儀（実 SQLite で drizzle を評価している方式）をそのまま流用し、以下の不変条件をテストにする:

```ts
// 各テストの中身（セットアップは既存 query.test.ts をミラー）
it("claims only pending jobs for the caller's organizations, oldest first", async () => {
  // org A に 2 件 (作成時刻順)、org B に 1 件の pending ジョブを用意
  const claimed = await RankCheckJobRepository.claimJobs({
    organizationIds: [orgA],
    limit: 10,
    nowIso: "2026-09-29T00:00:00.000Z",
  });
  expect(claimed.map((j) => j.id)).toEqual(["job_a1", "job_a2"]); // org B は含まれない
  expect(claimed[0].status).toBe("claimed");
  expect(claimed[0].targetDomain).toBe("acme.com"); // config join が効いている
});

it("claimJobs with organizationIds null claims across all orgs (selfhost token)", async () => {
  const claimed = await RankCheckJobRepository.claimJobs({
    organizationIds: null, limit: 10, nowIso: "2026-09-29T00:00:00.000Z",
  });
  expect(claimed).toHaveLength(3);
});

it("a claimed job is not claimed twice", async () => {
  await RankCheckJobRepository.claimJobs({ organizationIds: null, limit: 1, nowIso: t0 });
  const second = await RankCheckJobRepository.claimJobs({ organizationIds: null, limit: 10, nowIso: t0 });
  expect(second.map((j) => j.id)).not.toContain("job_a1");
});

it("releaseExpiredClaims returns old claims to pending and fails at maxAttempts", async () => {
  // attempts=1 claimedAt=古い → pending へ / attempts=3 claimedAt=古い → failed へ
  const { releasedRunIds } = await RankCheckJobRepository.releaseExpiredClaims({
    cutoffIso: "2026-09-29T01:00:00.000Z", maxAttempts: 3,
  });
  expect(releasedRunIds).toContain("run_1");
  // 状態を select で検証
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/repositories/RankCheckJobRepository.query.test.ts`
Expected: FAIL（モジュール未定義）。

- [ ] **Step 3: Repository を実装**

実装要点（`RankTrackingRepository.ts` と同じ db アクセサ・import 流儀に従う）:

```ts
async function claimJobs(input: {
  organizationIds: string[] | null;
  limit: number;
  nowIso: string;
}): Promise<ClaimedJobRow[]> {
  // 1) claim 候補の id を select（jobs → configs → projects join、org filter、
  //    status='pending'、createdAt asc、limit）
  // 2) update rankCheckJobs set status='claimed', claimedAt=nowIso,
  //    attempts=attempts+1 where id in (ids) and status='pending'
  //    .returning({ id: rankCheckJobs.id })
  //    — 2 段階なのは D1 に SELECT FOR UPDATE がないため。update 側の
  //    status='pending' 条件で競合時は勝った方だけが returning に載る。
  // 3) returning で残った id を join 付きで select し ClaimedJobRow を返す。
}
```

`releaseExpiredClaims`: `status='claimed' AND claimedAt < cutoffIso` を対象に、`attempts >= maxAttempts` は `failed`（lastError='claim expired'）、それ以外は `pending` に戻し `claimedAt` を null に。影響行の `runId` を distinct で返す。

`upsertRunnerHeartbeat`: `onConflictDoUpdate`（pk: organizationId）。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/repositories/RankCheckJobRepository.query.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/features/rank-tracking/repositories/RankCheckJobRepository*
git commit -m "feat(rank-tracking): add rank check job repository with claim queue"
```

---

### Task 4: RunnerJobService（claim / 結果取込 / heartbeat）

**Files:**
- Create: `src/server/features/rank-tracking/services/RunnerJobService.ts`
- Modify: `src/server/features/rank-tracking/repositories/RankTrackingRepository.ts`（`markConfigChecked` を追加）
- Test: `src/server/features/rank-tracking/services/RunnerJobService.test.ts`

**Interfaces:**
- Consumes: Task 2 の型、Task 3 の `RankCheckJobRepository`、既存 `RankTrackingRepository.insertSnapshots` / `.updateRun`、`computeNextCheckAt`（`@/shared/rank-tracking`）。
- Produces:

```ts
export interface RunnerAuthScope {
  organizationIds: string[] | null; // null = RUNNER_TOKEN 認証（全 org）
}
export const RunnerJobService = {
  claimJobs(scope: RunnerAuthScope, limit: number): Promise<RunnerJob[]>;
  submitResults(scope: RunnerAuthScope, results: RunnerResult[]):
    Promise<{ accepted: number; rejected: number }>;
  recordHeartbeat(scope: RunnerAuthScope,
    status: "idle" | "scraping" | "cooldown"): Promise<void>;
  getRunnerStatus(organizationId: string):
    Promise<{ status: string; lastSeenAt: string } | null>;
  startRunnerRun(input: { config: RunnerRunConfig; projectId: string;
    keywordIds?: string[] }): Promise<{ runId: string } | { error: string }>;
  reconcileRunnerJobs(nowIso: string): Promise<void>;
};
// RunnerRunConfig = { id, domain, languageCode, locationCode, locationName,
//   devices, serpDepth, scheduleInterval, trackLocalPack } (config 行の部分型)
// RankTrackingRepository.markConfigChecked(configId: string,
//   input: { lastCheckedAt: string; nextCheckAt: string | null }): Promise<void>
```

- [ ] **Step 1: 失敗するテストを書く**

`RankTrackingService.test.ts` と同じ流儀（`vi.hoisted` + repository 全体の `vi.mock`、フラット関数モック）で:

```ts
describe("RunnerJobService.submitResults", () => {
  it("writes a snapshot and marks the job done for an ok result", async () => {
    mocks.getClaimedJob.mockResolvedValue(claimedJob); // status: "claimed"
    mocks.countJobsByStatusForRun.mockResolvedValue({ open: 1, done: 1, failed: 0 });
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: claimedJob.runId,
        trackingKeywordId: claimedJob.trackingKeywordId,
        provider: "runner",
        position: 3,
        localPackPosition: null,
      }),
    ]);
    expect(mocks.markJobDone).toHaveBeenCalledWith("job_1");
  });

  it("rejects a result for a job outside the caller's org scope", async () => {
    mocks.getClaimedJob.mockResolvedValue(undefined); // scope filter で不可視
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out).toEqual({ accepted: 0, rejected: 1 });
    expect(mocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("is idempotent: a job no longer in claimed state is rejected without writes", async () => {
    mocks.getClaimedJob.mockResolvedValue({ ...claimedJob, status: "done" });
    const out = await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(out.rejected).toBe(1);
    expect(mocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("completes the run and stamps the config when the last job finishes", async () => {
    mocks.getClaimedJob.mockResolvedValue(claimedJob);
    mocks.countJobsByStatusForRun.mockResolvedValue({ open: 0, done: 4, failed: 0 });
    await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(mocks.updateRun).toHaveBeenCalledWith(claimedJob.runId,
      expect.objectContaining({ status: "completed", keywordsChecked: 4 }));
    expect(mocks.markConfigChecked).toHaveBeenCalled();
  });

  it("marks the run failed when all jobs terminated but some failed", async () => {
    mocks.getClaimedJob.mockResolvedValue(claimedJob);
    mocks.countJobsByStatusForRun.mockResolvedValue({ open: 0, done: 3, failed: 1 });
    await RunnerJobService.submitResults(scopeOrgA, [okResult]);
    expect(mocks.updateRun).toHaveBeenCalledWith(claimedJob.runId,
      expect.objectContaining({ status: "failed" }));
  });
});

describe("RunnerJobService.startRunnerRun", () => {
  it("creates a run and one job per keyword x device", async () => {
    mocks.tryCreateRun.mockResolvedValue(true);
    mocks.getKeywordsForConfig.mockResolvedValue([kw1, kw2]); // 既存 repo 関数名に合わせる
    await RunnerJobService.startRunnerRun({ config: runnerConfigBoth, projectId: "p1" });
    const rows = mocks.createJobs.mock.calls[0][0];
    expect(rows).toHaveLength(4); // 2 kw × both
    expect(rows[0]).toMatchObject({ device: "desktop", includeLocalPack: true });
  });
});
```

`recordHeartbeat`: scope が null なら organizationId `"selfhost"`、org が 1 つならその org で upsert されることを 1 テスト。

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/services/RunnerJobService.test.ts`
Expected: FAIL

- [ ] **Step 3: Service を実装**

実装要点:
- `claimJobs`: repository の `claimJobs` を呼び、`ClaimedJobRow` → `RunnerJob`（`runnerJobSchema` の形）へマップ。limit は 1..50 に clamp。
- `submitResults`: 結果ごとに `getClaimedJob(jobId, scope.organizationIds)` → 見つからない/status!=="claimed" は rejected。`status==="error"` は `markJobFailed`。ok は `insertSnapshots`（`serpFeatures` は JSON.stringify、`provider: "runner"`）→ `markJobDone`。処理後、影響 runId ごとに `countJobsByStatusForRun` を見て open===0 なら `updateRun`（failed>0 なら status "failed" + errorMessage、そうでなければ "completed"、`keywordsChecked: done`、`completedAt: now`）と `markConfigChecked(configId, { lastCheckedAt: now, nextCheckAt: computeNextCheckAt(...) })`。`scheduleInterval` は ClaimedJobRow の join 列（Task 3 で定義済み）から取る。
- `startRunnerRun`: `tryCreateRun`（既存の 1-active-run unique index に乗る）→ 失敗時 `{ error: "already_running" }`。キーワード（`keywordIds` 指定時は絞る）× devices（"both" は 2 行）でジョブ生成。`includeLocalPack = config.trackLocalPack`。
- `reconcileRunnerJobs(nowIso)`: `releaseExpiredClaims({ cutoffIso: now-30min, maxAttempts: 3 })` → 返った runId ごとに上と同じ run 完了判定。
- `markConfigChecked` を `RankTrackingRepository` に追加（単純 update）。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/services/RunnerJobService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/features/rank-tracking
git commit -m "feat(rank-tracking): add RunnerJobService for claim/ingest/heartbeat"
```

---

### Task 5: スケジュール＆手動トリガーの provider 分岐

**Files:**
- Modify: `src/server/features/rank-tracking/services/scheduledRankChecks.ts`
- Modify: `src/server/features/rank-tracking/services/RankTrackingService.ts:213` 周辺（手動トリガー。`beginRankCheckRun` 呼び出しの前に provider 分岐を追加）
- Test: 既存 `scheduledRankChecks` のテストファイルに追記（無ければ `scheduledRankChecks.runner.test.ts` を新設、Task 4 と同じモック流儀）

**Interfaces:**
- Consumes: `RunnerJobService.startRunnerRun` / `.reconcileRunnerJobs`（Task 4）。
- Produces: 変更後の挙動のみ（新しい公開シグネチャなし）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it("runner-provider configs get jobs instead of a DataForSEO workflow, with no billing", async () => {
  mocks.getDueConfigsWithOrganization.mockResolvedValue([runnerConfigDue]);
  await runScheduledRankChecks(envStub);
  expect(mocks.startRunnerRun).toHaveBeenCalledTimes(1);
  expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
  expect(mocks.customerHasPaidPlan).not.toHaveBeenCalled(); // 0コスト: 課金ゲートを通らない
});

it("each tick reconciles expired runner claims", async () => {
  mocks.getDueConfigsWithOrganization.mockResolvedValue([]);
  await runScheduledRankChecks(envStub);
  expect(mocks.reconcileRunnerJobs).toHaveBeenCalledTimes(1);
});
```

手動トリガー側: provider="runner" の config で `startRunnerRun` が呼ばれ、workflow が呼ばれないことを既存トリガーテストの流儀で 1 本。

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/services/`
Expected: 新テストのみ FAIL。

- [ ] **Step 3: 分岐を実装**

- `runScheduledRankChecks` 冒頭（due config 取得後）に `await RunnerJobService.reconcileRunnerJobs(nowIso)`。
- config ループ内、課金チェック（`checkPaidPlan`）より前に:

```ts
if (config.provider === "runner") {
  await RunnerJobService.startRunnerRun({ config, projectId: config.projectId });
  continue; // budget 消費もスキップ（DataForSEO を呼ばないため）
}
```

（`getDueConfigsWithOrganization` の select 列に `provider` / `trackLocalPack` が含まれるよう repository を確認・追加。）
- 手動トリガー service にも同じ分岐（`keywordIds` を `startRunnerRun` に渡す）。

- [ ] **Step 4: 全 rank-tracking テストが通ることを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/`
Expected: PASS（既存テスト含む）。

- [ ] **Step 5: Commit**

```bash
git add src/server/features/rank-tracking
git commit -m "feat(rank-tracking): route runner-provider configs to the job queue"
```

---

### Task 6: ランナー HTTP API と server.ts 配線

**Files:**
- Create: `src/server/features/rank-tracking/runner/runner-http.ts`
- Modify: `src/server.ts`（`/api/runner/` 分岐追加）
- Modify: `src/server/auth/`（`getOrganizationIdsForUser` — better-auth member テーブルから user の org 一覧。既存 AuthRepository があればそこへ）
- Test: `src/server/features/rank-tracking/runner/runner-http.test.ts`

**Interfaces:**
- Consumes: `RunnerJobService`（Task 4）、`API_KEY_PREFIX`（`@/lib/auth-api-key`）、`getAuth().api.verifyApiKey`（`src/server/mcp/api-key-auth.ts` と同じ取得経路）。
- Produces:

```ts
export const RUNNER_ROUTE_PREFIX = "/api/runner";
// リクエストがランナー API なら Response、無関係なら null
export async function handleRunnerRequest(request: Request): Promise<Response | null>;
```

エンドポイント仕様:
- `GET  /api/runner/jobs?limit=N` → 200 `{ jobs: RunnerJob[] }`
- `POST /api/runner/results`（body: `submitResultsRequestSchema`）→ 200 `{ accepted, rejected }` / 400（Zod 不正）
- `POST /api/runner/heartbeat`（body: `heartbeatRequestSchema`）→ 204
- 認証: `Authorization: Bearer <token>`。`oseo_` 始まり → `verifyApiKey` → userId → `getOrganizationIdsForUser` → scope。それ以外は env `RUNNER_TOKEN`（`cloudflare:workers` の env。未設定なら常に 401）と定数時間比較 → scope `{ organizationIds: null }`。失敗は 401 JSON。
- 未知パス 404、メソッド不一致 405。

- [ ] **Step 1: 失敗するテストを書く**

`vi.mock` で `RunnerJobService` と auth 取得をモックし、`handleRunnerRequest(new Request(...))` を直接叩く:

```ts
it("returns null for unrelated paths", async () => {
  expect(await handleRunnerRequest(new Request("https://x/api/other"))).toBeNull();
});
it("401s without a bearer token", async () => {
  const res = await handleRunnerRequest(new Request("https://x/api/runner/jobs"));
  expect(res?.status).toBe(401);
});
it("claims jobs with a valid oseo_ key", async () => {
  mocks.verifyApiKey.mockResolvedValue({ valid: true, key: { referenceId: "u1" } });
  mocks.getOrganizationIdsForUser.mockResolvedValue(["org1"]);
  mocks.claimJobs.mockResolvedValue([job]);
  const res = await handleRunnerRequest(new Request("https://x/api/runner/jobs?limit=5",
    { headers: { authorization: "Bearer oseo_abc" } }));
  expect(res?.status).toBe(200);
  expect(mocks.claimJobs).toHaveBeenCalledWith({ organizationIds: ["org1"] }, 5);
});
it("400s on an invalid results payload", async () => { /* results: [] を POST */ });
it("accepts RUNNER_TOKEN and passes a null org scope", async () => { /* env stub */ });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run src/server/features/rank-tracking/runner/`
Expected: FAIL

- [ ] **Step 3: 実装と配線**

`runner-http.ts` を上記仕様どおり実装（`api-key-auth.ts` のエラーレスポンス形式・ログ流儀を踏襲。レートリミットは Better Auth の apiKey プラグイン設定に既にあるため追加実装しない）。

`src/server.ts` の `handleFetch`、`/agents/` 分岐の直後に:

```ts
if (pathname.startsWith(RUNNER_ROUTE_PREFIX)) {
  return handleRunnerRequest(publicRequest).then(
    (res) => res ?? new Response("Not found", { status: 404 }),
  );
}
```

- [ ] **Step 4: テスト＋型チェック**

Run: `pnpm vitest run src/server/features/rank-tracking/runner/ && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/features/rank-tracking/runner src/server.ts src/server/auth
git commit -m "feat(rank-tracking): expose /api/runner endpoints with api-key auth"
```

---

### Task 7: ランナー CLI — UULE エンコーダとオーガニック SERP パーサ

**Files:**
- Create: `runner/package.json`（`{ "name": "openseo-runner", "private": true, "type": "module", "engines": { "node": ">=20" }, "dependencies": { "cloakbrowser": "^0.5.7", "linkedom": "^0.18.0" }, "scripts": { "test": "node --test test/" } }`）
- Create: `runner/lib/uule.mjs`
- Create: `runner/lib/organic.mjs`
- Create: `runner/test/uule.test.mjs`、`runner/test/organic.test.mjs`、`runner/test/fixtures/serp-organic.html`（自作フィクスチャ）
- Modify: `knip.jsonc`（`runner/**` を ignore に追加）

**Interfaces:**
- Produces:

```js
// uule.mjs
export function encodeUuleCanonicalName(name /* string */) /* -> "w+..." */;
// organic.mjs
export function parseOrganicResults(html, targetDomain)
// -> { position: number|null, url: string|null, serpFeatures: string[] }
```

- [ ] **Step 1: 失敗するテストを書く**

`runner/test/uule.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeUuleCanonicalName } from "../lib/uule.mjs";

test("known ASCII canonical name matches the documented encoding", () => {
  // 既知例: "West New York,New Jersey,United States" (37 bytes = '%')
  const uule = encodeUuleCanonicalName("West New York,New Jersey,United States");
  assert.ok(uule.startsWith("w+CAIQICI"));
});

test("multibyte names use byte length, not character length", () => {
  const name = "東京都新宿区"; // 6 chars, 18 bytes
  const uule = encodeUuleCanonicalName(name);
  const proto = Buffer.from(uule.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(proto[5], 18); // 長さバイト = バイト数
  assert.equal(proto.subarray(6).toString("utf8"), name);
});

test("names longer than 127 bytes are rejected (varint not implemented)", () => {
  assert.throws(() => encodeUuleCanonicalName("x".repeat(128)));
});
```

`runner/test/organic.test.mjs` — フィクスチャは `#search` 配下にオーガニック 3 件（h3+リンク持ち）、間に local pack 風ブロック（`role="feed"` を持つ div 内に target ドメインのリンク）と PAA ブロックを挟んだ最小 HTML を自作し:

```js
test("counts only organic blocks for position", () => {
  const out = parseOrganicResults(fixtureHtml, "example.com");
  assert.equal(out.position, 2); // organic 2 番目に example.com
});
test("target present only inside the local pack yields null position", () => {
  const out = parseOrganicResults(fixtureHtml, "onlyinpack.example");
  assert.equal(out.position, null);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd runner && npm test`
Expected: FAIL

- [ ] **Step 3: 実装**

`uule.mjs`:

```js
export function encodeUuleCanonicalName(name) {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > 127) {
    throw new Error("canonical name too long for single-byte varint");
  }
  const proto = Buffer.concat([
    Buffer.from([0x08, 0x02, 0x10, 0x20, 0x22, bytes.length]),
    bytes,
  ]);
  return (
    "w+" +
    proto.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}
```

`organic.mjs`（linkedom で DOM 化）: `#search` 配下で「`h3` を含み、祖先に `[role="feed"]`（local pack/finder）・`[jscontroller][data-initq]`（PAA）・`#taw`/`.ads-ad`/`[data-text-ad]`（広告）を持たない」最上位結果ブロックを document 順に列挙し、各ブロック先頭の `a[href^="http"]` の hostname を取り、`hostname === target || hostname.endsWith("." + target)` の最初の一致順位を position に。`serpFeatures` は存在検知で `["organic"]` + `role=feed` 検知時 `"local_pack"` + PAA 検知時 `"people_also_ask"` を積む。ヒューリスティクスは 2026-08 検証時のブロック構造メモに基づくが、**実 SERP での再検証は Task 9 の smoke で行う**。

`knip.jsonc` に `"ignore": [..., "runner/**"]` を追記（既存 ignore 配列の形式に従う）。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd runner && npm install && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner knip.jsonc
git commit -m "feat(runner): add uule encoder and organic serp parser"
```

---

### Task 8: ランナー CLI — ローカルパックパーサ

**Files:**
- Create: `runner/lib/localpack.mjs`
- Test: `runner/test/localpack.test.mjs`、`runner/test/fixtures/local-finder.html`（自作フィクスチャ）

**Interfaces:**
- Consumes: なし（純関数）。
- Produces:

```js
// Local Finder ページの HTML から、target ドメインの website リンクを持つ
// エントリの順位を返す。
export function parseLocalFinderResults(html, targetDomain)
// -> { localPackPosition: number|null, entries: Array<{ name: string, website: string|null }> }
```

- [ ] **Step 1: 失敗するテストを書く**

フィクスチャ: `div[role="feed"]` 内にエントリ 3 件（`div[role="heading"]` の店名、うち 2 件は website リンク `a[href*="http"]` 付き、1 件はリンクなし）。

```js
test("returns the 1-based position of the entry whose website matches", () => {
  const out = parseLocalFinderResults(fixtureHtml, "acme.example");
  assert.equal(out.localPackPosition, 2);
});
test("no website match yields null but still lists entries", () => {
  const out = parseLocalFinderResults(fixtureHtml, "nomatch.example");
  assert.equal(out.localPackPosition, null);
  assert.equal(out.entries.length, 3);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd runner && npm test`
Expected: 新テスト FAIL

- [ ] **Step 3: 実装**

`[role="feed"]` 直下の各エントリブロックを列挙し、`[role="heading"]` テキストを name、Google 外部へ向く最初の `a[href]`（`google.` ドメイン・`/maps` を除外）を website として抽出。ドメイン照合は Task 7 と同じ hostname 規則を関数化して共有（`runner/lib/domains.mjs` に `hostnameMatches(hostname, target)` を切り出し、organic.mjs と両方から import）。

制約として JSDoc に明記: website リンクを出さない GBP は照合不能で null になる（店名照合は設定に businessName が無いため行わない）。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd runner && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add runner
git commit -m "feat(runner): add local finder parser"
```

---

### Task 9: ランナー CLI — メインループと smoke スクリプト

**Files:**
- Create: `runner/cli.mjs`
- Create: `runner/lib/api.mjs`（サーバー API クライアント）
- Create: `runner/lib/scrape.mjs`（cloakbrowser でのページ取得）
- Create: `runner/smoke.mjs`（手動ライブ検証）
- Test: `runner/test/api.test.mjs`（fetch モックで claim/post の往復）

**Interfaces:**
- Consumes: Task 6 の HTTP API、Task 7/8 のパーサ。
- Produces（cli 内部関数、api.mjs）:

```js
export function createApiClient({ serverOrigin, token })
// -> { claimJobs(limit), submitResults(results), heartbeat(status) }  すべて fetch ベース
```

- [ ] **Step 1: api.mjs の失敗するテストを書く**

node:test + `globalThis.fetch` 差し替えで: claim が `GET {origin}/api/runner/jobs?limit=10` に Bearer を付けること、submit が 50 件ずつ分割 POST すること、非 2xx で例外になることを 3 テスト。

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd runner && npm test`
Expected: FAIL

- [ ] **Step 3: 実装**

`api.mjs`: 素直な fetch ラッパ。`scrape.mjs`:

```js
// ジョブ 1 件を実行して RunnerResult を返す。
export async function executeJob(browser, job) {
  // 1) オーガニック: https://www.google.com/search?q=<kw>&hl=<lang>&start=<0,10,...>
  //    job.locationName があれば &uule=encodeUuleCanonicalName(locationName)
  //    device==="mobile" は cloakbrowser のモバイルコンテキストで開く。
  //    ページごとに parseOrganicResults を通し、target が見つかるか
  //    serpDepth に達するまで start を進める（1 ページ ≈ 10 件と数える）。
  // 2) job.includeLocalPack なら Local Finder
  //    (https://www.google.com/localservices/... ではなく通常の
  //    google.com/search?q=<kw>&tbm=lcl&hl=<lang>&uule=...) を開いて
  //    parseLocalFinderResults。
  // 3) captcha 検知 (URL が /sorry/ を含む、または #captcha-form が存在) は
  //    CaptchaError を throw。
}
```

`cli.mjs`:

```js
// 使い方: node runner/cli.mjs --server https://app.example.com --key oseo_xxx
// (env: OPENSEO_SERVER / OPENSEO_RUNNER_KEY でも可)
// ループ: heartbeat("idle") → claimJobs(10) → 各ジョブ:
//   executeJob → 結果をバッファ → 10〜30 秒の乱数スリープ
//   CaptchaError → heartbeat("cooldown") → 45 分スリープ → 同ジョブ再試行
//   その他の例外 → { status: "error", errorMessage } として結果に積む
// バッファは 20 件ごと & ループ末尾に submitResults。
// ジョブゼロなら 60 秒 ±15 秒スリープ。SIGINT で現ジョブ完了後に終了。
// 1 ブラウザセッション 30 クエリで再起動（フィンガープリント替え）。
```

`smoke.mjs`: 引数のキーワード・ドメイン・ロケーション名で `executeJob` を 1 回だけ実行し JSON を stdout に出す（サーバー不要のライブ検証。CI では実行しない）。

- [ ] **Step 4: テスト＋ライブ smoke**

Run: `cd runner && npm test`
Expected: PASS
Run（手動・要ネットワーク）: `node runner/smoke.mjs --keyword "高田馬場 税理士" --domain compass-tax.jp --location "東京都新宿区"`
Expected: position / localPackPosition を含む JSON が出る。captcha に当たった場合はその旨の明確なエラー。**ここで Task 7/8 のセレクタが実 SERP とずれていれば、フィクスチャを実 HTML から更新して修正する（このタスク内で完結させる）。**

- [ ] **Step 5: Commit**

```bash
git add runner
git commit -m "feat(runner): add polling cli with cooldown and smoke script"
```

---

### Task 10: 設定 UI・ランナー状態表示・ドキュメント

**Files:**
- Modify: `src/serverFunctions/rank-tracking.ts`（create/update の入力に `provider` / `trackLocalPack`、新規 `getRunnerStatus` server fn）
- Modify: `src/server/features/rank-tracking/services/RankTrackingService.ts`（createConfig/updateConfig の入力透過）
- Modify: `src/client/features/rank-tracking/RankTrackingConfigModal.tsx`（データソース select と「ローカルパックも計測」checkbox — runner 選択時のみ表示）
- Modify: `src/client/features/rank-tracking/useSaveConfigMutations.ts`（フィールド透過）
- Modify: `src/routes/_project/p/$projectId/rank-tracking/index.tsx`（runner 設定が 1 つ以上あるとき、ランナー状態パネルを表示）
- Create: `runbooks/runner.md`（起動手順: API キー発行 → `node runner/cli.mjs --server <origin> --key <key>`、selfhost は `RUNNER_TOKEN`）
- Test: `RankTrackingService.test.ts` に provider 透過の 1 ケース追記

**Interfaces:**
- Consumes: `rankTrackingProviderSchema`（Task 2）、`RunnerJobService.getRunnerStatus`（Task 4）。
- Produces: `getRunnerStatus` server fn — `{ status: "idle"|"scraping"|"cooldown", lastSeenAt: string, stale: boolean } | null`（stale = lastSeenAt が 30 分超過去）。

- [ ] **Step 1: service テストを追記して失敗を確認**

createConfig に `provider: "runner", trackLocalPack: true` を渡すと `mocks.createConfig` に同値が透過されることを 1 テスト。
Run: `pnpm vitest run src/server/features/rank-tracking/services/RankTrackingService.test.ts`
Expected: 新規のみ FAIL

- [ ] **Step 2: server fn / service / UI を実装**

- serverFunctions の Zod input に `provider: rankTrackingProviderSchema.optional()`, `trackLocalPack: z.boolean().optional()`。
- `getRunnerStatus`: 既存 server fn と同じ org 解決ミドルウェアを使い、`RunnerJobService.getRunnerStatus(organizationId)` を返す。selfhost モード時は `"selfhost"` の行も引く（両方引いて新しい方）。
- ConfigModal: 「データソース」select（DataForSEO / セルフランナー（0円））。runner 選択時のみ checkbox 表示。既存フォームコンポーネントの流儀（TanStack Form）に従う。
- index ルート: `getRunnerStatus` を useQuery し、runner 設定が存在して `stale || null` のとき警告バナー「ランナー未稼働 — 起動方法はこちら」（runbooks/runner.md の内容を反映した起動コマンドのコピー UI。ホストの origin と `oseo_` キー発行画面への導線）。

- [ ] **Step 3: テスト・型・lint 全通し**

Run: `pnpm vitest run src/ && pnpm tsc --noEmit && pnpm lint`（lint スクリプトが無ければ `pnpm knip`）
Expected: PASS

- [ ] **Step 4: 動作確認（ローカル）**

Run: `pnpm dev` でアプリ起動 → rank tracking 設定を provider=runner で作成 → `RUNNER_TOKEN=devtoken node runner/cli.mjs --server http://localhost:<port> --key devtoken`（.dev.vars に RUNNER_TOKEN=devtoken を追加）→ ジョブが claim され、結果がテーブルに現れることを確認。
Expected: スナップショットが provider=runner で保存され、UI に順位が出る。

- [ ] **Step 5: Commit**

```bash
git add src runner runbooks
git commit -m "feat(rank-tracking): runner provider UI, status panel and runbook"
```
