# 頁面結構模式

> **2026-07-25 全檔重寫。** 舊版教的是多頁靜態 HTML 架構（`edit.html` / `setting.html` + `js/shared.js` + `css/shared.css` + `.page-layout`/`.container`/`.sticky-nav`），那套骨架**已經不存在** —— 它引用的 9 個檔案裡 5 個已刪除（`css/shared.css`、`js/shared.js`、`js/icons.js`、`edit.html`、`setting.html`）；另 4 個（3 個 favicon/touch-icon 與 `index.html`）仍在，但 `index.html` 現在是 Vite SPA 的 entry、不再是舊文描述的多頁骨架。現在是 React SPA。
>
> 本檔改為**指路**而非教學：列出現行結構的入口，細節去讀 code。寫死結構會再腐爛一次。

## 現行架構

**React SPA + Vite**，單一 HTML entry：

- HTML entry：`index.html` → `src/entries/main.tsx`
- 路由：React Router，頁面在 `src/pages/`（約 40 個）
- 元件：`src/components/`
- **CSS：只有 `css/tokens.css` 一個檔案**。元件用 Tailwind utility class；Tailwind 表達不了的（pseudo-element、複雜 dark mode 特例）用元件內 `SCOPED_STYLES` 常數
- Pages Functions（後端）：`functions/api/`

⚠️ `SCOPED_STYLES` 是 template literal —— **註解裡不要用反引號包 class 名**，會終止字串讓整檔壞掉，typecheck 抓不到、只有 runtime 才炸。

## 外殼（shell）

版面外殼全在 `src/components/shell/`：

| 檔案 | 角色 |
|---|---|
| `AppShell.tsx` | 最外層外殼、pull-to-refresh、桌機/手機分流 |
| `DesktopSidebar.tsx` / `DesktopSidebarConnected.tsx` | 桌機左欄 macOS sidebar（品牌 → 4-tab → 我的行程 → 帳號 chip） |
| `GlobalBottomNav.tsx` | 手機底部 root tab（玻璃膠囊 + 滑動 thumb） |
| `navItems.ts` | **primary IA 單一來源** —— 手機膠囊與桌機 sidebar 共用，避免漂移 |
| `TitleBar.tsx` / `TitleBarPrimaryAction.tsx` | titlebar 與主要動作 |
| `TripTitleSwitcher.tsx` | trip switcher（行程名 ⌄ 下拉） |
| `AccountCircle.tsx` / `AccountSheet.tsx` | 帳號圓圈 → Account sheet（自有 navigation stack） |
| `OperationShell.tsx` | **操作面板雙形態外殼** —— 桌機右欄堆疊面板／手機整頁下鑽 |
| `StackPanelHeader.tsx` | 堆疊面板 header（取代舊的 TitleBar 第二層規範） |

## 三種版面形態

- **桌機 ≥1024px**：三欄 `--grid-3pane-desktop`（sidebar / 行程 / 地圖 + 堆疊面板）。**桌機無底部膠囊**，primary nav 在 sidebar。
- **手機 <1024px**：底部 4-tab root tab（聊天／行程／地圖／收藏）常駐 —— 捲動不隱藏，只有鍵盤彈出時收起。帳號在 header 圓圈，不佔 tab slot。
- **操作頁**：新操作頁一律走 `OperationShell` + 掛在 `TripStackLayout` 路由下。桌機堆疊面板沒有 titlebar-confirm，返回 = 回上一層。

## 詞彙

指稱這些東西時**一律用 `GLOSSARY.md`「介面與互動」段**的名字：操作面板（不叫右欄／第三欄）、行程 sheet、bottom sheet、對話框、行內警示、堆疊層級、root tab / Day tab / trip switcher。單獨寫「sheet」有歧義。

## 版面 SoT

幾欄、怎麼排、材質、間距 —— 屬 `DESIGN.md`，本檔不重複。Apple HIG 是上位 SoT，`DESIGN.md` 須對齊 HIG。
