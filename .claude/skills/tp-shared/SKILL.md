---
name: tp-shared
description: 所有 tp-* skill 共用的 API 設定、POI 欄位規格、Doc 結構、travel 語意。不直接 invoke，被其他 tp-* skill 引用。
user-invocable: false
---

所有 tp-* skill 共用的定義和規範集中地。

### 文件結構

| 檔案 | 角色 |
|------|------|
| `references.md` | 快速索引 — API 設定 + curl 模板 + 子檔案導航 |
| `references/poi-spec.md` | POI 欄位規格、型別必填欄位、googleRating 查詢策略 |
| `references/doc-spec.md` | Doc 結構規格、Markdown 支援欄位、Doc 連動規則（鐵律） |
| `references/modify-steps.md` | 行程修改共用步驟、travel 語意（鐵律）、歇業偵測規則 |
| `references/quality_checklist.md` | portfolio-level 品質 checklist（PASS/FAIL gate） |

其他 tp-* skill 引用時一律用 `tp-shared/references.md` 或 `tp-shared/references/{filename}` 路徑。品質規則定義在 `tp-quality-rules/SKILL.md`。
