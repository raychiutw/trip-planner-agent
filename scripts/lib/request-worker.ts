/**
 * request worker（#1264）—— 行程 AI 聊天（requests pipeline）worker 的核心邏輯。
 *
 * api-server 以前把 peek → token → spawn → 收屍全寫成頂層函式，tmux / fetch / 時鐘在函式內部
 * 直接取用，測試只能 readFileSync + regex。這裡把「決策」收進一個接受依賴的 module：
 * 真實 adapter（tmux 指令、fetch、Date.now、contained 檔案佈置）由 api-server 組裝注入，
 * 測試用 fake 進同一個 interface。對外行為（session 命名、prefix、legacy 相容、log 訊息）不變。
 */

import { failPendingRequests, type ReapReason } from './fail-pending-requests';
import { waitForRepl, submitSkillCommand, type TmuxDeps } from './tmux-pane';

export interface PendingRequest { requestId: string; tripId: string }
export interface AcquiredToken { token: string; restrictTrip?: string; /** mint 時 peek 到的那筆請求（contained 路徑用來保底收屍）。 */ requestId?: string }
export type TickResult = 'spawned' | 'busy' | 'idle' | 'failed';
/**
 * `claude -p` 一次執行的結果：ok = exit 0；timedOut = 被逾時砍掉；
 * started = false 表示 claude 根本沒開始處理（目錄佈置失敗、spawn 失敗）——請求沒被嘗試過，不能算「處理失敗」。
 * 省略視為 true（process 有跑）。
 */
export interface PrintRunResult { ok: boolean; timedOut: boolean; started?: boolean }

export interface WorkerDeps {
  fetch: typeof fetch;
  apiBase: string;
  /** mint-restricted 用的 API secret（非 owner Bearer）。 */
  apiSecret: string;
  getServiceToken: () => Promise<string>;
  /** TP_REQUEST_USER_TOKEN 開關（只有 /tp-request 走 owner-restricted token）。 */
  userTokenEnabled: (skillCommand: string) => boolean;
  tmux: {
    /** `tmux ls -F <format>` 的 stdout；tmux 不在／沒 server 回 null。 */
    list: (format: string) => string | null;
    kill: (sessionName: string) => void;
    /** `tmux has-session -t <name>`。 */
    has: (sessionName: string) => boolean;
  };
  clock: { now: () => number };
  sleep: (ms: number) => Promise<void>;
  pid: number;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  alert: (key: string, state: 'healthy' | 'failed', message: string) => void;
  containmentReady: () => boolean;
  createPlainSession: (sessionName: string, skillCommand: string, token: string) => Promise<boolean>;
  pane: Pick<TmuxDeps, 'capture' | 'sendKeys'>;
  /**
   * contained /tp-request 的唯一執行路徑：`claude -p`，process 結束就是處理完（不經 tmux）。
   * 實作要自己處理逾時（砍 process、回 timedOut）與 session 目錄清理。
   */
  runContainedPrint: (runName: string, skillCommand: string, token: string, restrictTrip: string) => Promise<PrintRunResult>;
  attachLog: (sessionName: string, skillCommand: string) => void;
}

export const ALLOWED_SKILLS = new Set(['/tp-request', '/tp-daily-check']);
export const LEGACY_SESSION_PREFIX = 'tripline-request-';
export const ORPHAN_MAX_AGE_MS = 90 * 60 * 1000; // 90 minutes
/** 列出某行程待處理請求時的單頁筆數；與 functions/api/requests.ts 的上限一致（超過會被截成 50）。 */
const PENDING_LIST_PAGE_SIZE = 50;
/** 鎖內查隊列／收屍的單次 fetch 逾時；連線卡住不能讓 /tp-request 永遠 busy。 */
export const QUEUE_FETCH_TIMEOUT_MS = 15_000;

/** print 模式同一行程連續處理的輪數上限（每輪處理完仍有新請求才會再跑）。 */
export const PRINT_MAX_ROUNDS = 3;

export function assertAllowedSkill(skillCommand: string): string {
  if (!ALLOWED_SKILLS.has(skillCommand)) {
    throw new Error(`Disallowed skillCommand: ${skillCommand.slice(0, 40)} (allowlist: ${[...ALLOWED_SKILLS].join(', ')})`);
  }
  return skillCommand;
}

