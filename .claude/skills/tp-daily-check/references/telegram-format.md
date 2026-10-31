# Telegram 報告格式

## 有問題時

```
📊 Tripline 每日報告 04/08
──────────────
⚠️ API errors: 24 筆
⚠️ Sentry: 3 筆
⚠️ 未完成請求: open:1 processing:0 failed:1
⚠️ 排程錯誤: tp-request 2 筆
⚠️ npm: 3 個漏洞
──────────────
📈 Workers: 1,234 req | err 0 筆 | P50 3ms P99 13ms
📈 Analytics: 89 visits, 234 views
📈 npm: 0 vulnerabilities
✅ OK: api-server, daily-check
🔨 自動修復 2/3 項
```

## 全綠時

```
📊 04/08 ✅ 全綠
──────────────
📈 Workers: 1,234 req | err 0 筆 | P50 3ms P99 13ms
📈 Analytics: 89 visits, 234 views
📈 npm: 0 vulnerabilities
✅ OK: api-server, daily-check, tp-request
🔧 無需修復
```

## 自動修復範圍

### Phase A：資料修復

| 來源 | 可修復的錯誤 | 修復動作 |
|------|------------|---------|
| requestErrors | status = received/processing/failed | PATCH → open |
| api-server error log | process loop crash 後 request 卡住 | PATCH → open |
| daily-check error log | 上次修復失敗的項目 | 重試一次 |

### Phase B：Code Fix（走 tp-team pipeline）

| 來源 | 觸發條件 | 修復動作 |
|------|---------|---------|
| Sentry issues | 有明確 error + 可定位 source | fix branch → ship → deploy |
| API errors（自家 caller） | 非外部 API、非使用者操作錯誤 | 修正 caller code |
