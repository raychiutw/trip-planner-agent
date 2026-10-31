---
name: tp-code-verify
description: commit 前驗證程式碼時使用 — 檢查命名規範、React Best Practices、Code Review 規則、CSS HIG、測試狀態（code verify、commit 前檢查、程式碼品質）。行程資料驗證用 /tp-check。
user-invocable: true
---

Commit 前程式碼品質驗證。驗證命名規範 + React Best Practices + Code Review 規則 + CSS HIG + 測試全過，紅燈則持續修改直到綠燈。

⚡ prompt 有指定檔案或範圍時，以 prompt 為準；否則使用以下預設範圍。

## 驗證規則來源

規則範疇由本 skill 的驗證項目定義，以下為各規則實作檔案：

- 命名規範：`../references/naming-rules.md`
- 程式碼標準：`../references/coding-standards.md`
- CSS HIG 規則（H1-H12）：skill `tp-ux-verify`（`../references/css-hig-rules.md` + `../tp-ux-verify/references/tokens.md` + `../tp-ux-verify/references/page-structure.md`）
- React Best Practices（完整 62 條）：skill `react-best-practices`（`SKILL.md` 索引 + `rules/*.md` 各規則詳情）
- Code Review 規則（完整 10 條）：`../references/code-review-rules.md`

## 預設檢查範圍

檢查範圍定義詳見 `../references/coding-standards.md`。

```
src/         entries/*.tsx  pages/*.tsx  components/**/*.tsx  hooks/*.ts  lib/*.ts  types/*.ts
css/         tokens.css（Tailwind CSS 4 @theme）
functions/   api/**/*.ts（所有 Pages Functions）
tests/       unit/*.test.js  integration/*.test.js  e2e/*.spec.js
*.html       index.html  manage/index.html  admin/index.html（根目錄）
```

**排除**：`node_modules/`、`.wrangler/`、`.playwright-mcp/`、`.claude/`、`.gemini/`、`package*.json`、`wrangler.toml`、`migrations/*.sql`、`scripts/*.ps1`、`scripts/*.sh`、`tests/e2e/api-mocks.js`（mock 資料）

## 步驟

1. 執行 `npx tsc --noEmit` — TypeScript 型別檢查（src/ 有變更時）
2. 執行 `npx tsc --noEmit -p tsconfig.functions.json` — Functions 型別檢查（functions/ 有變更時）
3. 執行 `npm test` — 前端 unit/integration 測試
4. 執行 `npm run test:api` — API integration 測試（Miniflare D1，functions/ 有變更時）
5. 若 src/ 有變更，掃描 React Best Practices（RBP-1 ~ RBP-14）+ Code Review 規則（CR-1 ~ CR-10）
6. 若 css/ 或 src/ 或 html/ 有變更，掃描 CSS HIG 規則（H1-H12）— 讀取 skill `tp-ux-verify` 的規則來源
7. 若 functions/ 有變更，確認 API handler 用 `throw new AppError('CODE')` 而非 `return json({error}, status)`
8. 若全過 → 🟢 綠燈，可以 commit
9. 若有失敗 → 🔴 紅燈：
   a. 列出所有失敗的測試名稱、錯誤訊息、違規規則
   b. 根據錯誤類型自動修正：
      - 命名違規：根據 `../references/naming-rules.md` 修正
      - CSS HIG 違規：根據 skill `tp-ux-verify` 的 `../references/css-hig-rules.md` 修正
      - React 違規：根據 skill `react-best-practices` 的 `rules/*.md` 修正
      - Code Review 違規：根據 `../references/code-review-rules.md` 修正
      - 測試失敗：分析原因並修正程式碼
   c. 重新跑步驟 1-4
   d. 重複直到全過

## 驗證項目

### 原有規則（#1-16）

| # | 項目 | 參照 |
|---|------|------|
| 1 | JS 函式命名（camelCase） | `../references/naming-rules.md` |
| 2 | JS 常數命名（UPPER_SNAKE_CASE） | `../references/naming-rules.md` |
| 3 | JS 可變狀態（camelCase，不得 UPPER_CASE） | `../references/naming-rules.md` |
| 4 | CSS class（kebab-case） | `../references/naming-rules.md` |
| 5 | CSS custom property（--kebab-case） | `../references/naming-rules.md` |
| 6 | HTML 靜態 ID（camelCase） | `../references/naming-rules.md` |
| 7 | HTML data 屬性（kebab-case） | `../references/naming-rules.md` |
| 8 | API tripId（`SELECT id AS tripId`） | `../references/naming-rules.md` |
| 9 | 無防禦性 tripId（不得 `.id \|\| .tripId`） | `../references/naming-rules.md` |
| 10 | mapRow 統一轉換 | `../references/naming-rules.md` |
| 11 | CSS HIG 12 條（H1-H12） | skill `tp-ux-verify` → `../references/css-hig-rules.md` |
| 12 | Unit tests 全過 | — |
| 13 | 觸控目標 44px | `../references/coding-standards.md` |
| 14 | 圖示 inline SVG | `../references/coding-standards.md` |
| 15 | 無框線設計 | `../references/coding-standards.md` |
| 16 | border-radius 5 級 token | `../references/coding-standards.md` |

