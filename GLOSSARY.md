# 詞彙表

只定義語彙，不寫實作細節（實作見 `scripts/tp-request-contained/README.md`）。

**contained（隔離執行）**
處理不可信輸入（旅伴在聊天裡送來的請求）時採用的執行方式：以獨立的低權限身分、乾淨的環境與最小的工具白名單執行，只能操作該次請求所屬的那一個行程。`/tp-request` 一律 contained；無法 contained 時寧可不執行。

**信任 skill**
內容與輸入都由我們自己掌控、不接觸不可信輸入的 skill（目前只有 `/tp-daily-check`）。它以維運者的權限執行，不 contained，並與 `/tp-request` 各自獨立排程、互不佔用。

**不可信輸入**
任何由使用者（含旅伴）自由輸入、會進入 agent 提示的文字。凡處理它的 skill 都必須 contained，不得是信任 skill。
