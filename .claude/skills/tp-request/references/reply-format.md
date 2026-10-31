# 回覆寫入方法

**⚠️ 重要**：reply 內容含 markdown 換行（`\n`），必須用 `node -e` + `JSON.stringify` 生成 JSON。
**禁止** `printf`、`echo`、或 backtick template literal（Windows bash 會把 literal newline 寫成 0x0A，curl `--data` 再把它去掉，導致 markdown 渲染失敗）。

reply 字串中的換行用 JS 單引號內的 `\n` 表示（會被 JSON.stringify 正確轉義為 `\n`）：

```bash
node -e "require('fs').writeFileSync('/tmp/reply.json', JSON.stringify({reply:'#42\n第一行\n\n第二行', status:'completed'}), 'utf8')"
curl -s -X PATCH \
  -H "Authorization: Bearer $TRIPLINE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/reply.json \
  "https://trip-planner-dby.pages.dev/api/requests/{requestId}"
```

## 過長 reply

若 reply 內容太長（超過 shell 單行限制），改用暫存 .js 檔：

```bash
# 1. Write a temp .js file
cat > /tmp/write-reply.js << 'ENDSCRIPT'
const reply = [
  '## 標題',
  '',
  '內容第一段',
  '',
  '內容第二段',
].join('\n');
require('fs').writeFileSync('/tmp/reply.json',
  JSON.stringify({ reply, status: 'completed' }), 'utf8');
ENDSCRIPT
# 2. Run it
node /tmp/write-reply.js
# 3. Send to API (same curl as above)
```
