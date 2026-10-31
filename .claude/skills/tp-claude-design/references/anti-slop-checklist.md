# L2 — Anti-Slop Checklist（品味紀律）

## 核心 9 條原則

### 1. System First — 先建系統再處理內容
- 任何 UI 開工前，先確認 design system 存在（DESIGN.md、tokens.css 都要讀過）
- 沒有系統時，**先建系統**而不是直接畫第一個頁面
- 系統建在內容之前：spacing scale / color / typography / component primitives → 然後才是 page layout

### 2. No Filler — 每個元素都要有理由
- 禁止 Lorem Ipsum
- 禁止「填空用」的段落、icon、數字
- 如果沒內容，**留空**；不要為了畫面「豐富」硬塞

### 3. Ask First — 新增前先確認
- 使用者沒明說要「某個 section / 某個 feature / 某張圖」，就不要自作主張加
- Feature creep 是 AI 最常見的 slop 來源

### 4. Scale Standards — 可讀性硬標準
- 簡報 / deck：文字 ≥24px @ 1920×1080
- 印刷：≥12pt
- 觸控目標：≥44px（Apple HIG）
- trip-planner mobile body：≥16px（DESIGN.md 已定）
- trip-planner desktop body：≥17px

### 5. Avoid Slop — 拒絕 AI 生成典型垃圾模式

**絕對拒絕**（看到就打槍）：

| Slop pattern | 為何是 slop |
|-------------|------------|
| 無理由的 gradient 背景 | AI 的「讓它漂亮點」偷懶手段；破壞資訊層級 |
| 非品牌 emoji 當視覺裝飾 | Stock-photo 等級的廉價感 |
| Rounded container + 左邊 accent border 線 | AI 預設的「優雅 card」模板，已被用爛 |
| SVG 手繪風 illustration | 當可以用真實照片 / screenshot 時 |
| Generic typeface 作主字體 | Inter / Roboto / Arial / Fraunces / system（**本專案 override — 見 overrides.md**） |
| Unnecessary data icons | 每個數字旁邊都配 icon → "data slop" |
| Unnecessary stats / 裝飾性數字（**stat slop**） | 沒實質資訊價值的統計數字填空（「10,000+ users」「99.9% uptime」「24/7 support」這種純裝飾性數據）。原文 L2-5：「unnecessary numbers or statistics that are not useful」 |
| Placeholder text 填空位 | Violates rule #2 |
| 從零生成（無脈絡） | 永遠先看現有 codebase / design system |
| 單一「完美」方案 | 永遠多 variant 給使用者選 |
| 自創色彩 palette | 應從 brand 色取，或用 `oklch()` 擴展 |
| 第一屏純 tagline + CTA 的 title-screen 結構（**不分 prototype / landing / marketing**） | AI 的「歡迎頁」習慣；第一屏必須承載 value proposition + primary CTA + 實質資訊。marketing landing **不是豁免** |
| 泛用檔名（`index2.html` / `page-final.html`） | 語意檔名（`Trip Dashboard.html`） |

### 6. Placeholder > Bad Attempt
如果沒把握做好某個元素（例如 hero image、marketing copy），**用 placeholder 標示**，讓使用者補或討論；不要硬做一個 50 分成果。

### 7. Not From Zero
**永遠從既有脈絡出發**：
- trip-planner：讀 DESIGN.md、tokens.css、現有 component
- 沒脈絡時：問使用者要 UI kit、codebase、screenshot、Figma

**從零生成** = 你在憑空想像使用者品味。不要。

### 8. Variations（≥3）
永遠提供至少 3 個變體沿下列維度之一探索：
- Color palette 選擇
- Layout arrangement
- Interaction pattern
- Icon / illustration style
- Density / spacing

讓使用者**選/混搭**，而不是賭單一方案的命中率。

### 9. Color Protocol — Brand → oklch → Never Invent
三段優先序：
1. 從 brand palette 取（本專案 = Terracotta DESIGN.md）
2. 需要延伸時用 `oklch()` 而非 raw hex 猜測
3. **禁止**自創 palette

## 好設計信號（checklist）

設計成品前，自問：

- [ ] 根基於既有 design system 或 codebase？
- [ ] System 先於 content 建立？
- [ ] 每個元素都有明確理由？
- [ ] 新增元素前確認過使用者意圖？
- [ ] 用 placeholder 而非強塞內容？
- [ ] 提供 ≥3 variant？
- [ ] 色彩對齊品牌？
- [ ] 字級、觸控目標符合 scale standards？
- [ ] 早期就給使用者看（showing early）？
- [ ] artifact self-contained（不依賴外部編輯就能看）？

## 壞設計信號（紅旗）

- [ ] Gradient 背景作裝飾
- [ ] Emoji 不在品牌色系內
- [ ] Rounded + 左邊 accent border 模板
- [ ] SVG illustration 但可以用照片 / screenshot
- [ ] 泛用字體當主字體（非本專案豁免名單）
- [ ] Data icon slop（每個數字旁都配 icon）
- [ ] Stat slop（無意義統計數字 / 裝飾性數據，像「10,000+ users」「99.9% uptime」）
- [ ] Lorem Ipsum 或任何 placeholder text
- [ ] 從零生成無脈絡
- [ ] 單一方案沒備選
- [ ] 自創色 palette
- [ ] 第一屏是純 tagline + CTA 的 title-screen（不分 prototype / landing / marketing，皆禁）
- [ ] 泛用檔名

看到 ≥3 個紅旗 = 產出 probably 是 slop。停手重做或退一步問使用者。
