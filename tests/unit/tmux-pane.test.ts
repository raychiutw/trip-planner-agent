/**
 * tmux-pane — readPromptState 判讀 + waitForRepl / submitSkillCommand orchestration。
 *
 * v2.55.52 root cause：spawner `send-keys cmd Enter` 合併送出，slash autocomplete
 * 攔截 Enter → 指令打進 input 但沒提交（$0.000 stuck session、blocking 後續 spawn）。
 * 修正靠 readiness poll + type/Enter 拆開 + capture 驗證 + retry。orchestration 用依賴
 * 注入（capture/sendKeys/sleep/log）餵腳本化 pane 序列做真行為測試。
 *
 * pane 字串取自實際除錯時的 tmux capture-pane 輸出。
 */
import { describe, it, expect } from 'vitest';
import {
  readPromptState,
  waitForRepl,
  submitSkillCommand,
  REPL_READY_MARKER,
  type TmuxDeps,
} from '../../scripts/lib/tmux-pane';

// 態：指令打進 input、autocomplete 開著、從沒提交（$0.000）。最後 prompt 帶指令。
const PANE_PENDING = `


  /tp-request                     處理旅伴請求時使用 — 從 D1 database
  /requesting-code-review         (superpowers) Use when completing tasks,
───────────────────────────────────── tripline-tp-request-1783698540152-12147 ──
❯ /tp-request
────────────────────────────────────────────────────────────────────────────────
  trip-planner | master
  ⏵⏵ ${REPL_READY_MARKER} on (shift+tab to cycle)`;

// 態：Enter 提交後 — 指令 echo 進上方 transcript、最後 prompt 已清空。關鍵 regression：
// naive `pane.includes('/tp-request')` 會被 echo 行誤判成 pending。
const PANE_SUBMITTED = ` ⚠ 1 MCP server needs authentication · run /mcp

❯ /tp-request

· Pollinating…

───────────────────────────────────── tripline-tp-request-1783698540152-12147 ──
❯
────────────────────────────────────────────────────────────────────────────────
  trip-planner | master
  ⏵⏵ ${REPL_READY_MARKER} on (shift+tab to cycle) · ← for agents`;

// 態：重繪撕裂 / modal 殘幀 — 完全沒有 prompt 行。宣告提交成功時絕不可把此態當已提交。
const PANE_UNKNOWN = `· Whirring… (2m 20s · thinking)\n  ⎿  building context…`;

// 態：REPL 剛 spawn、狀態列還沒渲染（未就緒；非空避免誤判 session 已死）。
const PANE_BOOTING = `Loading plugins…\n(status bar not rendered yet)`;

const CMD = '/tp-request';

/** 腳本化 TmuxDeps：capture 依序回傳 panes（用盡回最後一個 = 穩態）；sleep no-op。 */
function makeDeps(panes: string[]) {
  const sends: Array<{ session: string; keys: string }> = [];
  const logs: string[] = [];
  let i = 0;
  const deps: TmuxDeps = {
    capture: () => panes[Math.min(i++, panes.length - 1)] ?? '',
    sendKeys: (session, keys) => sends.push({ session, keys }),
    sleep: () => Promise.resolve(),
    log: (m) => logs.push(m),
  };
  return { deps, sends, logs };
}

describe('readPromptState — 最後 prompt 行三態判讀', () => {
  it('指令卡在 input 未提交 → pending', () => {
    expect(readPromptState(PANE_PENDING, CMD)).toBe('pending');
  });

  it('已提交（指令 echo 在上方、最後 prompt 空）→ submitted（不被 echo 行誤判）', () => {
    expect(PANE_SUBMITTED.includes(CMD)).toBe(true); // 證明 naive includes 會 false-positive
    expect(readPromptState(PANE_SUBMITTED, CMD)).toBe('submitted');
  });

  it('完全沒有 prompt 行（撕裂殘幀）→ unknown（不可當已提交）', () => {
    expect(readPromptState(PANE_UNKNOWN, CMD)).toBe('unknown');
  });

  it('泛用到其他 skill（/tp-daily-check 卡住）→ pending', () => {
    const pane = `───── tripline-tp-daily-check-1 ──\n❯ /tp-daily-check\n─────\n  x`;
    expect(readPromptState(pane, '/tp-daily-check')).toBe('pending');
  });

  it('skillCommand 前後空白容錯', () => {
    expect(readPromptState(PANE_PENDING, '  /tp-request  ')).toBe('pending');
  });
});

