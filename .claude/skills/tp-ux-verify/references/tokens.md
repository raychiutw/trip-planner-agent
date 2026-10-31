# Design Tokens 速查表

token 定義在 **`css/tokens.css`**，**大部分**在 `@theme` 區塊，但有三組不在：sheet 動畫（`--ease-spring`／`--ease-sheet-close`／`--duration-sheet-*`／`--duration-nav-fade`）與 `--scrollbar-thumb*`／`--z-info-sheet*` 定義在額外的 `:root` block，`--tp-form-input-*` 只在 `.tp-form--auth` 這個 component-scoped selector 裡（其他呼叫點靠 `var(--tp-form-input-pad-y, 10px)` 這類 fallback 運作）。

**權威來源是該檔案，本表只列 token 名與用途、不複製色值** —— 這份文件上一版把 6 套主題的色值全表複製進來，主題退場後整份腐爛了兩年沒人發現。要查值，去讀 `css/tokens.css`。

## 主題模型

**Single-theme。** 不是多主題系統：

- 預設（light）在 `@theme` 區塊
- `body.dark` 覆寫 dark mode
- `body.theme-print` 列印專用（無 dark 變體）

`theme-sun` / `theme-sky` / `theme-zen` / `theme-forest` / `theme-sakura` / `theme-night` **全部不存在**（多主題已退場）。`tests/unit/tokens-css.test.ts` 有斷言鎖住這個不變量 —— 看到任何文件或程式碼提到這些 class，那是過期資訊。

## Color

### 主色（單一柔褐 accent）

| Token | 用途 |
|-------|------|
| `--color-accent` | 主色（柔褐 terracotta） |
| `--color-accent-deep` | 加深，active 狀態用 |
| `--color-accent-subtle` | 最淺 tonal 底（selection） |
| `--color-accent-bg` | tonal 背景（卡片／按鈕） |
| `--color-accent-fill` | 實心填色 |
| `--color-accent-foreground` | accent 實心底上的反色字 |
| `--color-accent-text` | **淺底上的前景色**，比 `--color-accent` 深，對比達 WCAG AA |
| `--color-accent-text-on-tonal` | tonal 底上的前景色 |

⚠️ **`--color-accent` 對比不足以當淺底上的文字色**（cream 底上約 3.6:1 < 4.5）。淺底前景一律用 `--color-accent-text`，tonal 底用 `--color-accent-text-on-tonal`。直接把 `--color-accent` 拿來 `color:` 是已知的 call-site 誤用模式。

`--color-accent-2` / `--color-accent-3` 及其 `-bg` / `-deep` / `-subtle` 變體仍存在，但**三色語意分類已於 2026-07-15 退場**，目前值收斂為與主 accent 相同。不要拿它們表達分類語意。

### 表面與文字

| Token | 用途 |
|-------|------|
| `--color-background` | 頁面底色（cream） |
| `--color-secondary` | 浮起表面（卡片、面板） |
| `--color-tertiary` | 凹陷表面（輸入框） |
| `--color-hover` | hover 狀態底色 |
| `--color-foreground` | 主文字 |
| `--color-muted` | 次要文字 |
| `--color-border` | 分隔線 |
| `--color-border-control` | 控制項邊框 |
| `--color-line-strong` | 強調分隔線 |
| `--color-overlay` | backdrop 遮罩 |
| `--color-disabled` | 不可用狀態 |

### 語意狀態

`--color-destructive` / `-bg`、`--color-success` / `-bg` / `-deep`、`--color-warning` / `-bg` / `-deep`、`--color-info` / `-bg`。

### 材質與特殊

| Token | 用途 |
|-------|------|
| `--color-glass-nav` | 導覽玻璃底（`color-mix` 半透明） |
| `--color-glass-toast` | 通知玻璃底 |
| `--blur-glass` | 玻璃模糊半徑 |
| `--tabbar-tint` / `-rim` / `-shadow` / `-filter` | 底部 tab 膠囊材質 |
| `--color-poi-card-tone-*` | 探索卡漸層（amber / cool / tp 三組 from-to + icon） |
| `--tone` / `--tone-bg` / `--tone-subtle` / `--tone-deep` | tonal 系統的動態 slot |

### 使用原則

- **一律用 `var(--color-*)`**，禁止硬編碼色碼。
- Dark mode 靠 token 覆寫自動生效，不需另寫 `.dark` 規則（除非要改的是不同屬性而非值）。
- tonal 色太淺，**不要當淺底上的前景或框線** —— 前景用 `--color-foreground`，focus 用 `--color-accent` outline，active 靠加深底色。

## Typography

