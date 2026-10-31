# trip-planner 對 Claude Design 通用規則的豁免與特化

本檔**不複製** DESIGN.md 的值（hex / 字體 / class / 10 色 palette / 字級）— 這些具體值以 DESIGN.md 為 single source of truth。本檔只記錄**豁免 reasoning**：為什麼原文的某條通用規則在本專案不適用，或需要特化。

**使用方式**：
- 需要 hex / 字體名稱 / class name / 色階 → **讀 `DESIGN.md`**（不是本檔）
- 需要知道「為什麼本專案可以違反原文 XX 規則」 → 讀本檔

---

## 1. Typography Override — 允許 Inter / Noto Sans TC

**原文立場**：
> "Avoid generic typefaces (Inter, Roboto, Arial, Fraunces, system)"

**豁免理由**：
- 原文「generic」指控基於**西方單一語系**脈絡；trip-planner 需要 CJK 字元支援，泛用字型的多語覆蓋性**正是需要的**
- Inter 是設計稿（Airbnb-inspired）指定字體，不是 AI 偷懶選擇
- DESIGN.md Decisions Log 有正式記錄此 shipped 決定

**仍適用**：不要引入**第三個**泛用字體（例如再加 Roboto 做強調）——那才是 slop。具體 weight / size 見 DESIGN.md Type Scale。

---

## 2. CSS Class Naming — `.ocean-*` 歷史保留

**豁免理由**：
- 本專案原本是 Ocean Blue 色系，class 全部用 `.ocean-*` 前綴；2026-04-24 回歸 Terracotta 暖橘色系
- **Class name 不 rename** — refactor 成本 > 一致性價值（破壞測試、git blame、跨檔 reference）
- DESIGN.md 開頭 legacy naming note 有正式說明

**適用範圍**：
- **既有 `.ocean-*` class 不 rename**（refactor 成本 > 一致性價值）
- **新 component 統一用 `.tp-*` 前綴**（不是 `.terracotta-*`，避免換 palette 時再次 refactor；不是無前綴，避免碰撞 Tailwind 保留字與第三方 class）
- 具體保留的 `.ocean-*` class name 清單見 DESIGN.md Components section
- 新 component 範例：`.tp-card`、`.tp-card-header`、`.tp-badge`；**不要**用 `.ocean-card` / `.terracotta-card` / `.card`

---

## 3. Color Protocol — 優先從 `tokens.css` 取值

**原文立場**：「Brand → oklch → Never Invent」

**本專案實作**：
- 三段優先序：（1）從 `css/tokens.css` 的 CSS variable 取（例：`var(--color-accent)`）；（2）需要延伸 token 時用 `oklch()` 從現有值推導；（3）**禁止**自創 hex
- 完整 palette（light + dark + semantic + DV）見 DESIGN.md Color section

**為何特化**：原文 brand→oklch 預設從零建 palette；trip-planner 已定版，直接取 CSS variable 更精確且避免 drift。

---

## 4. DV Palette — 已定 10 色，不自選

**豁免理由**：DESIGN.md Color > Data Visualization 例外 section 有完整 10 色定義（含色相角、OSM-safe 邏輯、interleave 排序），不需要重新選色。

**鐵律**：地圖 polyline / Day indicator / chart series 等 DV 情境**只用 DESIGN.md 定版的 10 色**。第 11 色 fallback 策略未定——真碰到再 propose。

---

## 5. Scale Standards — 以 DESIGN.md Type Scale 為準

**原文立場**：簡報 ≥24px、印刷 ≥12pt、觸控 ≥44px

**本專案實況**：trip-planner 是 mobile-first PWA，不做 presentation deck，24px 簡報標準**不適用**。具體 body / caption / touch target 最小值見 DESIGN.md Type Scale + Accessibility section。

**鐵律**：不要自己提高字級到 24px 去「符合原文」——本專案有自己的 scale。

---

## 6. Framework/Tool Stack 替代表

原文的 Claude Design 內建工具本專案沒有，對應使用：

