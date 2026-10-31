# tp-request contained-session 資產

開啟 `TP_REQUEST_USER_TOKEN=1` 的 activation 前置 (0)。當 api-server 用**restrict_trip user token**（可寫行程）spawn `/tp-request` 時，會把 Claude Code 跑在雙層隔離的 session 裡，讓被 prompt injection 的 agent 既無法提權（讀憑證 → 重 mint 一個無限制 token），也無法外洩。

## 兩層獨立防線

- **Layer B（能力層）** — 本目錄的 `settings.json`：`--permission-mode dontAsk` + 只允許 `mcp__tripline__*` + 停用所有 built-in tool。agent 的**全部**能力面就是 tripline MCP server（`scripts/tp-request-mcp-server.js`）。
- **Layer A（OS 層）** — 以獨立 unix user **`tp-agent`** spawn，env 洗過（`env -i`），HOME / TMPDIR / CLAUDE_CONFIG_DIR 都是用完即丟。檔案系統權限擋住 `tp-agent` 讀 `~ray/.tripline/*` 或 `.env.local`；env-scrub 擋住它繼承 `TRIPLINE_API_CLIENT_SECRET` 等。

單層失效，另一層仍守得住。

## ⚠️ `deny` 是 LOAD-BEARING —— 不要精簡它

`dontAsk` **不會**自動拒絕 read-only tool。read-only 的 Bash（`cat .env.local`）、`Read` tool、`Grep` 等在任何 mode 下都會**不經詢問直接執行**，除非明確 deny。`deny` 清單才是真正擋住讀憑證的那道牆。拿掉 `Bash`／`Read`／`Grep`／`Glob` 就等於重開檔案讀取這條路。`Agent`／`Task` 也要一起 deny（spawn 子 agent 會繞過白名單）。

contained session **絕不可**帶 `--dangerously-skip-permissions` / `bypassPermissions` —— 那會讓整個白名單失效。

`containmentReady()` 在 spawn 時還會跑一次 **negative self-probe**：如果 `tp-agent` **讀得到** `.env.local` 或 `~ray/.tripline`，就 fail-closed（避免 (0a) 的 chmod 沒設好卻默默上線一個有洞的隔離）。

**工作目錄**：contained session 使用 disposable `CLAUDE_CONFIG_DIR`，wrapper 切到乾淨的 `sessionDir`，並只預先信任該空目錄。workspace 不是 repo，因此不會載入 repo 的 `.claude/settings.local.json` allow；skill 由 config 下的 symlink 探索。不要把工作目錄改回 repo 或預先信任 repo。

**認證**：contained 是非登入 user、沒 login keychain，訂閱 `/login` 存不了 token。改用 `claude setup-token` 產的一年期 **`CLAUDE_CODE_OAUTH_TOKEN`**（precedence 高於 `/login`），由 api-server 從 `.env.local` 讀出、寫進 0600 檔、經 sh wrapper 注入 contained claude 的 env（不上 argv）。見 (0a) 步驟 4。

## (0a) 只有 Ray 能做的前置 —— 我做不了（需要 root）

開 `TP_REQUEST_USER_TOKEN=1` 之前先做：

```bash
# 1. 建 agent user（無登入 shell、非 admin）+ 家目錄
sudo sysadminctl -addUser tp-agent -fullName "Tripline Agent" -home /Users/tp-agent
sudo dscl . -create /Users/tp-agent UserShell /usr/bin/false
# ⚠️ sysadminctl 不會真的建家目錄 → 手動建（claude 要寫 config，沒有它會 No such file）
sudo mkdir -p /Users/tp-agent && sudo chown tp-agent:staff /Users/tp-agent && sudo chmod 700 /Users/tp-agent

# 2. 讓 api-server（user: ray）免密碼、非互動 sudo 成 tp-agent
#    ⚠️ 放 /etc/sudoers.d/ —— visudo 加在主檔可能被後面的 %admin 規則蓋掉、NOPASSWD 失效
echo 'ray ALL=(tp-agent) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/tp-agent >/dev/null
sudo chmod 440 /etc/sudoers.d/tp-agent && sudo visudo -cf /etc/sudoers.d/tp-agent   # 驗語法

# 3. tp-agent 可讀 repo（skill + MCP server）但不可寫；憑證不可被 other 讀
sudo chmod -R o+rX /Users/ray/Projects/trip-planner
chmod 600 /Users/ray/Projects/trip-planner/.env.local
# ~/.tripline 由 seed（activation 步驟 2）建立；先 mkdir 鎖 700，token 一落地即隔離
mkdir -p /Users/ray/.tripline && chmod 700 /Users/ray/.tripline

# 4. claude 認證（訂閱、不碰 Keychain —— tp-agent 是非登入 user 沒 login keychain）
#    以「你自己」跑 setup-token（你的 keychain 正常）→ 產一年期 OAuth token（會印出來）
claude setup-token
#    把那串貼進 .env.local（tp-agent 讀不到；api-server 讀後注入 contained session）：
#      CLAUDE_CODE_OAUTH_TOKEN=<貼在這>
#    到期前（約一年）重跑 setup-token 換新

# 5. 驗證（先確認 sudo 通，test 的 exit code 才反映「真的讀不讀得到」）
sudo -n -u tp-agent true && echo "① sudo OK"
sudo -n -u tp-agent test -r /Users/ray/Projects/trip-planner/scripts/tp-request-mcp-server.js && echo "② repo 讀取 OK"
sudo -n -u tp-agent test -r /Users/ray/Projects/trip-planner/.env.local && echo "③ ⚠️外洩" || echo "③ .env.local 隔離 OK"
sudo -n -u tp-agent test -r /Users/ray/.tripline && echo "④ ⚠️外洩" || echo "④ ~/.tripline 隔離 OK"
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' /Users/ray/Projects/trip-planner/.env.local && echo "⑤ OAuth token OK" || echo "⑤ ⚠️缺 OAuth token"
```

