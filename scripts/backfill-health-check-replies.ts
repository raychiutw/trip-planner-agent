#!/usr/bin/env bun
/**
 * backfill-health-check-replies.ts — one-shot backfill: rewrite legacy
 * trip_requests.reply (raw JSON findings array) as user-friendly summary。
 *
 * v2.31.18 fix #115：v2.31.18 起 PATCH /api/requests/:id 完成 hook 自動
 * `rewriteRequestReply(buildHealthCheckSummary(...))`，但既有 prod row（v2.31.18
 * 上線前已 completed）reply 仍是「[{"severity":"high",...}]」raw JSON array，
 * chat UI 把 reply 當 markdown 渲染 → user 看到一大坨 JSON。
 *
 * Strategy:
 *   1. SELECT id, trip_id, reply WHERE message LIKE '[AI 健檢]%' AND status='completed'
 *      AND (reply LIKE '[%' OR reply LIKE '{%')  -- raw JSON head detector
 *   2. Parse reply JSON → findings array
 *   3. UPDATE reply = buildHealthCheckSummary(findings, trip_id)
 *
 * Usage:
 *   bun scripts/backfill-health-check-replies.ts --dry-run --local
 *   bun scripts/backfill-health-check-replies.ts --apply --local
 *   bun scripts/backfill-health-check-replies.ts --dry-run --remote
 *   bun scripts/backfill-health-check-replies.ts --apply --remote
 *
 * Idempotent — re-running on clean DB is no-op（reply 已是 summary 不是 raw JSON）。
 */

interface RequestRow {
  id: number;
  trip_id: string;
  reply: string | null;
}

// Mirror of functions/api/trips.ts TRIPID_RE — trip_id is interpolated into
// shell-built SQL below, so reject anything outside the canonical id charset.
const TRIPID_RE = /^[a-z0-9-]+$/;

interface CliFlags {
  apply: boolean;
  dryRun: boolean;
  local: boolean;
  remote: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  return {
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run'),
    local: argv.includes('--local'),
    remote: argv.includes('--remote'),
  };
}

function exec(cmd: string): string {
  const proc = Bun.spawnSync(['sh', '-c', cmd]);
  if (!proc.success) {
    throw new Error(`Command failed: ${cmd}\n${new TextDecoder().decode(proc.stderr)}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

function buildWranglerArgs(flags: CliFlags): string {
  if (flags.local) return '--local';
  if (flags.remote) return '--remote';
  throw new Error('必須指定 --local 或 --remote');
}

function queryRequests(flags: CliFlags): RequestRow[] {
  const wrangler = buildWranglerArgs(flags);
  const sql =
    "SELECT id, trip_id, reply FROM trip_requests " +
    "WHERE message LIKE '[AI 健檢]%' AND status = 'completed' " +
    "AND reply IS NOT NULL AND (reply LIKE '[%' OR reply LIKE '{%') " +
    'ORDER BY id';
  const out = exec(
    `bunx wrangler d1 execute trip-planner-db ${wrangler} --command="${sql}" --json`,
  );
  const parsed = JSON.parse(out) as Array<{ results: RequestRow[] }>;
  return parsed[0]?.results ?? [];
}

function updateReply(flags: CliFlags, id: number, newReply: string): void {
  const wrangler = buildWranglerArgs(flags);
  // single-quote escape: SQLite SQL strings escape '' = single '
  const escaped = newReply.replace(/'/g, "''");
  const sql = `UPDATE trip_requests SET reply = '${escaped}' WHERE id = ${id}`;
  exec(`bunx wrangler d1 execute trip-planner-db ${wrangler} --command="${sql}"`);
}

/**
 * Mirror of buildHealthCheckSummary from functions/api/requests/[id]/index.ts
 * （pure function，inline copy 避免跨 CF Pages handler / bun script import 邊界）。
 */
function buildHealthCheckSummary(findings: unknown[], tripId: string): string {
  const reportLink = `[前往健檢報告 →](/trip/${tripId}/health)`;
  if (findings.length === 0) {
    return `AI 健檢完成 — 行程沒發現問題。\n\n${reportLink}`;
  }
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const sev = (f as { severity?: string })?.severity;
    if (sev === 'high' || sev === 'medium' || sev === 'low') counts[sev]++;
  }
  const breakdown = (
    [
      counts.high > 0 ? `high ${counts.high}` : null,
      counts.medium > 0 ? `medium ${counts.medium}` : null,
      counts.low > 0 ? `low ${counts.low}` : null,
    ].filter(Boolean) as string[]
  ).join(' · ');
  return `AI 健檢完成 — 發現 ${findings.length} 個 finding（${breakdown}）。\n\n${reportLink}`;
}

function parseFindings(reply: string): unknown[] | null {
  try {
    const parsed = JSON.parse(reply);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.apply && !flags.dryRun) {
    console.error('必須加 --apply 或 --dry-run');
    process.exit(1);
  }
  if (!flags.local && !flags.remote) {
    console.error('必須加 --local 或 --remote');
    process.exit(1);
  }

  const target = flags.local ? 'local SQLite' : 'remote D1 prod';
  const mode = flags.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`backfill-health-check-replies.ts — target=${target} mode=${mode}`);

  console.log('1. 撈 trip_requests（[AI 健檢] + status=completed + reply 看似 JSON）...');
  const rows = queryRequests(flags);
  console.log(`   找到 ${rows.length} 個 candidate row`);

  const candidates: Array<{ id: number; tripId: string; oldReply: string; newReply: string }> = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const row of rows) {
    if (!row.reply) continue;
    const findings = parseFindings(row.reply);
    if (findings === null) {
      skipped.push({ id: row.id, reason: 'reply 不是 valid JSON array' });
      continue;
    }
    if (!TRIPID_RE.test(row.trip_id)) {
      skipped.push({ id: row.id, reason: `trip_id 不合法（${row.trip_id}）— 跳過` });
      continue;
    }
    const newReply = buildHealthCheckSummary(findings, row.trip_id);
    if (newReply === row.reply) {
      skipped.push({ id: row.id, reason: 'reply 已是 summary（idempotent skip）' });
      continue;
    }
    candidates.push({
      id: row.id,
      tripId: row.trip_id,
      oldReply: row.reply,
      newReply,
    });
  }

  console.log(`2. 需 backfill: ${candidates.length} row`);
  if (skipped.length > 0) {
    console.log(`   skip: ${skipped.length} row`);
    for (const s of skipped) console.log(`     #${s.id}: ${s.reason}`);
  }
  if (candidates.length === 0) {
    console.log('沒有 row 需 backfill — 結束');
    return;
  }

  console.log('\n預覽:');
  for (const c of candidates) {
    console.log(`  Request #${c.id} (trip: ${c.tripId})`);
    console.log(`    舊 (${c.oldReply.length} chars): ${c.oldReply.slice(0, 80)}...`);
    console.log(`    新 (${c.newReply.length} chars): ${c.newReply}`);
  }

  if (flags.dryRun) {
    console.log(`\n--dry-run 結束，沒寫入。要 apply 請加 --apply。`);
    return;
  }

  console.log(`\n3. UPDATE ${candidates.length} row 中...`);
  let updated = 0;
  for (const c of candidates) {
    try {
      updateReply(flags, c.id, c.newReply);
      updated++;
    } catch (err) {
      console.error(`  Request #${c.id} 失敗: ${(err as Error).message}`);
    }
  }
  console.log(`Done. ${updated}/${candidates.length} updated.`);
}

main();
