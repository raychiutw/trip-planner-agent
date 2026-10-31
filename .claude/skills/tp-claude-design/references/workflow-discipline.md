# L3 — Workflow Discipline（6 步驟產出流程）

任何 UI / visual / prototype 產出任務都依這 6 步走。不是「寫 code 完再檢查」的線性流程，而是「早期與使用者對齊 → 迭代修正」的 junior → manager 模式。

## 01. Understand & Ask（開局釐清）

**目標**：確認**做什麼、做給誰看、交付形式、約束條件**。

**questions_v2 梯度**（按 spec 完整度決定問題數，**不要二元閾值**）：

| spec 完整度 | 問題數 | 說明 |
|------------|-------|------|
| 完全從零（只有一句話需求） | 10 題（≥4 problem-specific） | 標準 questions_v2 |
| 有 palette + 版面元素（例：「Terracotta + Hero + 3 cards + CTA」） | 4–6 題 problem-specific | 針對未明 dimension 各問 1 題，不湊通用題 |
| 有完整 DESIGN.md-aligned spec | 0–2 題 | 只問 clarification（歧義字眼釐清） |
| 既有 pattern 小延伸 | 0 題 | 例：加一個 row 到 existing card |

**未明 dimension 清單**（按需挑，每個選中 dimension 各給 1 題）：
- 目標受眾（開發者 / 非技術決策者 / 現有使用者）
- 主 CTA 動作（signup / demo / docs / contact）
- Dark mode 是否支援
- Mobile / desktop priority
- 交付形式（HTML mockup / 整合進 SPA React / 兩者）
- SEO meta / OG image 是否本輪處理
- 社會認證（logo wall / testimonial / user count）
- Hero 視覺類型（image / video / 純文字 / illustration）
- 整合進 SPA 還是獨立 page
- 是否影響既有 navigation / IA
- 資料來源（demo trip id？mock data？real D1 query？）

**所有問題必須包含三個選項**：
- `A) Explore a few options`（多方案）
- `B) Decide for me`（你決定）
- `C) Other`（使用者自行補）

**反模式：別用「spec 已明確可 skip」當 rationalization skip 整個 questions_v2**。使用者給了 palette + 版面不代表給齊所有 dimension；上表 4–6 題 problem-specific 的作用就是擋住這個 shortcut。

**範例好問題**（針對新 landing page）：
1. 主 CTA 是 signup / demo / docs / contact 哪一個？
2. 目標受眾：開發者 / 非技術決策者 / 現有使用者？
3. 需要顯示社會認證（logo wall / testimonial / user count）嗎？
4. Hero 要 image / video / 純文字 / illustration？
5. 桌機 priority 還是 mobile priority？
6. 要考慮 dark mode 嗎？
7. 預計用多少色？（accent 1 / secondary 2 / 全譜色階）
8. 是否整合進 SPA（React router）還是獨立 page？
9. SEO meta / OG image 需要在這輪處理嗎？
10. 交付形式：mockup（HTML）/ 整合進專案 React code / 兩者？

## 02. Explore Context（讀脈絡）

**永遠不要從零開始**。先讀：
- `DESIGN.md` — 設計系統決定
- `css/tokens.css` — CSS variable 實作
- `src/components/` — 現有 component pattern
- 類似頁面的 screenshot / 既有實作
- 如果使用者提供 Figma / mockup，讀完再動手

**trip-planner 脈絡檔案清單**：
```
DESIGN.md                          # palette / typography / spacing / principles
css/tokens.css                     # CSS variables
src/components/shared/*.tsx        # Icon, Toast, ErrorBoundary 等共用
src/components/trip/*.tsx          # Timeline, DayNav, DaySection, StopCard 等
src/pages/*.tsx                    # TripPage, ManagePage, MapPage, StopDetailPage
.claude/skills/tp-ux-verify/       # H1-H12 HIG 規範 + tokens 速查
```

## 03. Plan Todos（規劃步驟）

用 TodoWrite / TaskCreate tool 列出步驟。典型 UI 任務：

1. Clarify intent（如果 step 01 沒 skip）
2. Read existing context files
3. Propose 3+ variants（paper / markdown / 簡易 HTML sketch）
4. User picks variant
5. Build chosen variant in production format
6. Self-verify against anti-slop checklist
7. Show to user early
8. Iterate on feedback
9. Final polish
10. Hand off to `/tp-team` pipeline（若要合併進 production code）

## 04. Build & Show Early — 最關鍵原則

