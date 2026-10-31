/**
 * ADR-0007 第一層收屍 —— api-server 確定「不會再有人處理」時就地標終結。
 *
 * 為什麼要有這層：reaper 到 90 分鐘 orphan cap 只 `tmux kill-session`，不動
 * trip_requests row，於是 request 永遠停在 processing。後果不只是轉圈圈 ——
 * ChatPage 的 composer 綁 inflight（整個聊天鎖死），而 peekPendingRequest 依
 * processing → open oldest-first 撈，一筆殭屍會 head-of-line block 所有行程的隊列。
 *
 * 為什麼**只殺列表回報還在跑的那些**：PATCH `status='failed'` 從任何狀態都合法
 * （requests/[id] 的 failed 例外），無條件打會把剛完成的 request 一起清掉。
 * 呼叫端一律先 `tmux kill-session` 再呼叫本函式 —— session 已死，列表與 PATCH
 * 之間沒有東西能完成那筆請求，所以沒有 TOCTOU 視窗。
 *
 * 抽成獨立模組的理由同 tmux-pane.ts：tripline-api-server.ts import 即啟動 server
 * （top-level setInterval / scheduleDaily），無法在 vitest 直接 import 執行。
 */

/** 第一層用得到的終結原因。cancelled 是使用者按的、needs_consent 是 mint-restricted park 的。 */
export type ReapReason = 'timed_out' | 'error';

export interface FailPendingDeps {
  fetch: typeof fetch;
  apiBase: string;
  getToken: () => Promise<string>;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  /** 每個 fetch 的逾時（ms）；省略 = 不設（舊呼叫端相容）。 */
  fetchTimeoutMs?: number;
}

/**
 * 把 `tripId` 底下還在跑（open / processing）的 request 全部標成終結。
 *
 * 全程 best-effort：任何一步失敗都只記錄不拋，因為呼叫端全在 cleanup path 上，
 * 收不到就交給 GET /requests/:id 的 100 分鐘牆鐘兜底（見 _requestTermination.ts）。
 *
 * `only`：呼叫端只想收「該輪開始時就在隊列、已被嘗試過」的請求；之後才到的新請求沒被任何人看過，
 * 不能陪葬，留給下一個 tick。
 *
 * @returns 實際標成功的筆數
 */
export async function failPendingRequests(
  deps: FailPendingDeps,
  tripId: string,
  reason: ReapReason,
  /** 只收這些 id（其餘留給下一輪）；省略 = 該 trip 底下全部。 */
  only?: ReadonlySet<number>,
): Promise<number> {
  let token: string;
  try {
    token = await deps.getToken();
  } catch (err) {
    deps.logError(`收屍取 token 失敗（交給牆鐘兜底）：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const signal = () => (deps.fetchTimeoutMs ? AbortSignal.timeout(deps.fetchTimeoutMs) : undefined);

  const ids: number[] = [];
  for (const status of ['processing', 'open'] as const) {
    try {
      const url = `${deps.apiBase}/api/requests?status=${status}`
        + `&tripId=${encodeURIComponent(tripId)}&limit=50`;
      const res = await deps.fetch(url, { headers, signal: signal() });
      // 不確定就不動手：查不到 ≠ 沒有待處理。誤判成「沒有」只是這輪不收（牆鐘兜底），
      // 誤判成「有」則無從發生（下面只走 items 裡真的有的 id）。
      if (!res.ok) {
        deps.logError(`收屍列表查詢失敗（status=${status}, HTTP ${res.status}）→ 本輪不收`);
        return 0;
      }
      const data = (await res.json().catch(() => null)) as { items?: Array<{ id?: unknown }> } | null;
      if (data == null || !Array.isArray(data.items)) {
        deps.logError(`收屍列表 body 非預期（status=${status}）→ 本輪不收`);
        return 0;
      }
      for (const item of data.items) {
        if (typeof item?.id === 'number' && (!only || only.has(item.id))) ids.push(item.id);
      }
    } catch (err) {
      deps.logError(`收屍列表查詢爆錯（status=${status}）：${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  let reaped = 0;
  for (const id of ids) {
    try {
      const res = await deps.fetch(`${deps.apiBase}/api/requests/${id}`, {
        method: 'PATCH',
        headers,
        signal: signal(),
        body: JSON.stringify({ status: 'failed', terminalReason: reason }),
      });
      if (res.ok) {
        reaped++;
      } else {
        deps.logError(`收屍 PATCH request ${id} 失敗（HTTP ${res.status}）`);
      }
    } catch (err) {
      deps.logError(`收屍 PATCH request ${id} 爆錯：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (reaped > 0) deps.log(`收屍 ${reaped} 筆 request（trip=${tripId}, reason=${reason}）`);
  return reaped;
}
