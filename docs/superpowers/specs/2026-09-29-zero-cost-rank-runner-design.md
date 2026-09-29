# 0コスト・ランクチェック（セルフランナー）設計

日付: 2026-09-29
ステータス: ユーザー承認済みの会話設計を文書化（実装前）

## 目的

DataForSEO 課金なしで、オーガニック検索順位とローカルパック（MEO）順位を計測できるようにする。
既存の DataForSEO パスは削除せず、ランクトラッキング設定ごとにデータソースを切り替え可能にする。

## 非目的

- キーワード調査（検索ボリューム等）の0コスト化。ボリュームデータはスクレイピングで代替不可能なため対象外。
- DataForSEO パスの変更・削除。provider 分岐の追加以外、既存フローには手を入れない。
- ランナーの分散実行・複数台対応（1 API キー = 1 ランナー前提。将来拡張）。

## アーキテクチャ概要

Pull 型ジョブキュー。Cloudflare Worker 内ではブラウザを起動できないため、
スクレイピング本体はリポジトリ同梱の CLI ランナー（`runner/`、独立 package.json）が
ユーザーの手元マシン / VPS で実行する。

```
scheduled cron (*/5)                       runner (ユーザーのマシン / VPS)
  └─ provider=runner の due config             └─ ループ:
     → rank_check_jobs 行を作成 (pending)          GET  /api/runner/jobs   (claim)
                                                   ブラウザで SERP / Local Finder 取得
     結果保存は既存 Repository を共用 ◄──────────  POST /api/runner/results
```

- ランナー → サーバーの片方向ポーリングのみ。インバウンド接続不要。
- 認証: 既存の Better Auth API キー基盤（`verifyApiKey`、MCP API キーと同じ発行フロー）を
  runner スコープで流用。`Authorization: Bearer` で送る。

## コンポーネント

### 1. ジョブキュー（サーバー側）

- 新テーブル `rank_check_jobs`: configId / keywordId / device / searchType
  (organic | local_pack) / status (pending | claimed | done | failed) /
  claimedAt / attempts。結果自体はジョブ行に持たせず既存の結果テーブルへ保存する。
  SQLite・Postgres 両対応。
- `runScheduledRankChecks` に provider 分岐を追加: `provider === "runner"` の due config は
  DataForSEO を呼ばず pending ジョブ行を作るだけ。既存の DataForSEO パスは無変更。
- claim は `claimedAt` 更新で行う。claim 後 30 分結果が来なければ pending に戻す（attempts++、
  上限 3 で failed）。
- エンドポイント（TanStack server function ではなく Worker の API ルート。ランナーは
  ブラウザ外クライアントのため）:
  - `GET /api/runner/jobs?limit=N` — pending ジョブを claim して返す。
  - `POST /api/runner/results` — 結果の配列を受け取り検証（Zod）して保存。
  - `POST /api/runner/heartbeat` — 稼働報告（最終ハートビート表示用）。

### 2. 結果の取り込み

- ランナー結果を既存 `RankCheckResult` 形（keywordId / position / url / serpFeatures）に
  マッピングし、DataForSEO 結果と同じ Repository 保存パスに流す。
- `rank_tracking_results` 相当のテーブルに 2 カラム追加:
  - `provider` ("dataforseo" | "runner"、既存行は default "dataforseo")
  - `localPackPosition` (integer, nullable)
- billing 記録はランナー結果では作らない（0 コスト）。

### 3. ランナー CLI（`runner/`）

- 独立 package.json（Worker バンドル・knip 対象外に設定）。Node 20+、依存: cloakbrowser。
- 起動: `node runner/cli.mjs --server https://<host> --key <api key>`
  （または env `OPENSEO_SERVER` / `OPENSEO_RUNNER_KEY`）。
- 実装する取得系（2026-08 検証済み手法の再実装。ライブラリ実物は散逸したため
  メモベースで書き直し、下記は再テストする）:
  - オーガニック: Google 検索を UULE パラメータ（v2 canonical name 形式・座標形式の両対応）で
    位置指定して取得し、オーガニックブロックのみを数えて rank_group 相当の順位を出す。
  - ローカルパック: Google Local Finder をブラウザ表示で開き構造化抽出
    （HTTP 直叩きは captcha で不可、ブラウザ経由は成功実績あり）。
- 対 captcha 運用: captcha 検知で 45 分クールダウン、リクエスト間に 10–30 秒ジッター、
  1 ブラウザセッションの連続クエリ数を制限。
- ジョブが無ければ 60 秒スリープ。ポーリング自体にもジッター。

### 4. UI（最小）

- ランクトラッキング設定に「データソース」選択: DataForSEO / セルフランナー（0円）。
- セルフランナー選択時: API キー発行への導線、起動コマンドのコピー、最終ハートビート時刻。
- ハートビートが 30 分以上前なら「ランナー未稼働」警告。結果が来ないジョブは stale 表示。

## エラー処理

- ランナー停止: ジョブは pending のまま残り、UI が未稼働警告を出す。データは欠測になるだけで
  既存グラフは壊さない（欠測日はスキップ描画、既存挙動に従う）。
- captcha 連続: ランナーはクールダウンし、heartbeat に状態 (cooldown) を載せて UI に出す。
- 不正ペイロード: Zod 検証で 400。claim されたままのジョブはタイムアウト回収で再配布。

## テスト方針（リポジトリ規約準拠）

- ジョブ払い出し / claim タイムアウト回収 / 結果取り込みは service の公開入口経由でテスト。
  ORM チェーンのモックはしない。
- スクレイパーの HTML パーサは保存フィクスチャ（実 SERP / Local Finder の HTML）で単体テスト。
  ブラウザ起動を伴う E2E は CI 対象外（手動 smoke スクリプトを runner/ に同梱）。
- スキーマ変更は schema-parity.test.ts の対象に含める。

## 計画時の修正（2026-09-29 プラン作成で確定）

- ジョブの searchType (organic | local_pack) は廃止。rank_snapshots の
  (runId, trackingKeywordId, device) 一意制約と衝突するため、ジョブは
  includeLocalPack boolean を持ち 1 ジョブで両方を返す。設定に trackLocalPack
  トグルを追加。
- 認証: hosted は Better Auth API キー、self-host は API キー UI が無いため
  env RUNNER_TOKEN による固定トークン認証とする。
- UULE は canonical name 形式のみ実装（設定が持つのは locationName であり
  座標を持たないため。座標形式は将来必要になったら追加）。

## 未検証事項

- cloakbrowser 現行バージョン（0.5.x）での captcha 回避成功率は 8 月時点の実測。再検証する。
- hosted 環境でのランナー API のレート・悪用対策は最小（API キー認証のみ）で開始する。