**不要憋到完美再給看**。像 junior designer 給 manager review：
- 先做 60% 完成度的 draft
- 註明你的 assumptions（「我假設你要深色底」「我先用 placeholder 圖」）
- 標明沒把握的地方（「hero copy 我先放 Lorem，你看需要什麼 tone」）
- **立刻**丟給使用者看（以 HTML 為例：Write 到系統暫存區 — Unix `/tmp/file.html`、Windows `$env:TEMP\file.html` — 再用系統開啟指令 — Windows `Start-Process`、macOS `open`、Linux `xdg-open`）

**為什麼這很重要**：
- 使用者的「品味」資訊只會在看到具體東西時才浮現
- 早期發現方向錯比完美實作錯的方向好 100 倍
- 使用者看到 draft 比看到文字描述更能準確指點

**適合 show-early 的中途產出**：
- Wireframe 線框（純灰階 + 方塊 + 文字）
- Color variant 拼貼（同一 layout 套 3 色系）
- Layout grid 線稿（不填內容，只看結構）
- 單一 section 的 polish sample

## 05. Verify（交付前驗證）

**兩段驗證**：

**Phase 1 — 即時 console check**（相當於原文 `done()`）：
```bash
# 若是 React code 在 src/ 裡
npx tsc --noEmit                           # 型別
npm test -- --run tests/unit/xxx.test.tsx  # 單元測試
```

**Phase 2 — 深度檢查**（相當於原文 `fork_verifier_agent`，silent on pass）：
- 派 Agent tool 做 anti-slop 稽核（對照 anti-slop-checklist.md）
- `/browse` 或 `/design-review` 做視覺截圖驗證
- 對比 DESIGN.md 的 token 是否被違反（tp-ux-verify H1-H12）

**只有發現問題時才吵主 agent**。沒問題靜默通過。

## 06. Brief Summary（交付總結）

報告時：
- ✅ 只提 caveats（哪些我還沒把握、哪些我 skip 了）
- ✅ 只提 next steps（使用者接下來可以做什麼）
- ❌ **不要**把 diff 一行一行念出來
- ❌ **不要**把 spec 再重複一次

**範例**：

> **做完了**：3 個 variant 在 `/tmp/terracotta-landing-{a,b,c}.html`。
>
> **我沒把握的**：
> - Hero image 我用 placeholder，你可能要換真圖
> - Variant B 的 stat card 密度我覺得太擠，是否接受由你決定
>
> **下一步**：
> - 選 variant（或 remix）
> - 若要合進 production：走 /tp-team pipeline

## 3+ Variant 紀律

**為什麼永遠至少 3 個變體**：
- 單一方案 = 你在賭使用者品味
- 3 個變體 = 使用者可比較，資訊密度 3x
- 3 個變體讓使用者看到「你理解了可能性空間」而不是「你猜對了」

**3 個變體該沿哪個維度分**（挑一個明顯的軸）：
- Color palette（Terracotta vs. Warm Sunset vs. Muted Earth）
- Layout density（Spacious / Balanced / Compact）
- Typography hierarchy（Type-led / Image-led / Data-led）
- Interaction style（Calm / Playful / Information-dense）

**不要在所有軸同時變動**——會變成「3 個完全無關的設計」而非「同主題 3 個角度」。

**保守 → 大膽 progression**（原文 L2-8 獨有的探索策略）：

| Variant | 位置 | 做法 |
|---------|------|------|
| **A（保守）** | 最 safe，最 close 既有 codebase pattern | 例：完全照既有 TripCard 結構加新 section，只調 spacing |
| **B（中間）** | 取 A 為底 + 適度冒險 | 例：保留結構但換 typography scale 或加細節動效 |
| **C（大膽）** | 挑戰既有 pattern、可能改 layout 軸 | 例：從列式改卡片網格、Hero 從 left-aligned 改 centered |

**為什麼這樣排**：使用者看 A 知道「底線」（即使放棄設計也不會崩），看 C 知道「天花板」（最多可以冒險到哪），看 B 是 remix 素材。單給一方案使用者**不知道還有多少 headroom 可以冒險** — 這正是單變體的資訊密度損失。從 A 起步也讓後續 iteration 有安全的 rollback 選項。

## 失敗模式（這些在 workflow 裡是紅旗）

- ✗ 沒讀 DESIGN.md 就開做
- ✗ 自己做完 100% 才給看
- ✗ 只做 1 個方案（「這個最好」）
- ✗ 交付時 dump 整份 diff
- ✗ 沒 verify 就說「完成」
- ✗ 把 assumptions 藏在心裡不講
- ✗ 硬用 Lorem Ipsum 填空位