### React Best Practices（#17-31，僅 src/ 變更時檢查）

完整 62 條規則見 skill `react-best-practices`（`SKILL.md` 索引 + `rules/*.md` 各規則詳情）。
以下為本專案強制檢查的子集：

| # | 規則 | 檢查方式 | 規則詳情 |
|---|------|----------|----------|
| 17 | async-parallel | 掃描連續 `await` 獨立 fetch | `react-best-practices/rules/async-parallel.md` |
| 18 | async-defer-await | 掃描分支外的提前 await | `react-best-practices/rules/async-defer-await.md` |
| 19 | rerender-use-ref-transient-values | 掃描 scroll/resize handler 中的 setState | `react-best-practices/rules/rerender-use-ref-transient-values.md` |
| 20 | rerender-no-inline-components | 掃描 function 內的 `function Component` / `const Component =` | `react-best-practices/rules/rerender-no-inline-components.md` |
| 21 | rerender-memo-with-default-value | 掃描 JSX 中 `style={{` / `options={[` | `react-best-practices/rules/rerender-memo-with-default-value.md` |
| 22 | rerender-dependencies | 掃描 useEffect 依賴陣列中的 object 變數 | `react-best-practices/rules/rerender-dependencies.md` |
| 23 | rerender-derived-state-no-effect | 掃描 `useEffect` → `setState` 用於可推導值 | `react-best-practices/rules/rerender-derived-state-no-effect.md` |
| 24 | rendering-conditional-render | 掃描 `{xxx.length &&` 或 `{count &&` 模式 | `react-best-practices/rules/rendering-conditional-render.md` |
| 25 | rendering-hoist-jsx | 檢查 early-return JSX 是否為 module-level 常數 | `react-best-practices/rules/rendering-hoist-jsx.md` |
| 26 | client-passive-event-listeners | 掃描 `addEventListener('scroll'` / `'resize'` 無 passive | `react-best-practices/rules/client-passive-event-listeners.md` |
| 27 | bundle-barrel-imports | 檢查 `src/` 下不存在 `index.ts` re-export | `react-best-practices/rules/bundle-barrel-imports.md` |
| 28 | bundle-dynamic-imports | 條件渲染的大型元件是否用 `React.lazy` | `react-best-practices/rules/bundle-dynamic-imports.md` |
| 29 | js-set-map-lookups | 掃描 `.map()` 內的 `.find()` / `.includes()` | `react-best-practices/rules/js-set-map-lookups.md` |
| 30 | js-combine-iterations | 掃描同一陣列的連續 `.map().filter()` | `react-best-practices/rules/js-combine-iterations.md` |
| 31 | TypeScript 零錯誤 | `npx tsc --noEmit` | — |

### Code Review 規則（#32-41，僅 src/ 變更時檢查）

| # | 規則 | 檢查方式 | 參照 |
|---|------|----------|------|
| 32 | CR-1 Hook 不可直接操作同一 DOM | 掃描多個 hook 中的 `classList.add/remove` 同一 class | `../references/code-review-rules.md` |
| 33 | CR-2 useEffect cancelled guard | 掃描含 async 的 useEffect 是否有 cancelled flag | `../references/code-review-rules.md` |
| 34 | CR-3 無重複函式定義 | Grep 新增/修改的函式名稱，確認無 duplicate | `../references/code-review-rules.md` |
| 35 | CR-4 共用 apiFetch | 掃描 `src/` 中的 raw `fetch('/api` 呼叫 | `../references/code-review-rules.md` |
| 36 | CR-5 元件包裝不重複 | 檢查 wrapper 元件是否雙重包裝 | `../references/code-review-rules.md` |
| 37 | CR-6 建好的元件必須接入 | 掃描 export 但未 import 的元件 | `../references/code-review-rules.md` |
| 38 | CR-7 type assertions 最小化 | 計算 `as never` 和 `as unknown as` 數量 | `../references/code-review-rules.md` |
| 39 | CR-8 render loop 無 O(n²) | 掃描 `.map()` 內的 `.find()` | `../references/code-review-rules.md` |
| 40 | CR-9 React key 穩定唯一 | 掃描有 `id` 欄位的資料仍用 `key={i}` | `../references/code-review-rules.md` |
| 41 | CR-10 多態型別用 discriminated union | 掃描 `as unknown as SomeType[]` 強制轉型 | `../references/code-review-rules.md` |