describe('waitForRepl — 就緒訊號（狀態列 或 input prompt 任一）', () => {
  it('狀態列 marker 於第 2 次 poll 出現 → true', async () => {
    const { deps } = makeDeps([PANE_BOOTING, PANE_PENDING /* 含 marker + ❯ */]);
    expect(await waitForRepl(deps, 's')).toBe(true);
  });

  it('v2.55.53：input prompt ❯ 先出現（狀態列還沒渲染）→ true（cold boot 提早偵測）', async () => {
    // cold boot：MCP auth 檢查延後狀態列，但 input prompt 已可收輸入
    const promptOnly = '───── tripline-tp-request-1 ──\n❯\n─────\n  trip-planner | master';
    expect(promptOnly.includes('bypass permissions')).toBe(false); // 證明無狀態列 marker
    const { deps } = makeDeps([PANE_BOOTING, promptOnly]);
    expect(await waitForRepl(deps, 's')).toBe(true);
  });

  it('狀態列與 ❯ 都不出現（純 boot 畫面）→ false', async () => {
    const { deps } = makeDeps([PANE_BOOTING]); // 無 marker、無 ❯
    expect(await waitForRepl(deps, 's')).toBe(false);
  });

  it('session 已死（capture 連續回空）→ 提早 bail、false + log', async () => {
    const { deps, logs } = makeDeps(['']); // 一直空
    expect(await waitForRepl(deps, 's')).toBe(false);
    expect(logs.some((m) => m.includes('已死'))).toBe(true);
  });
});

describe('submitSkillCommand — type → poll 落地 → Enter → poll 提交', () => {
  it('happy path：落地 → 一次 Enter 提交 → true', async () => {
    const { deps, sends } = makeDeps([PANE_PENDING /* 落地 */, PANE_SUBMITTED /* 提交 */]);
    expect(await submitSkillCommand(deps, 's', CMD)).toBe(true);
    expect(sends).toEqual([
      { session: 's', keys: CMD },
      { session: 's', keys: 'Enter' },
    ]);
  });

  it('Enter 後撕裂殘幀（unknown）不算成功 → 再送 Enter 直到 submitted', async () => {
    // 落地 → Enter → unknown（殘幀，不可當成功）→ Enter → submitted
    const { deps, sends } = makeDeps([PANE_PENDING, PANE_UNKNOWN, PANE_SUBMITTED]);
    expect(await submitSkillCommand(deps, 's', CMD)).toBe(true);
    expect(sends.filter((s) => s.keys === 'Enter')).toHaveLength(2); // 送了兩次 Enter
  });

  it('type 沒落地（input 始終空）→ false、不送 Enter', async () => {
    const { deps, sends } = makeDeps([PANE_SUBMITTED /* 空 prompt = 沒落地 */]);
    expect(await submitSkillCommand(deps, 's', CMD)).toBe(false);
    expect(sends).toEqual([{ session: 's', keys: CMD }]); // 只 type，沒送 Enter
  });

  it('Enter retry 耗盡（始終 pending）→ false，送 3 次 Enter', async () => {
    const { deps, sends } = makeDeps([PANE_PENDING]); // 落地後永遠 pending
    expect(await submitSkillCommand(deps, 's', CMD)).toBe(false);
    expect(sends.filter((s) => s.keys === 'Enter')).toHaveLength(3);
  });

  it('回歸 Important #1：Enter 後始終 unknown → false（unknown 絕不當提交成功）', async () => {
    // 落地 pending → 之後全 unknown。若把 `!== pending` 當成功會誤回 true → stuck session。
    const { deps } = makeDeps([PANE_PENDING, PANE_UNKNOWN]);
    expect(await submitSkillCommand(deps, 's', CMD)).toBe(false);
  });
});
