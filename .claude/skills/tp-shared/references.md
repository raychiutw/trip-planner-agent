# tp-* Skill 共用參考

所有 tp-* skill 共用的定義和規範。各 skill 引用本文件或子檔案。

## API 設定

- **Base URL**: `https://trip-planner-dby.pages.dev`
- **認證**: Service Token headers（寫入操作必填）
  - `Authorization`: `$TRIPLINE_API_TOKEN`
  - `Authorization`: `$TRIPLINE_API_TOKEN`

## curl 模板（Windows encoding）

> ⚠️ Windows encoding 注意：curl -d 中的中文在 Windows shell 會變亂碼，一律用 node writeFileSync + --data @file

```bash
node -e "require('fs').writeFileSync('/tmp/{filename}.json', JSON.stringify({...}), 'utf8')"
curl -s -X {METHOD} \
  -H "Authorization: Bearer $TRIPLINE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: https://trip-planner-dby.pages.dev" \
  --data @/tmp/{filename}.json \
  "https://trip-planner-dby.pages.dev/api/{endpoint}"
```

## 參考子檔案

| 檔案 | 內容 | 引用時機 |
|------|------|----------|
| `references/poi-spec.md` | POI 欄位規格、型別必填欄位、googleRating 查詢策略 | 新增/修改 POI 時 |
| `references/doc-spec.md` | Doc 結構規格、Markdown 支援欄位、Doc 連動規則 | 更新 doc 時 |
| `references/modify-steps.md` | 行程修改共用步驟、travel 語意、歇業偵測規則 | tp-edit/tp-request/tp-rebuild 修改行程時 |
| `references/quality_checklist.md` | 品質規則 checklist | 驗證時 |

## 品質規則

R0-R18 完整定義在 `tp-quality-rules/SKILL.md`。各 skill 引用規則編號，不重複定義。
