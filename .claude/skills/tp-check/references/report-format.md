# tp-check Report 格式

## 完整模式（standalone 或 before/after-fix）

```
══════════════════════════════════════════════
  tp-check Report: {tripId}
  {YYYY-MM-DD HH:mm:ss}
══════════════════════════════════════════════

  Summary:  🟢 N passed  🟡 N warnings  🔴 N failed

──────────────────────────────────────────────
  Rule          Status   Detail
──────────────────────────────────────────────
  R0  JSON結構   🟢
  R1  偏好       🟢
  R2  餐次       🟢
  R3  餐廳品質   🟡     Day 2 午餐只有 2 家推薦
  R4  景點品質   🟢
  R7  購物       🟢
  R8  早餐       🟢
  R10 加油站     🟢
  R11 地圖導航   🟡     12 個景點缺 location
  R12 評分       🔴     28 個地點缺 googleRating
  R13 來源標記   🟢
  R14 國家感知   🟢
  R15 必填note   🟢
  R16 飯店maps   🟡     2 個飯店缺 maps/address
  R17 POI導航    🟢
  R18 飯店phone  🟡     1 個飯店缺 phone
──────────────────────────────────────────────

  🟡 Warnings (N):
  ├── RX: {具體描述}
  └── RY: {具體描述}

  🔴 Failures (N):
  └── RZ: {具體描述}

══════════════════════════════════════════════
```

## 精簡模式（after-edit，嵌入其他 skill 尾部）

```
tp-check: 🟢 10  🟡 2  🔴 0
```

## 嵌入其他 skill 的方式

| Skill | 何時執行 tp-check | 模式 |
|-------|-------------------|------|
| `/tp-check` | 獨立執行 | 完整 |
| `/tp-rebuild` | 修正前 + 修正後 | 完整 x2 |
| `/tp-edit` | 修改完成後 | 精簡 |
| `/tp-request` | 每個請求處理完後 | 精簡 |
| `/tp-rebuild --all` | 每趟修正後 | 完整 |