| Claude Design 原工具 | trip-planner 對應 |
|---------------------|-------------------|
| `deck_stage.js`（簡報 1920×1080 / S4） | 不適用（不做 presentation） |
| `<script id="speaker-notes">` JSON 簡報註記（S5） | 不適用（不做 deck） |
| `[data-screen-label]` slide 標籤（S6） | 不適用（不做 deck） |
| `design_canvas.jsx`（多方案比較） | Write HTML 到系統暫存區 + 系統開啟指令（見 SKILL.md L4 平台對照） |
| `ios_frame.jsx` / `android_frame.jsx` | 不需要（本專案只跑 web） |
| `macos_window.jsx` / `browser_window.jsx` | 不需要（本專案無 desktop app 框；瀏覽器本身就是 host） |
| `animations.jsx` 動畫引擎 | 用 Tailwind `transition-*` + CSS `@keyframes`；不引第三方 animation lib（見 §7e） |
| `fork_verifier_agent`（背景驗證） | Agent tool 平行派遣 |
| `show_to_user`（中途預覽） | Write + 系統開啟指令 |
| `done`（最終交付） | /tp-team pipeline 7 階段 |
| `register_assets` 版本管理 | git commit + feature branch |
| `invoke_skill` | Claude Code `Skill` tool |
| `window.claude.complete` in-artifact API | 不使用（專案有 Cloudflare Workers backend） |
| EDITMODE JSON marker | 不使用（沒有互動式 tweak host） |
| `snip_context` silent cleanup | 不適用（trip-planner 是 SPA 非 artifact iteration lifecycle；git commit 即是 snapshot cleanup） |

## 7. Project-Specific Anti-Slop（trip-planner 特有紅旗）

除了原文 anti-slop，本專案還要特別避免（**具體值均見 DESIGN.md**）：

### 7a. 拒絕 rename `.ocean-*` CSS class
即使你覺得命名跟 Terracotta 主題不一致。refactor class = 破壞測試 + git blame。見 §2。

### 7b. 拒絕自創 Day 色（DV palette 外的新色）
使用者指定第 N 天顏色時，只用 DESIGN.md 定版 10 色裡的第 N 個。不要「創造一個介於 teal 和 emerald 之間」的色。見 §4。

### 7c. 拒絕改動 palette hex / 字體 family / 字級
所有色值、字體、字級的修改**必須走 `/design-consultation update`**，不要偷偷改 tokens.css 或 DESIGN.md。見 §3、§5。

### 7d. 拒絕引入新 icon library / SVG pack
本專案 icon 是 `src/components/shared/Icon.tsx` 的 inline SVG 系統。新 UI 需要圖示時**延伸這個系統**，不要 import lucide-react / heroicons / tabler-icons。

### 7e. 拒絕 tailwind 第三方 plugin
本專案 Tailwind CSS 4 + `tokens.css` @theme。不要加 tailwindcss-animate / daisyui / flowbite。

### 7f. 拒絕改動 `CSS @layer` 順序
`tokens.css` 的 `@layer` 順序已定。新樣式依既有 layer 規則插入，不要新增 layer。

---

## 衝突仲裁原則

遇到「原文這麼講 vs trip-planner 這麼做」衝突時：

1. **本專案已 ship 的決定**（DESIGN.md 有記錄） → 依本專案，不猶豫
2. **還沒 ship 的探索期**（新功能、新 page 第一次設計） → 依原文但 flag 給使用者知道有差異
3. **永遠告知使用者** override 的存在，不要偷偷做決定

**告知格式範例**：
> "原文 Claude Design 說 X，但本專案已定 Y（見 DESIGN.md Decisions Log 2026-04-XX）。我先用 Y。若要挑戰這個 shipped decision，走 /design-consultation update 流程。"

---

## 為什麼本檔不複製 DESIGN.md 的值

**Single-source-of-truth discipline**：
- DESIGN.md 更新時（例如改色、改字級），本檔**不需要**同步修改
- 避免兩份真理 drift 造成 skill 規則 stale
- 讀者找具體值應該只有一個地方（DESIGN.md），不是兩個
- 本檔專注於**為什麼做這個決定**（reasoning），不是**決定是什麼**（values）
