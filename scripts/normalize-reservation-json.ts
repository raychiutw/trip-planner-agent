/**
 * normalize-reservation-json.ts — 一次性清理 prod trip_entry_pois.reservation 的 JSON 污染。
 *
 * 背景：reservation 設計上是文字註解，但 AI 生成路徑曾把結構化訂位狀態寫成 JSON
 * （{"available","method","url"/"phone","recommended"}），prod 43 筆污染、前端露 raw {...}。
 *
 * 本 script（使用者拍板 A）：把每筆 JSON 的有用資訊用 reservationJsonToText 轉成人話，
 * **append 進該 POI 的 note 備註**（保留原 note，換行分隔），再把 reservation 清空（NULL）。
 * 純文字 reservation（56 筆「官網預約」等）不動。
 *
 * 用法（**必在 D 寫入防堵 deploy 上線後才跑**，否則清完 AI 又寫新 JSON）：
 *   1. 重新抓最新 43 筆備份：
 *      npx wrangler d1 execute trip-planner-db --remote --json --command \
 *        "SELECT id, note, reservation FROM trip_entry_pois WHERE reservation LIKE '{%' OR reservation LIKE '[%' ORDER BY id" \
 *        | python3 -c "import sys,json;s=sys.stdin.read();i=s.find('[');json.dump(json.loads(s[i:])[0]['results'],open('/tmp/resv-rows.json','w'),ensure_ascii=False)"
 *   2. 產生 SQL（dry-run 預覽）：  npx tsx scripts/normalize-reservation-json.ts /tmp/resv-rows.json
 *   3. 檢視 /tmp/normalize-reservation.sql，確認無誤
 *   4. Apply：  npx wrangler d1 execute trip-planner-db --remote --file /tmp/normalize-reservation.sql
 *
 * 冪等：reservation 已清空（非 JSON）的列不會被選中（WHERE reservation LIKE '{%'），重跑安全。
 */
import fs from 'node:fs';
import { reservationJsonToText } from '../functions/api/_reservation';

interface Row {
  id: number;
  note: string | null;
  reservation: string | null;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法：npx tsx scripts/normalize-reservation-json.ts <rows.json>');
  process.exit(1);
}

const rows: Row[] = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
/** SQLite 字串字面值 escape：single quote → ''。 */
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const now = new Date().toISOString();

const stmts: string[] = [];
const preview: string[] = [];
let skipped = 0;
for (const r of rows) {
  const text = reservationJsonToText(r.reservation);
  if (text === null) {
    // 非 JSON（不該被 WHERE 選中）→ 保守跳過，不動。
    skipped++;
    continue;
  }
  // 有用資訊 append 進 note（保留原 note，換行分隔）；reservation 清空。
  const newNote = r.note && r.note.trim() ? `${r.note}\n${text}` : text;
  stmts.push(
    `UPDATE trip_entry_pois SET note=${sqlStr(newNote)}, reservation=NULL, updated_at=${sqlStr(now)} WHERE id=${r.id};`,
  );
  preview.push(`  id=${r.id}  reservation(JSON)→note += "${text}"`);
}

const outPath = '/tmp/normalize-reservation.sql';
fs.writeFileSync(outPath, stmts.join('\n') + '\n');

console.log(`輸入 ${rows.length} 筆，產生 ${stmts.length} 筆 UPDATE${skipped ? `，跳過 ${skipped} 筆非 JSON` : ''}。`);
console.log('dry-run 預覽：');
console.log(preview.slice(0, 12).join('\n'));
if (preview.length > 12) console.log(`  …（其餘 ${preview.length - 12} 筆）`);
console.log(`\nSQL 已寫到 ${outPath}。檢視無誤後 apply：`);
console.log(`  npx wrangler d1 execute trip-planner-db --remote --file ${outPath}`);
