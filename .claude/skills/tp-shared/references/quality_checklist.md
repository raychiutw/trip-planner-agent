# tp-* Skills Quality Checklist

最後更新：2026-04-08 | 審計範圍：13 個 tp-* skills + tp-shared

## 格式確認

| 項目 | 狀態 | 備註 |
|------|:---:|------|
| 所有 SKILL.md 有 YAML frontmatter | ✅ | name + description 齊全 |
| frontmatter name 與目錄名一致 | ✅ | 13/13 |
| description ≤ 3 句 | ✅ | 全部 1 句 |
| description 含 trigger language | ✅ | 全部中文 + 括號內含觸發關鍵詞（2026-04-08 從英文改為中文） |
| user-invocable 標註正確 | ✅ | 10 個 true、3 個 false（quality-rules, search-strategies, ux-verify） |
| format_check.py 結果 | ⚠️ | `user-invocable` 非 OpenClaw 標準 key → Claude Code 平台專用，非錯誤 |

## 要求/規範確認

| 項目 | 狀態 | 備註 |
|------|:---:|------|
| 單一 API base URL | ✅ | 統一 `trip-planner-dby.pages.dev`，定義在 tp-shared |
| 認證 headers 定義 | ✅ | Authorization/Secret 定義在 tp-shared |
| Windows encoding 規避 | ✅ | curl + 中文 → node writeFileSync + --data @file |
| 品質規則單一來源 | ✅ | R0-R18 定義在 tp-quality-rules，其他 skill 引用 |
| 搜尋策略單一來源 | ✅ | googleRating 策略定義在 tp-shared + tp-search-strategies |
| 共用修改流程 | ✅ | tp-shared「行程修改共用步驟」被 tp-edit + tp-request 引用 |
| Doc 連動規則 | ✅ | 定義在 tp-shared，被 tp-edit + tp-request + tp-rebuild 引用 |
| travel 語意 | ✅ | 定義在 tp-shared，語意一致 |
| Claude ↔ Gemini 同步 | ✅ | 14 個 skill 已同步（2026-04-01） |

## Credential / Env / Persistence 盤點

| 變數/路徑 | 用途 | 使用 skill | 來源 |
|-----------|------|-----------|------|
| `TRIPLINE_API_TOKEN` | D1 API 認證 | tp-create, tp-patch, tp-request | `.env.local` |
| `TRIPLINE_API_TOKEN` | D1 API 認證 | tp-create, tp-patch, tp-request | `.env.local` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API | tp-daily-check | shell profile / `.env.local` |
| `CF_ACCOUNT_ID` | Cloudflare account | tp-daily-check | shell profile / `.env.local` |
| `D1_DATABASE_ID` | D1 database ID | tp-daily-check | shell profile / `.env.local` |
| `SENTRY_AUTH_TOKEN` | Sentry API | tp-daily-check | shell profile / `.env.local` |
| `SENTRY_ORG` / `SENTRY_PROJECT` | Sentry project | tp-daily-check | shell profile / `.env.local` |
| `BROWSE_BIN`（選填） | browse binary 路徑 | tp-create | 自動 fallback |
| `/tmp/*.json` | curl --data @file 暫存 | tp-create, tp-patch, tp-request | 自動清理 |
| `/tmp/api-helper.js` | API 呼叫 helper | tp-create | session 內有效 |

**無 secret 洩漏風險**：所有 credential 從環境變數讀取，skill 內容不含實際值。

## 常見錯誤確認

| 項目 | 狀態 | 備註 |
|------|:---:|------|
| 無「原 MD」殘留標注 | ✅ | S3 已修正 |
| 無過時檔案路徑 | ✅ | S1 已更新 file scope |
| reference 路徑可解析 | ✅ | 全部改為 `../references/` 相對路徑 |
| googleRating 策略無重複定義 | ✅ | L1 已統一引用 tp-shared |
| tp-rebuild-all 已移除 | ✅ | 完全整合到 tp-rebuild --all |
| Gemini 無過時 skill | ✅ | M6 已清除 tp-deploy/tp-run/tp-shutdown/tp-hig |
| browse binary 路徑可攜 | ✅ | M2 已加 USERPROFILE fallback |

## Overlap 邊界確認