| Token | 對應 |
|-------|------|
| `--font-size-large-title` | 大標題 |
| `--font-size-title` / `-title2` / `-title3` | 標題三級 |
| `--font-size-headline` | headline（semibold） |
| `--font-size-body` | 本文 |
| `--font-size-callout` | callout |
| `--font-size-subheadline` | 副標 |
| `--font-size-footnote` | 註腳 |
| `--font-size-caption` / `-caption2` | 說明、小說明 |
| `--font-size-eyebrow` | uppercase eyebrow 標籤（DAY 01、STOPS） |
| `--mobile-font-size-body` | 手機本文覆寫 |

複合 text style token（同時帶字級與行高）：`--text-title2`、`--text-title3`、`--text-body`、`--text-callout`、`--text-subheadline`、`--text-footnote`、`--text-caption`。

- Font family：`--font-family-system`
- Font weight：`--font-weight-medium` / `-semibold` / `-bold`（**沒有 `--font-weight-light`**）
- Line height：`--line-height-tight` / `-normal` / `-relaxed`

## Spacing（4pt grid）

margin / padding / gap 的 px 值必須為 **4 的倍數**。

`--spacing-1`(4px) / `-2` / `-3` / `-4`(16px) / `-5` / `-6` / `-8` / `-10`

**沒有** `--spacing-half`、`--spacing-12`、`--spacing-16`。

### 佈局

| Token | 用途 |
|-------|------|
| `--spacing-padding-h` | 水平內距 |
| `--spacing-nav-h` | 導覽列高 |
| `--spacing-tap-min` | **最小觸控目標 44px** |
| `--spacing-toast-top` | 通知距頂 |
| `--nav-height-mobile` | 手機底部導覽總高 |
| `--sidebar-width-desktop` | 桌機 sidebar 寬 |
| `--grid-2pane-desktop` / `--grid-3pane-desktop` | 桌機欄位 grid |
| `--titlebar-h` | titlebar 高 |
| `--day-strip-h` | Day tab 列高 |
| `--sticky-chrome-h` | sticky chrome 累計高 |
| `--anchor-scroll-margin` | 錨點捲動讓位 |
| `--tp-form-input-min-h` / `-pad-x` / `-pad-y` | 表單輸入框 |

**沒有** `--content-max-w`、`--info-panel-w`、`--fab-size`、`--nav-h`、`--padding-h`、`--tap-min`（後三個是遷移前舊名）。

## Radius

`--radius-xs` / `-sm` / `-md` / `-lg` / `-xl` / `-full`

## Shadow

`--shadow-sm` / `-md` / `-lg`，以及 `--shadow-ring`（focus ring，引用 `var(--color-accent)`）。

## Motion

| Token | 用途 |
|-------|------|
| `--transition-duration-fast` / `-normal` / `-slow` | 基礎三級 |
| `--transition-timing-function-apple` | 標準 easing |
| `--ease-spring` / `--ease-sheet-close` | sheet 專用 easing |
| `--duration-sheet-open` / `-sheet-close` / `-nav-fade` | sheet 與 nav 時長 |
| `--animate-toast-slide-down` / `-up` | 通知動畫 |
| `--hover-brightness` | hover 亮度調整 |

**沒有** `--duration-tap`、`--duration-indicator`、`--ease-apple`（`--ease-apple` 的現名是 `--transition-timing-function-apple`）。

## Z-index

`--z-sticky-nav`(200) · `--z-info-sheet-backdrop`(400) · `--z-info-sheet`(401) · `--z-modal`(9000)

**只有這四個。** `--z-day-header`、`--z-fab`、`--z-quick-panel`、`--z-print-exit` 都不存在。新增浮動元件時，z 值必須 ≥ `--z-sticky-nav` 才不會被導覽蓋住。

## 其他

`--scrollbar-thumb` / `-hover`、`--color-sidebar-fg-skel-secondary` / `-faint`（sidebar 骨架屏）。

---

**完整清單以 `css/tokens.css` 為準**（目前 **142** 個）。本表若與該檔案不一致，以檔案為準並回頭修本表。

⚠️ **數 token 不要用 naive grep。** `grep -oE '\-\-[a-z0-9-]+:'` 會把 BEM 修飾類選擇器算進去 —— `.tp-toast--error::before` 裡的 `--error::` 會被匹配成 `--error:`，`.tp-action-btn--destructive:hover` 同理。那會多算 `--error`／`--success`／`--warning`／`--info`／`--destructive` 五個根本不存在的 token（142 → 假的 147）。要準確計數就用 CSS parser，或至少要求 `--name:` 前面緊接 `{` 或 `;`。