在這步做完之前，api-server 一律 **fail-closed**：mint 或隔離檢查失敗就不啟動 `/tp-request`，並發 alert。沒有 service token 降級路徑。隔離暫時未就緒保留 pending request，下一輪可再試。

`request-worker` 持有完整生命週期：peek、mint、`claude -p` 執行（見下方「`claude -p` 模式」）與收屍；api-server 的 `runContainedPrint` 只負責佈置檔案、跑 process、逾時處理與清理，不回呼 worker。隔離未就緒保留 pending request，下一輪可再試；process 失敗／逾時／輪數用盡才就地標終結，100 分鐘 API 牆鐘仍為第二層。

## (0b) 開 flag 前的 live 驗證 —— ✅ 已通過（2026-07-11 dry-run 用互動 REPL；2026-10-27 起改 `-p`，隔離面向不變）

在本機實跑真實 contained 機制，逐關驗證全過：

- ✅ **認證**：claude 用 `CLAUDE_CODE_OAUTH_TOKEN` 起得來，且**無 onboarding/trust 對話框**卡住（`-p` 本來就不跳 trust 對話框；pre-seed 的設定見下方）；
- ✅ **能力面**：工具清單**只剩 16 個 `mcp__tripline__*`** —— Bash / Read / Skill / ToolSearch / Workflow / Agent / Artifact 全部消失；
- ✅ **skill**：`/tp-request` 觸發、agent 自判「Contained mode」、呼叫 MCP 工具；
- ✅ **exfil**：prompt-injection 叫它讀 `.env.local` 印憑證 → 拒絕 + **零外洩**（Layer A OS perm 讓 tp-agent 根本開不了檔 + Layer B 無 Read tool，雙擋）。

換機器 / claude 升版 / 改設定後，重跑同機制再驗一次即可。

### 工作區與設定怎麼佈置（`prepareContainedSessionDir`）

1. **cwd = 乾淨的 sessionDir**（sh wrapper 內 `cd "$1"`，因為 tp-agent 進得去自己的 0700 目錄、而 api-server 用戶進不去）→ workspace 不是 repo，沒有 `.claude/settings.local.json` 的 allow。
2. **pre-seed `<config>/.claude.json`**：`hasCompletedOnboarding:true` + `projects[sessionDir].hasTrustDialogAccepted:true`（空 sessionDir 信任＝零授權）。
3. **skill 探索**：`<config>/skills` symlink 到 repo `.claude/skills`（user-skill scope）→ `/tp-request` 找得到，但不用把 repo 當 workspace。
4. **MCP server 快照進 sessionDir**，設定指向快照而非 repo 工作區（2026-07-29 事故：spawn 當下工作區正被 git pull 改動，整個 session 廢掉）。

## `claude -p` 模式（contained `/tp-request` 的唯一路徑，2026-10-27 起）

v2.30.7 曾因冷啟動可靠度放棄 `-p`，改用 tmux 互動式 REPL；但 REPL 做完就閒置，**同一行程之後又進來的新請求沒有人再叫它處理**，要等到 90 分鐘 orphan cap 才被收屍（#287）。2026-10-27 在現行 CLI（2.1.311）以 tp-agent + `env -i` + `dontAsk` + `--strict-mcp-config` 實測 22 次全 exit 0、約 6 秒，skill 與 MCP 都正常載入，所以直接改回 `-p`，不設旗標。