export function sessionPrefixForSkill(skillCommand: string): string {
  const verified = assertAllowedSkill(skillCommand);
  const slug = verified.replace(/^\//, '').toLowerCase();
  return `tripline-${slug}-`;
}

export function getKnownSessionPrefixes(): string[] {
  return [...Array.from(ALLOWED_SKILLS).map(sessionPrefixForSkill), LEGACY_SESSION_PREFIX];
}

export function createRequestWorker(deps: WorkerDeps) {
  const runningSkills = new Set<string>();
  let lastProcessed: string | null = null;
  let processedCount = 0;

  async function peekPendingRequest(): Promise<PendingRequest | null> {
    const svcToken = await deps.getServiceToken();
    for (const status of ['processing', 'open'] as const) {
      try {
        const res = await deps.fetch(`${deps.apiBase}/api/requests?status=${status}&sort=asc&limit=1`, {
          headers: { Authorization: `Bearer ${svcToken}` },
          signal: AbortSignal.timeout(QUEUE_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const data = ((await res.json().catch(() => null)) ?? {}) as { items?: Array<{ id?: unknown; tripId?: unknown }> };
        const item = data.items?.[0];
        const rawId = item?.id;
        const tripId = item?.tripId;
        const requestId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId : '';
        if (requestId && typeof tripId === 'string' && tripId) return { requestId, tripId };
      } catch {
        /* best-effort — try next status */
      }
    }
    return null;
  }

  async function mintRestricted(requestId: string): Promise<{ token: string; tripId: string }> {
    const res = await deps.fetch(`${deps.apiBase}/api/oauth/mint-restricted`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiSecret}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(QUEUE_FETCH_TIMEOUT_MS),
      body: JSON.stringify({ request_id: requestId }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw Object.assign(new Error(`mint-restricted ${res.status}: ${detail.slice(0, 120)}`), { kind: 'MINT_FAILED' });
    }
    const data = ((await res.json().catch(() => null)) ?? {}) as { access_token?: unknown; restrict_trip?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.restrict_trip !== 'string' || !data.restrict_trip) {
      throw Object.assign(new Error('mint-restricted response missing access_token/restrict_trip'), { kind: 'MINT_FAILED' });
    }
    return { token: data.access_token, tripId: data.restrict_trip };
  }

  async function acquireToken(skillCommand: string): Promise<AcquiredToken | null> {
    if (deps.userTokenEnabled(skillCommand)) {
      try {
        const pending = await peekPendingRequest();
        if (!pending) {
          deps.log('無 pending request → 不 spawn /tp-request（Option E：只在有可處理請求時起 contained session）');
          return null;
        }
        const { token, tripId } = await mintRestricted(pending.requestId);
        deps.log(`minted owner-restricted token for request ${pending.requestId} (trip ${tripId})`);
        return { token, restrictTrip: tripId, requestId: pending.requestId };
      } catch (err) {
        const e = err as { kind?: string; message?: string };
        deps.logError(`mint-restricted 失敗（/tp-request 不 spawn，避免未-contained session 外洩）：[${e.kind ?? '?'}] ${e.message ?? err}`);
        deps.alert(`mint-${e.kind ?? 'unknown'}`, 'failed',
          `tp-request mint-restricted 失效（${e.kind ?? '?'}）→ 不 spawn。查 /api/oauth/mint-restricted 或 owner Consent。`);
        return null; // 關鍵：不 fallback service token（不起未-contained session 處理不可信輸入）
      }
    }
    try {
      return { token: await deps.getServiceToken() };
    } catch (err) {
      deps.logError(`Token mint 失敗，tmux 不啟動：${(err as Error).message}`);
      return null;
    }
  }

  /** 清掉超過 maxAge 的自家 prefix session（含 legacy prefix）；回清掉幾個。 */
  function cleanupOrphans(maxAgeMs: number): number {
    try {
      const stdout = deps.tmux.list('#{session_name}|#{session_created}');
      if (stdout == null) return 0;
      const knownPrefixes = getKnownSessionPrefixes();
      const now = Math.floor(deps.clock.now() / 1000);
      let killed = 0;
      for (const line of stdout.split('\n')) {
        const parts = line.split('|');
        if (parts.length !== 2) continue;
        const [name, createdStr] = parts as [string, string];
        if (!knownPrefixes.some((p) => name.startsWith(p))) continue;
        const created = parseInt(createdStr, 10);
        if (!created) continue;
        if ((now - created) * 1000 > maxAgeMs) {
          deps.tmux.kill(name);
          deps.log(`Cleaned orphan tmux session: ${name} (age=${now - created}s)`);
          killed++;
        }
      }
      return killed;
    } catch (err) {
      deps.logError(`cleanupOrphans error: ${(err as Error).message}`);
      return 0;
    }
  }

  function hasActiveSession(skillCommand: string): string | null {
    const stdout = deps.tmux.list('#{session_name}');
    if (stdout == null) return null;
    const filter = sessionPrefixForSkill(skillCommand);
    for (const line of stdout.split('\n')) {
      if (line.startsWith(filter)) return line;
      if (skillCommand === '/tp-request' && line.startsWith(LEGACY_SESSION_PREFIX)) return line;
    }
    return null;
  }

  /**
   * 一次 process loop：清 orphan → 同 skill 有 session 就 busy → 取 token / spawn。
   * 同 skill 併發呼叫時第二個直接 busy（per-skill 鎖，取代舊 global isRunning）。
   */
  async function tick(source: 'api' | 'job', skillCommand: string = '/tp-request'): Promise<TickResult> {
    assertAllowedSkill(skillCommand);
    if (runningSkills.has(skillCommand)) {
      deps.log(`processLoop: already running, skip (source=${source}, skill=${skillCommand})`);
      return 'busy';
    }
    runningSkills.add(skillCommand);
    deps.log(`Process loop started (source: ${source}, skill: ${skillCommand})`);
    try {
      const cleaned = cleanupOrphans(ORPHAN_MAX_AGE_MS);
      if (cleaned > 0) deps.log(`Cleaned ${cleaned} orphan session(s)`);
      const active = hasActiveSession(skillCommand);
      if (active) {
        deps.log(`Active ${skillCommand} session ${active} still running, skip new spawn`);
        return 'busy';
      }
      const acquired = await acquireToken(skillCommand);
      if (acquired === null) return 'idle';
      const ok = await spawnWith(skillCommand, acquired);
      if (ok) {
        lastProcessed = new Date(deps.clock.now()).toISOString();
        processedCount++;
        return 'spawned';
      }
      return 'failed';
    } catch (err) {
      deps.logError(`Process loop error: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    } finally {
      runningSkills.delete(skillCommand);
      deps.log(`Process loop ended (skill=${skillCommand})`);
    }
  }

  async function spawnWith(skillCommand: string, acquired: AcquiredToken): Promise<boolean> {
    const sessionName = `${sessionPrefixForSkill(skillCommand)}${deps.clock.now()}-${deps.pid}`;
    if (acquired.restrictTrip) {
      if (deps.containmentReady()) {
        return runSession(sessionName, skillCommand, acquired);
      }
      deps.logError('containment infra 未就緒（tp-agent/sudo/settings/self-probe）→ /tp-request 不 spawn（拒絕未隔離 session 處理不可信輸入）');
      deps.alert('containment-not-ready', 'failed',
        'tp-request 需隔離但 containment (0a) 未就緒 → 不 spawn。設定見 scripts/tp-request-contained/README.md');
      return false;
    }
    if (skillCommand === '/tp-request') {
      deps.logError('/tp-request 走到未-contained 路徑（flag OFF？無 restrict token）→ 拒絕 spawn（不可信輸入不進未隔離 session）');
      deps.alert('tp-request-uncontained-refused', 'failed',
        '/tp-request 落到未-contained 路徑 → 不 spawn。要跑請開 TP_REQUEST_USER_TOKEN=1 走 Option E contained 路徑。');
      return false;
    }
    return runSession(sessionName, skillCommand, acquired);
  }

  /** /tp-daily-check 等信任 skill 的 plain tmux session（fire-and-forget，skill 結束時自行關閉）。 */
  async function runPlainSession(sessionName: string, skillCommand: string, token: string): Promise<boolean> {
    let created = false;
    const pane = { ...deps.pane, sleep: deps.sleep, log: deps.log };
    try {
      created = await deps.createPlainSession(sessionName, skillCommand, token);
      if (!created) throw new Error('session 建立失敗');
      if (!(await waitForRepl(pane, sessionName))) throw new Error('REPL 未就緒');
      if (!(await submitSkillCommand(pane, sessionName, skillCommand))) throw new Error('skill 未提交');
      deps.attachLog(sessionName, skillCommand);
      deps.log(`Spawned tmux session: ${sessionName} (skill=${skillCommand}, fire-and-forget; skill self-destructs at end)`);
      return true;
    } catch (error) {
      deps.logError(`session ${sessionName} 失敗：${error instanceof Error ? error.message : String(error)}`);
      if (created || deps.tmux.has(sessionName)) closeSession(sessionName);
      return false;
    }
  }

  async function runSession(sessionName: string, skillCommand: string, acquired: AcquiredToken): Promise<boolean> {
    if (acquired.restrictTrip) return runPrintSession(sessionName, skillCommand, acquired.token, acquired.restrictTrip, Number(acquired.requestId));
    return runPlainSession(sessionName, skillCommand, acquired.token);
  }

  /**
   * contained `claude -p` 路徑：每輪一個 process，結束即處理完。輪間若同一行程又進來新請求就再跑一輪
   * （舊的互動式 REPL 閒置後沒人再叫它，新請求會卡到 orphan cap）。
   *
   * 失敗收屍的範圍：只收「該輪開始時就在隊列」的請求（它們被嘗試過了）；最後一輪開始後才到的新請求
   * 沒被任何人看過，不陪葬，留給下一個 tick。理由：process 失敗／輪數用盡／max-turns 耗盡，都代表
   * 被嘗試過的請求不會被處理，留著只會每 10 分鐘無限重試。
   * 原因：真的逾時才標 timed_out；其餘（非 0 結束、exit 0 卻沒處理完）一律 error，不誤導成逾時。
   */
  async function runPrintSession(sessionName: string, skillCommand: string, token: string, restrictTrip: string, peekedId?: number): Promise<boolean> {
    let last: PrintRunResult = { ok: true, timedOut: false };
    // 被嘗試過的請求 id：各輪開始時隊列的聯集，只增不減。查不到就維持原集合（起初為空 → 收屍什麼都不動，
    // 交給 100 分鐘牆鐘兜底）：查不到時放寬成「全收」會把沒被任何人看過的新請求一起殺掉。
    // 起點：peek 到的那筆（最舊、第一個會被處理）。第 1 輪開始時就查不到隊列的話，至少它能被收屍，
    // 否則 claude 失敗時沒有任何東西被收，同一批請求會每個 tick 原樣重跑到 100 分鐘牆鐘。
    const attempted = new Set<number>();
    const seed = Number.isFinite(peekedId) ? [peekedId as number] : [];
    let queueUnknown = false; // 最後一次查隊列失敗 → 不能斷定處理成功
    try {
      for (let round = 1; round <= PRINT_MAX_ROUNDS; round++) {
        const before = await listPendingIds(restrictTrip);
        const priorAttempted = new Set(attempted); // 前幾輪已被嘗試過的（不含這輪才第一次看到的）
        for (const id of before ?? []) attempted.add(id);
        last = await deps.runContainedPrint(`${sessionName}-r${round}`, skillCommand, token, restrictTrip);
        deps.log(`contained print: ${sessionName} 第 ${round} 輪結束（ok=${last.ok}, timedOut=${last.timedOut}, started=${last.started ?? true}）`);
        // 基礎設施失敗（sudo 暫時失靈、磁碟滿…）：請求沒被嘗試過，留在隊列給下一個 tick 重試，
        // 由 100 分鐘牆鐘兜底；標成 failed 會讓使用者的請求因為我們這邊的暫時故障而白白作廢。
        if (last.started === false) {
          // 第 2 輪以後才沒能開始：前幾輪已被嘗試卻沒處理成功的請求不能留著，否則下個 tick 會原樣重跑它們。
          // 這輪才第一次看到的請求沒被嘗試過，不動。
          deps.logError(`contained print ${sessionName} 第 ${round} 輪未能開始處理 → 不收屍${priorAttempted.size ? '（已嘗試過的除外）' : ''}，其餘留給下一個 tick`);
          if (priorAttempted.size) await reap(restrictTrip, 'error', priorAttempted);
          return false;
        }
        const after = await listPendingIds(restrictTrip);
        queueUnknown = after === null;
        if (after && after.length === 0) return last.ok; // process 失敗但已無待處理：不需收屍，也不算成功
        // 只有「這輪開始時隊列已知、而執行當中才到了新請求」才值得再跑一輪。查不到隊列、process 失敗、或沒有新請求
        // （剩下的全是已被嘗試卻沒處理成功的）→ 不再重跑：重跑同一批只會把不可信輸入觸發的花費乘上輪數。
        if (!after || !before || !last.ok) break;
        const stale = after.filter((id) => before.includes(id));
        if (stale.length === after.length) break; // 沒有新請求
        // skill 會處理隊列裡所有待處理請求，沒辦法只挑新的跑：先把已被嘗試卻沒處理成功的收屍，下一輪就只剩新請求。
        if (stale.length) await reap(restrictTrip, 'error', new Set(stale));
      }
      const reaped = await reap(restrictTrip, last.timedOut ? 'timed_out' : 'error', new Set([...seed, ...attempted]));
      // process 正常結束且沒有任何已嘗試的請求被收屍 = 這次處理成功（最後一輪結束後才到的新請求留給下一個 tick，不算失敗）。
      return last.ok && reaped === 0 && !queueUnknown;
    } catch (error) {
      deps.logError(`contained print ${sessionName} 失敗：${error instanceof Error ? error.message : String(error)}`);
      await reap(restrictTrip, 'error', new Set([...seed, ...attempted]));
    }
    return false;
  }

  function closeSession(sessionName: string): void {
    deps.tmux.kill(sessionName);
    if (deps.tmux.has(sessionName)) throw new Error(`session ${sessionName} 未能終止，保留 request 等待後續處理`);
  }

  /** 該 trip 還在隊列的 request id（open + processing）；任何一步查不到回 null（呼叫端須當「有待處理」保守處理）。 */
  async function listPendingIds(tripId: string): Promise<number[] | null> {
    try {
      const svc = await deps.getServiceToken();
      const ids: number[] = [];
      for (const status of ['processing', 'open'] as const) {
        const res = await deps.fetch(
          `${deps.apiBase}/api/requests?status=${status}&tripId=${encodeURIComponent(tripId)}&limit=${PENDING_LIST_PAGE_SIZE}`,
          { headers: { Authorization: `Bearer ${svc}` }, signal: AbortSignal.timeout(QUEUE_FETCH_TIMEOUT_MS) },
        );
        if (!res.ok) return null;
        const data = (await res.json().catch(() => null)) as { items?: Array<{ id?: unknown }> } | null;
        if (!Array.isArray(data?.items)) return null;
        for (const item of data.items) if (typeof item?.id === 'number') ids.push(item.id);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** 該 trip 是否仍有 open/processing 請求；查不到一律當「有」（保守：不誤殺）。 */
  async function tripHasPending(tripId: string): Promise<boolean> {
    const ids = await listPendingIds(tripId);
    return ids === null || ids.length > 0;
  }

  /** ADR-0007 第一層：確定沒人會再處理時，把該 trip 的 open/processing 請求就地標終結（`only` 縮小範圍）。 */
  function reap(tripId: string, reason: ReapReason, only?: ReadonlySet<number>): Promise<number> {
    return failPendingRequests(
      { fetch: deps.fetch, apiBase: deps.apiBase, getToken: deps.getServiceToken, log: deps.log, logError: deps.logError, fetchTimeoutMs: QUEUE_FETCH_TIMEOUT_MS },
      tripId,
      reason,
      only,
    );
  }

  return {
    tick,
    cleanupOrphans,
    tripHasPending,
    reap,
    hasActiveSession,
    acquireToken,
    peekPendingRequest,
    /** /health 用：目前跑中的 skill 與統計。 */
    status: () => ({ running: runningSkills.size > 0, runningSkills: Array.from(runningSkills), lastProcessed, processedCount }),
    isRunning: (skillCommand: string) => runningSkills.has(skillCommand),
  };
}