| pair | 邊界清楚 | 判斷依據 |
|------|:---:|------|
| tp-check vs tp-rebuild | ✅ | 只讀驗證 vs 讀+改修復 |
| tp-edit vs tp-request | ✅ | 直接指令 vs 旅伴請求（安全邊界） |
| tp-edit vs tp-patch | ✅ | 單一行程任意修改 vs 跨行程批次補欄位 |
| tp-rebuild --all | ✅ | 批次模式已內建，tp-rebuild-all 已移除 |
| tp-team vs tp-code-verify | ✅ | 完整 pipeline vs Review 子步驟 |
| tp-check vs tp-daily-check | ✅ | 手動驗證 vs 排程自動 + Telegram |

## 已知限制（非錯誤，記錄備查）

1. ~~**tp-create Phase 2 browse 腳本仍內嵌**~~ → ✅ 已移至 `tp-create/references/browse-rating-script.md`（2026-04-08）
2. **tp-patch 保留自己的 API 設定段** — 與 tp-shared 重複但含 target/field 指令格式，暫不合併
3. **tp-request 保留 inline curl 範例** — 安全邊界的 X-Request-Scope header 是獨特的，保留有助於強調

## 深度檢核（2026-04-01 — 對照 API handler + DB schema）

| # | 嚴重度 | 問題 | 修正狀態 |
|---|:---:|------|:---:|
| D1 | 🔴 | tp-quality-rules R0 `travel.text` 應為 `travel.desc` | ✅ 已修正 |
| D2 | 🔴 | tp-shared hotel 欄位混淆 pois master vs trip_pois | ✅ 已拆分兩張表格（v2.29.0 後 trip_pois DROPPED，飯店改 `trip_days.hotel_poi_id` FK，entry POI 改 `trip_entry_pois`）|
| D3 | 🟡 | PATCH /entries/:eid travel 用 flat fields 未記載 | ✅ 已補註 |
| D4 | 🟡 | POST /trip-pois 缺 context 欄位說明 | ✅ 已補（後 v2.29.0：`context` 欄位 obsolete，`trip_pois` 表 DROPPED；endpoint 名稱保留但寫入 `trip_entry_pois`）|
| D5 | 🟡 | tp-request 禁 PUT /days 但共用步驟未標註 | ✅ 已加標註 |
| D6 | 🟢 | pois.type 允許值未列出 | ✅ 已補 7 個值 |

| N1 | 🟡 | tp-create 用 `location.googleQuery` 但 PUT /days/:num 只接受 `maps` | ✅ 改為 `maps` + 補 PATCH 說明 |

驗證方法：兩個 Explore agent 分別讀取 `functions/api/` 全部 handler + `migrations/` 全部 schema，交叉比對 skill 描述。第三輪針對 PUT /days/:num entry 結構做精確欄位比對。

## 最終判定

## 2026-04-08 Portfolio Audit 修正紀錄

| # | 嚴重度 | 問題 | 修正 |
|---|:---:|------|------|
| C1 | 🔴 | tp-edit 步驟 7 編號重複 | ✅ 修正為 7→8→9 |
| C2 | 🔴 | tp-daily-check 引用 Windows Task Scheduler | ✅ 更新為 macOS 排程 |
| C3 | 🔴 | tp-request 引用 Windows Task Scheduler | ✅ 更新為本機排程 |
| R1 | 🟡 | tp-create 218 行無 references/，inline JS 模板 | ✅ 拆出 api-helper-template.md + browse-rating-script.md（155 行，-29%） |
| R2 | 🟡 | tp-check 156 行無 references/，report + severity inline | ✅ 拆出 report-format.md + severity-thresholds.md（89 行，-43%） |
| R3 | 🟡 | tp-shared references.md vs references/ 角色不清 | ✅ SKILL.md 加文件結構表 |
| R4 | 🟡 | quality_checklist Credential 表引用 PowerShell | ✅ 更新為 shell profile / .env.local |
| T1 | 🔴 | 全英文 description 導致中文查詢 under-trigger（trigger eval baseline: 20% hit rate） | ✅ 13 個 skill description 全部改為中文 + 觸發關鍵詞 |

## 最終判定

**PASS** — 13 個 tp-* skills + tp-shared 已通過 portfolio audit、format check、credential audit、overlap eval、API/schema 深度交叉比對。progressive disclosure 改善後 SKILL.md 總行數降至 1,167（-10%）。
