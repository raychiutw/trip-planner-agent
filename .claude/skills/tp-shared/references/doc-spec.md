# Markdown 支援欄位

## Markdown 支援欄位

前端會渲染 markdown 的欄位（可用粗體、列表、連結）：

| 欄位 | 支援 | 說明 |
|------|:---:|------|
| `entry.description` | ✅ | 景點描述 |
| `entry.note` | ✅ | master POI 備註（來源是 `trip_entry_pois.note`，不是已 DROP 的 `trip_entries.note`） |
| `restaurant.description` | ✅ | 餐廳描述 |
| `entry.title` | ❌ | 純文字 |
| `restaurant.name` | ❌ | 純文字 |
| `hotel.name` | ❌ | 純文字 |
