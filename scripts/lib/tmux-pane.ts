/**
 * tmux pane 判讀 + skill command 提交 orchestration（供 tripline-api-server 用 + 單元測試）。
 *
 * 抽出成獨立模組的兩個理由：
 *  (1) tripline-api-server.ts import 即啟動 server（top-level setInterval /
 *      scheduleDaily），無法在 vitest 直接 import 執行。
 *  (2) orchestration（readiness poll / type / Enter retry）是本機 dev-ops 的 incident
 *      修正碼（v2.55.52 stuck-session），必須有真行為測試 → 用依賴注入
 *      （capture / sendKeys / sleep / log）讓 vitest 餵腳本化 pane 序列驗證失效模式。
 * 同 mailer-handler / schedule-daily 把純邏輯搬到 scripts/lib/ 的慣例。
 */

// ⚠️ 與當前 Claude Code TUI 版本耦合 — TUI 升級後需重新確認這兩個字串/字元。
//    這個 fix 的觸發原因本身就是 TUI 行為改變，措辭若再變會讓 waitForRepl 永遠
//    timeout（每輪 16s kill+respawn，安全但等同硬中斷）、readPromptState 誤讀。
export const REPL_READY_MARKER = 'bypass permissions'; // 狀態列只在 REPL 互動態渲染
const PROMPT_CHAR = '❯'; // U+276F，claude REPL input 提示字元（狀態列用 ⏵⏵ U+23F5，不衝突）

export type PromptState = 'pending' | 'submitted' | 'unknown';

/**
 * 從 capture-pane 輸出判斷 skill command 在 input 的狀態。取「最後一個」prompt 行
 * — 提交後指令會 echo 進上方 transcript，整 pane grep 會被 echo 行 false-positive。
 *   - 'pending'   最後 prompt 行 = `❯ /tp-request`（指令還在 input、未提交）
 *   - 'submitted' 最後 prompt 行 = `❯ `（空；指令已送出、input 清空）— 待命與執行中皆此態
 *   - 'unknown'   完全沒有 prompt 行（重繪撕裂 / modal 殘幀）→ 不確定，呼叫端須重試，
 *                 **不可當成功**（否則「看不到 prompt 就以為提交」= 原 stuck-session bug）
 */
export function readPromptState(pane: string, skillCommand: string): PromptState {
  const cmd = skillCommand.trim();
  const lines = pane.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf(PROMPT_CHAR);
    if (idx === -1) continue;
    return lines[i].slice(idx + 1).includes(cmd) ? 'pending' : 'submitted';
  }
  return 'unknown';
}

export interface TmuxDeps {
  capture: (sessionName: string) => string; // capture-pane -p stdout（失敗回 ''）
  sendKeys: (sessionName: string, keys: string) => void;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

// v2.55.53：cold boot（長閒置後首次 claude spawn，plugin/MCP 首載）實測 >16s；warm ~2s。
// 上限放寬到 ~90s 涵蓋 cold boot（warm 一看到就緒訊號就回、不受影響）。已死 session 靠連續
// 空 pane 早 bail、不會空燒滿 90s。
const REPL_READY_TIMEOUT_MS = 90_000;
const REPL_POLL_INTERVAL_MS = 800;

/**
 * 等 claude REPL 就緒（可安全收 send-keys）。v2.55.52：取代原本硬編碼 2.5s 固定等待 —
 * 新版 TUI 開機變慢（MCP auth 檢查 + plugin sync）常超過 2.5s → 早送的 command 輸入丟失。
 * v2.55.53：(1) 上限 16s→90s（cold boot 首載超過 16s，warm 不受影響）；(2) 就緒訊號放寬為
 * 「狀態列(bypass permissions) 或 input prompt(❯) 任一」— cold boot 下 MCP auth 檢查會延後
 * 狀態列渲染，但 input prompt 先出現即代表可收輸入 → 提早偵測、不必空等到狀態列。
 * session 已死（連續多次 capture 撈到空）提早 bail 不空燒。
 */
export async function waitForRepl(deps: TmuxDeps, sessionName: string): Promise<boolean> {
  let blank = 0;
  const maxPolls = Math.ceil(REPL_READY_TIMEOUT_MS / REPL_POLL_INTERVAL_MS);
  for (let i = 0; i < maxPolls; i++) {
    await deps.sleep(REPL_POLL_INTERVAL_MS);
    const pane = deps.capture(sessionName);
    if (pane.includes(REPL_READY_MARKER) || pane.includes(PROMPT_CHAR)) return true;
    // 全空 = session 可能已死（new-session 成功但 claude 立刻退出）；連 5 次（~4s）就放棄。
    blank = pane === '' ? blank + 1 : 0;
    if (blank >= 5) {
      deps.log(`waitForRepl: ${sessionName} 連續 ${blank} 次 capture 為空，判定 session 已死`);
      return false;
    }
  }
  return false;
}

/**
 * 送 skill command 並確認真的提交。v2.55.52：原本 `send-keys cmd Enter` 合併送出，
 * slash-command autocomplete 選單會攔截同 burst 的 Enter → 指令打進 input 但沒提交
 * （$0.000 stuck session、blocking 後續 spawn）。改為：
 *   type 指令（不帶 Enter）→ poll 確認落地 → 單獨送 Enter → poll 確認提交，未提交就重送。
 * 宣告成功一律要求正向 'submitted'（input 清空）訊號，'unknown' 殘幀不當成功。
 */
export async function submitSkillCommand(
  deps: TmuxDeps,
  sessionName: string,
  skillCommand: string,
): Promise<boolean> {
  deps.sendKeys(sessionName, skillCommand);
  // 確認指令落地 input（poll — 慢機/高載 render 慢也接得住；復原代價 = kill+respawn 很貴，
  // 別為最貴的分支省 retry）。落地態 = 'pending'（指令在 input）。
  let landed = false;
  for (let i = 0; i < 3 && !landed; i++) {
    await deps.sleep(700);
    landed = readPromptState(deps.capture(sessionName), skillCommand) === 'pending';
  }
  if (!landed) {
    deps.log(`submitSkillCommand: ${skillCommand} 未落地 input (${sessionName}) — REPL 未接到輸入`);
    return false; // caller kill session 重來，勝過盲送 Enter 卡死
  }
  // 單獨送 Enter，poll 驗證提交，未提交就重送（autocomplete 可能吞第一個 Enter）。
  for (let attempt = 1; attempt <= 3; attempt++) {
    deps.sendKeys(sessionName, 'Enter');
    await deps.sleep(700);
    if (readPromptState(deps.capture(sessionName), skillCommand) === 'submitted') return true;
    deps.log(`submitSkillCommand: Enter attempt ${attempt} 未提交 ${skillCommand}，重送`);
  }
  deps.log(`submitSkillCommand: ${skillCommand} 送 3 次 Enter 仍未提交 (${sessionName})`);
  return false;
}