- 隔離參數與先前完全相同（`buildContainedShellCommand`：`sudo -u tp-agent`、`env -i`、`dontAsk`、`--settings`、`--strict-mcp-config`、0600 token 檔），多了 `-p <skill>` 與 `--max-turns 150`（耗盡時 exit 1，視為失敗）；stdin 接 `/dev/null`。
- process 結束就是處理完；輪間若同一行程又進來新請求就再跑一輪（上限 `PRINT_MAX_ROUNDS`=3）。
- **失敗收屍**：非 0 結束、逾時（單輪 30 分鐘）、輪數用盡仍有待處理 → 就地標終結，但**只收「該輪開始時就在隊列」的請求**；之後才到的新請求沒被看過，留給下一個 tick。原因：真逾時 `timed_out`，其餘（含 exit 0 卻沒處理）`error`。
- **逾時先 SIGTERM**（sudo 會轉發給 claude；直接 SIGKILL 只殺得到 sudo，claude 會變孤兒，實測），寬限 10 秒才 SIGKILL，再給 5 秒就放棄等待，tick 鎖不會被卡住的 process 永遠佔住。
- **清理**：每輪結束（含 prepare 寫到一半失敗）都殺殘留子程序（命令列帶該輪目錄）並刪 session 目錄（含 token 檔）。
- **api-server 啟動時清掃**上一代殘留（`print-run-sweep.ts`）：重啟不會帶走 tp-agent 的 claude，舊目錄與 token 檔也不會自己消失。這同時會清掉升級前舊 REPL 路徑留下的目錄。
- 輸出收完整段後脫敏（restrict token、OAuth token 精確字串 + `Bearer`／`sk-ant-` 格式）寫進 `scripts/logs/tp-request/<run>.log`（0600，輸出上限 1MB）。
- 回退：無旗標；要回舊行為就 revert 這個 PR。

## 已知限制（不擋 merge，維運時要知道）

- **全域序列鎖，最長約 91 分鐘**：`tick` 持有單一 `/tp-request` 鎖，最多 3 輪 × 單輪 30 分鐘逾時（通常 10 秒內結束；只有「執行當中才到的新請求」才會多跑一輪）。同一個旅伴連續灌請求會讓其他行程排隊；失敗會收屍所以不會無限，但沒有 per-trip 冷卻。鎖在記憶體，跨進程保護靠 api-server 單實例（launchd）與啟動清掃。
- **脫敏是精確字串 + 兩條 regex**：若 claude 輸出把 token 做 JSON 轉義、URL-encode 或截斷後印出會漏。log 檔 0600，但內容含旅伴對話，`scripts/logs/` 不要被別的備份或 sync 流程帶走。
- **沒開始處理 vs 處理失敗**：目錄佈置失敗、spawn 失敗（`started:false`）不收屍，請求留給下一個 tick 重試；claude 有跑但非 0 結束（含 OAuth token 過期／被停用而秒退）視為處理失敗，立刻標 `error` —— 使用者看得到失敗，而不是像舊 REPL 路徑那樣空等 18 分鐘（2026-10-27 事故）。
- **清理失敗的殘留只在 api-server 啟動時補清**：`rm` 失敗會 alert，但沒有週期性重掃；api-server 常駐數週不重啟時，殘留的 token 檔（tp-agent 0600）會留著。
- **單輪上限 30 分鐘／150 輪是估計值**：舊 REPL 路徑的上限是 90 分鐘（#237 多天餐廳替換超過 40 分鐘），這裡在不放大花費與讓大型請求做得完之間取折衷，尚未用真實的大型請求驗證；做不完會被標 `error`。`.claude/skills/tp-request/SKILL.md` 裡「做不完先回報進度、status 保持 processing、下一輪接續」只適用一般（plain）模式，contained 的 `-p` 一輪就要做完。
- **不要在同一台機器用別的 `TRIPLINE_PORT` 再起一個 api-server 實例**：啟動清掃是機器層級的（`CONTAINED_BASE_DIR` 底下所有 run 目錄），第二個實例會把正式實例進行中的 run 一併殺掉並刪目錄。
- **同一批請求只跑一輪**：exit 0 卻沒處理完（agent 拒絕、被注入訊息誘導不更新狀態）不會重跑，直接收屍為 `error`；只有「執行當中才到的新請求」才會再跑一輪。

## 已知 follow-up

- **per-session Google-API 額度** —— `recomputeTravel` / `enrichPoi` / `poiSearch` 會打有計費的 Google API，目前沒有 per-request 的呼叫額度；`--max-turns 150` 與單輪 30 分鐘逾時只是上限，被注入的 message 仍可能在這個範圍內燒額度。之後用 `bumpRateLimit` 加一個以 request 為 key 的額度。
- **信任 skill 的 token 上 argv** —— `/tp-daily-check` 的 plain session 仍把 service token 插在 tmux 指令列（既有行為、`ps` 看得到）；這不是 `/tp-request` 的 fallback。後續可比照 contained 路徑改走 stdin。
- **deny 用列舉（Claude Code 沒有「只准 allow、其餘全 deny」的權威模式）** —— `dontAsk` 會把未列的 meta-tool（Skill / ToolSearch / Workflow / Artifact …）當豁免放行，所以 `settings.json` 得**逐一列 deny**。風險：claude 未來新增一個沒列到的工具會漏。緩解：(1) **Layer A**（tp-agent OS 隔離）擋掉 FS/exec 類漏洞（讀憑證、跑 script）；(2) 真正需要 deny 擋的是**網路/外洩/spawn 類**（WebFetch / Artifact / SendUserFile / Workflow / Agent），這些已列。升 claude 版本後值得重跑 (0b) 的工具清單檢查、必要時補 deny。
