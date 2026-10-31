#!/usr/bin/env bun
/**
 * backfill-poi-addresses.ts — one-shot backfill: clean existing pois.address
 * doubled admin suffix typo (號號 / 縣縣 等).
 *
 * v2.31.36 fix #137：v2.31.36 起 google-client.ts search/details 都 apply
 * normalizePoiAddress 於 write boundary，新進 row 永不會 cache typo。但 existing
 * pois.address column 有歷史「736 號號地下一層」這類 row，須一次性 backfill。
 *
 * Strategy:
 *   1. SELECT id, address FROM pois WHERE address LIKE '%XX%' OR address LIKE '%X X%' ...
 *      （doubled admin suffix candidate filter）
 *   2. Apply normalizePoiAddress
 *   3. If 改 → UPDATE pois SET address = ? WHERE id = ?
 *
 * Usage:
 *   bun scripts/backfill-poi-addresses.ts --dry-run --local    # local SQLite
 *   bun scripts/backfill-poi-addresses.ts --apply --local
 *   bun scripts/backfill-poi-addresses.ts --dry-run --remote   # prod D1
 *   bun scripts/backfill-poi-addresses.ts --apply --remote
 *
 * Idempotent — multiple runs converge. Re-running on already-clean DB is no-op.
 */
import { normalizePoiAddress } from '../src/lib/maps/normalize-address';

interface PoiRow {
  id: number;
  address: string | null;
}

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

function exec(argv: string[]): string {
  const proc = Bun.spawnSync(argv);
  if (!proc.success) {
    throw new Error(`Command failed: ${argv.join(' ')}\n${new TextDecoder().decode(proc.stderr)}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

function buildWranglerArgs(flags: CliFlags): string {
  if (flags.local) return '--local';
  if (flags.remote) return '--remote';
  throw new Error('必須指定 --local 或 --remote');
}

function queryPois(flags: CliFlags): PoiRow[] {
  const wrangler = buildWranglerArgs(flags);
  // 撈所有有 address 的 row（normalize 是 pure function，過濾無 typo 在 JS 端做）
  const sql = "SELECT id, address FROM pois WHERE address IS NOT NULL AND address != '' ORDER BY id";
  const out = exec([
    'bunx',
    'wrangler',
    'd1',
    'execute',
    'trip-planner-db',
    wrangler,
    '--command',
    sql,
    '--json',
  ]);
  // wrangler d1 --json: array with one element per statement, each has {results:[]}
  const parsed = JSON.parse(out) as Array<{ results: PoiRow[] }>;
  return parsed[0]?.results ?? [];
}

function updateAddress(flags: CliFlags, id: number, newAddress: string): void {
  const wrangler = buildWranglerArgs(flags);
  // single-quote escape: SQLite SQL strings escape '' = single '
  const escaped = newAddress.replace(/'/g, "''");
  const sql = `UPDATE pois SET address = '${escaped}', updated_at = datetime('now') WHERE id = ${id}`;
  exec(['bunx', 'wrangler', 'd1', 'execute', 'trip-planner-db', wrangler, '--command', sql]);
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
  console.log(`backfill-poi-addresses.ts — target=${target} mode=${mode}`);

  console.log('1. 撈 pois (address IS NOT NULL)...');
  const rows = queryPois(flags);
  console.log(`   找到 ${rows.length} 個有 address 的 POI`);

  const candidates: Array<{ id: number; oldAddr: string; newAddr: string }> = [];
  for (const row of rows) {
    if (!row.address) continue;
    const cleaned = normalizePoiAddress(row.address);
    if (cleaned !== null && cleaned !== row.address) {
      candidates.push({ id: row.id, oldAddr: row.address, newAddr: cleaned });
    }
  }

  console.log(`2. 需 backfill: ${candidates.length} row`);
  if (candidates.length === 0) {
    console.log('沒有 row 需 normalize — 結束');
    return;
  }

  // Print preview (前 20 個)
  console.log('\n預覽（前 20 個）:');
  for (const c of candidates.slice(0, 20)) {
    console.log(`  POI #${c.id}`);
    console.log(`    舊: ${c.oldAddr}`);
    console.log(`    新: ${c.newAddr}`);
  }
  if (candidates.length > 20) {
    console.log(`  ... 還有 ${candidates.length - 20} 個`);
  }

  if (flags.dryRun) {
    console.log(`\n--dry-run 結束，沒寫入。要 apply 請加 --apply。`);
    return;
  }

  console.log(`\n3. UPDATE ${candidates.length} row 中...`);
  let updated = 0;
  for (const c of candidates) {
    try {
      updateAddress(flags, c.id, c.newAddr);
      updated++;
    } catch (err) {
      console.error(`  POI #${c.id} 失敗: ${(err as Error).message}`);
    }
  }
  console.log(`✅ Done. ${updated}/${candidates.length} updated.`);
}

main();
