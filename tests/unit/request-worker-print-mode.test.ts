import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequestWorker, PRINT_MAX_ROUNDS, type PrintRunResult, type WorkerDeps } from '../../scripts/lib/request-worker';

/**
 * 隊列用 id 清單模擬：每次 print 執行處理掉最前面一筆；`arrivals[n]` 在第 n 次執行「當中」補進新請求
 * （id 從 100 起）。PATCH 收屍會記錄 `reap:<reason>:<id>` 並把該 id 移出隊列。
 */
function fakeHost(opts: { pending: number; arrivals?: Record<number, number>; results?: PrintRunResult[]; processes?: boolean; processesPerRun?: boolean[] }) {
  let queue = Array.from({ length: opts.pending }, (_, i) => i + 1);
  let nextArrival = 100;
  let runs = 0;
  const effects: string[] = [];
  const tmuxSessions: string[] = [];
  const unguardedFetches: string[] = []; // 鎖內、沒帶 timeout signal 的 fetch
  const deps: WorkerDeps = {
    apiBase: 'https://api.test', apiSecret: 'bootstrap', pid: 7,
    getServiceToken: async () => 'service', userTokenEnabled: (skill) => skill === '/tp-request',
    clock: { now: () => 1_700_000_000_000 }, sleep: async () => {},
    log: () => {}, logError: () => {}, alert: () => {}, containmentReady: () => true,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if ((url.pathname.startsWith('/api/requests') || url.pathname.endsWith('mint-restricted')) && !init?.signal) unguardedFetches.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith('mint-restricted')) return Response.json({ access_token: 'trip-token', restrict_trip: 't1' });
      if (url.pathname === '/api/requests' && init?.method !== 'PATCH') {
        // 只在 open 回整個隊列，避免 processing + open 被當成兩批
        const items = url.searchParams.get('status') === 'open' ? queue.map((id) => ({ id, tripId: 't1' })) : [];
        return Response.json({ items });
      }
      const patch = url.pathname.match(/^\/api\/requests\/(\d+)$/);
      if (patch && init?.method === 'PATCH') {
        const id = Number(patch[1]);
        effects.push(`reap:${JSON.parse(String(init.body)).terminalReason}:${id}`);
        queue = queue.filter((q) => q !== id);
        return Response.json({});
      }
      return Response.json({}, { status: 404 });
    },
    tmux: { list: () => null, has: () => false, kill: () => {} },
    createPlainSession: async (name) => { tmuxSessions.push(name); return true; },
    attachLog: () => {},
    pane: { capture: () => '', sendKeys: () => {} },
    runContainedPrint: async () => {
      runs++;
      const result = opts.results?.[runs - 1] ?? { ok: true, timedOut: false };
      if (result.started === false) return result; // 根本沒開始：隊列不會有任何變化
      if ((opts.processesPerRun?.[runs - 1] ?? opts.processes) !== false) queue = queue.slice(1); // processes:false = claude exit 0 卻什麼都沒處理
      for (let i = 0; i < (opts.arrivals?.[runs] ?? 0); i++) queue.push(nextArrival++);
      return result;
    },
  };
  return { deps, effects, tmuxSessions, unguardedFetches, runs: () => runs, queue: () => queue };
}

describe('contained /tp-request 走 claude -p（不經 tmux）', () => {
  it('處理完就結束：只跑一次、不建任何 tmux session', async () => {
    const host = fakeHost({ pending: 1 });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('spawned');
    expect(host.runs()).toBe(1);
    expect(host.tmuxSessions).toEqual([]);
    expect(host.effects).toEqual([]);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('執行當中同一行程又進來新請求：再跑一輪直到清空（#287 回歸）', async () => {
    const host = fakeHost({ pending: 1, arrivals: { 1: 1 } });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('spawned');
    expect(host.runs()).toBe(2);
    expect(host.queue()).toEqual([]);
    expect(host.effects).toEqual([]);
  });

  it('process 非 0 結束且仍有待處理：不再重試，就地收屍為 error（只收被嘗試過的）', async () => {
    const host = fakeHost({ pending: 2, results: [{ ok: false, timedOut: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(1);
    // 該輪開始時隊列是 [1,2]；1 被處理掉了，剩下的 2 被嘗試過卻沒處理成功
    expect(host.effects).toEqual(['reap:error:2']);
  });

  it('process 非 0 結束但待處理剛好清空：不收屍，但如實回報 failed（不計成成功）', async () => {
    const host = fakeHost({ pending: 1, results: [{ ok: false, timedOut: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.effects).toEqual([]);
    expect(worker.status().processedCount).toBe(0);
  });

  it('逾時被砍：收屍為 timed_out', async () => {
    const host = fakeHost({ pending: 2, results: [{ ok: false, timedOut: true }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.effects).toEqual(['reap:timed_out:2']);
  });

  it('exit 0 卻沒處理完（claude 什麼都沒處理）：不重跑同一批（花費不乘輪數），收屍為 error，不誤標成逾時', async () => {
    const host = fakeHost({ pending: 2, processes: false });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(1);
    expect(host.effects).toEqual(['reap:error:1', 'reap:error:2']);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('輪數用盡時，最後一輪開始後才到的新請求不陪葬（留給下一個 tick）', async () => {
    // 第 3 輪執行當中又進來 id=102：它從沒被任何一輪看過
    const host = fakeHost({ pending: 1, arrivals: { 1: 1, 2: 1, 3: 1 } });
    const worker = createRequestWorker(host.deps);
    await worker.tick('job');
    expect(host.queue()).toContain(102);
    expect(host.effects.some((e) => e.endsWith(':102'))).toBe(false);
  });

  it('某一輪開始時查不到隊列：被嘗試過的集合不縮也不放寬成「全收」，沒被看過的新請求不陪葬', async () => {
    // 第 1 輪處理掉 id=1，執行當中進來 id=100 → 第 2 輪再跑；第 2 輪開始時隊列查不到、且該輪失敗
    const host = fakeHost({ pending: 1, arrivals: { 1: 1 }, processesPerRun: [true, false], results: [{ ok: true, timedOut: false }, { ok: false, timedOut: false }] });
    const original = host.deps.fetch;
    let tripListCalls = 0;
    host.deps.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/requests' && init?.method !== 'PATCH' && url.searchParams.has('tripId')) {
        tripListCalls++;
        // 第 1 輪 before（#1 #2）、第 1 輪 after（#3 #4）正常；第 2 輪 before（#5 #6）讀不到
        if (tripListCalls === 5 || tripListCalls === 6) return Promise.resolve(Response.json({ unavailable: true }));
      }
      return original(input, init);
    };
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(2);
    expect(host.queue()).toContain(100);
    expect(host.effects.some((e) => e.endsWith(':100'))).toBe(false);
  });

  it('根本沒開始處理（prepare 失敗、spawn error）：不收屍，請求留在隊列給下一個 tick 重試', async () => {
    const host = fakeHost({ pending: 2, processes: false, results: [{ ok: false, timedOut: false, started: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(1); // 不在同一個 tick 內硬重跑
    expect(host.effects).toEqual([]); // 沒被嘗試過的請求不能被標成「處理失敗」
    expect(host.queue()).toEqual([1, 2]);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('started 缺省視為已開始（process 有跑，只是失敗）：照舊收屍', async () => {
    const host = fakeHost({ pending: 2, processes: false, results: [{ ok: false, timedOut: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.effects).toEqual(['reap:error:1', 'reap:error:2']);
  });

  it('第 2 輪才發現沒開始處理：前一輪已被嘗試卻沒處理成功的請求要收屍，執行當中才到的新請求不動', async () => {
    // 第 1 輪處理掉 id=1、執行當中進來 100；id=2 被嘗試卻沒被處理 → 第 2 輪（為了 100）沒能開始
    const host = fakeHost({ pending: 2, arrivals: { 1: 1 }, results: [{ ok: true, timedOut: false }, { ok: false, timedOut: false, started: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(2);
    expect(host.effects).toEqual(['reap:error:2']); // 不收屍的話 id=2 會在下個 tick 被原樣重跑
    expect(host.queue()).toEqual([100]);
  });

  it('新請求到達時，已嘗試卻沒處理成功的請求先收屍，再為新請求跑下一輪（不原樣重跑同一批）', async () => {
    // 第 1 輪處理掉 id=1、執行當中進來 100；id=2 被嘗試卻沒處理 → 先收屍 2，第 2 輪只剩 100
    const host = fakeHost({ pending: 2, arrivals: { 1: 1 } });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('spawned');
    expect(host.runs()).toBe(2);
    expect(host.effects).toEqual(['reap:error:2']);
    expect(host.queue()).toEqual([]);
  });

  it('輪次判斷查不到「這輪開始時的隊列」時不當成全是新請求去重跑', async () => {
    const host = fakeHost({ pending: 2, arrivals: { 1: 1 } });
    const original = host.deps.fetch;
    let tripListCalls = 0;
    host.deps.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/requests' && init?.method !== 'PATCH' && url.searchParams.has('tripId')) {
        tripListCalls++;
        if (tripListCalls === 1) return Promise.resolve(Response.json({ unavailable: true })); // 只有第 1 輪的 before 讀不到（一失敗 listPendingIds 就直接回 null，不會再打第二個狀態）
      }
      return original(input, init);
    };
    const worker = createRequestWorker(host.deps);
    await worker.tick('job');
    expect(host.runs()).toBe(1);
  });

  it('第 1 輪開始時查不到隊列、且 claude 失敗：至少收屍 peek 到的那一筆（否則每個 tick 原樣重跑到牆鐘）', async () => {
    const host = fakeHost({ pending: 2, processes: false, results: [{ ok: false, timedOut: false }] });
    const original = host.deps.fetch;
    let tripListCalls = 0;
    host.deps.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/requests' && init?.method !== 'PATCH' && url.searchParams.has('tripId')) {
        tripListCalls++;
        if (tripListCalls === 1) return Promise.resolve(Response.json({ unavailable: true })); // 第 1 輪 before 讀不到
      }
      return original(input, init);
    };
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.effects).toContain('reap:error:1'); // peek 到的是最舊的 id=1
    expect(host.effects.some((e) => e.endsWith(':2'))).toBe(false); // 沒被確認嘗試過的不動
  });

  it('處理成功就回報 spawned：最後一輪結束後隊列仍有「執行當中才到的新請求」不算失敗', async () => {
    const host = fakeHost({ pending: 1, arrivals: { 1: 1, 2: 1, 3: 1 } });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('spawned');
    expect(host.runs()).toBe(PRINT_MAX_ROUNDS);
    expect(host.effects).toEqual([]);
    expect(host.queue()).toEqual([102]); // 留給下一個 tick
    expect(worker.status().processedCount).toBe(1);
  });

  it('鎖內每個打 /api/requests 的 fetch 都帶 timeout signal（連線卡住不能讓 /tp-request 永遠 busy）', async () => {
    const host = fakeHost({ pending: 2, processes: false });
    const worker = createRequestWorker(host.deps);
    await worker.tick('job');
    // peek、mint、列出隊列、收屍的列表與 PATCH 都在鎖內，都要有
    expect(host.unguardedFetches).toEqual([]);
  });

  it('runContainedPrint 丟例外也釋放鎖並收屍為 error', async () => {
    const host = fakeHost({ pending: 1 });
    host.deps.runContainedPrint = async () => { throw new Error('spawn failed'); };
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.effects).toEqual(['reap:error:1']);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('讀不到隊列（API 回非預期內容）不能被當成「已清空」：不誤判成功、不誤收屍', async () => {
    const host = fakeHost({ pending: 1 });
    const original = host.deps.fetch;
    host.deps.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/requests' && init?.method !== 'PATCH' && url.searchParams.has('tripId')) return Promise.resolve(Response.json({ unavailable: true }));
      return original(input, init);
    };
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed'); // 無法確認清空 → 不當成功，也不盲目重跑
    expect(host.runs()).toBe(1);
    expect(host.effects).toEqual([]); // reap 的列表也讀不到 → 不動手（誤殺比殭屍更糟）
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('失敗後鎖已釋放：下一個 tick 是 idle（沒待處理），不是 busy', async () => {
    const host = fakeHost({ pending: 1, results: [{ ok: false, timedOut: false }] });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(worker.status().runningSkills).toEqual([]);
    expect(await worker.tick('job')).toBe('idle'); // 隊列已空 → idle；若鎖沒放掉會是 busy
  });

  it('同 skill 併發 tick → 第二個 busy（per-skill 鎖），完成後釋放', async () => {
    const host = fakeHost({ pending: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = host.deps.runContainedPrint;
    host.deps.runContainedPrint = async (...args) => { await gate; return run(...args); };
    const worker = createRequestWorker(host.deps);
    const first = worker.tick('api');
    expect(await worker.tick('job')).toBe('busy');
    release();
    expect(await first).toBe('spawned');
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('containment 未就緒 → 不跑 claude，也不收屍', async () => {
    const host = fakeHost({ pending: 1 });
    host.deps.containmentReady = () => false;
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe('failed');
    expect(host.runs()).toBe(0);
    expect(host.effects).toEqual([]);
  });
});

describe('tripline-api-server 接線', () => {
  // 守衛讀原始碼要先剝註解，否則註解裡的字面值會讓斷言假綠
  const src = readFileSync('scripts/tripline-api-server.ts', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('沒有旗標：runContainedPrint 無條件注入，舊的 contained REPL 路徑已移除', () => {
    expect(src).toMatch(/\n {2}runContainedPrint,\n/);
    expect(src).not.toMatch(/TP_REQUEST_PRINT_MODE/);
    expect(src).not.toMatch(/createContainedSession|watchContainedSession/);
  });

  it('pkill 樣式要跳脫並錨定結尾（否則 -r1 會連帶殺 -r10、路徑的 . 會變萬用字元）', () => {
    expect(src).toMatch(/function killRunProcesses[\s\S]*?replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g[\s\S]*?\(\/\|\$\| \)/);
  });

  it('runAsAgent 有 timeout（spawnSync 會凍住整個 event loop）；清理失敗要 alert', () => {
    expect(src).toMatch(/spawnSync\('sudo'[\s\S]*?timeout: RUN_AS_AGENT_TIMEOUT_MS/);
    expect(src).toMatch(/throttledAlert\('print-run-cleanup-failed'/);
  });

  it('prepare 失敗回報 started:false（讓 worker 不收屍）；計時與收尾交給 superviseRun（行為見 print-run.test.ts）', () => {
    expect(src).toMatch(/if \(!prepared\) return \{ ok: false, timedOut: false, started: false \};/);
    expect(src).toMatch(/await superviseRun\(child, \{/);
    expect(src).toMatch(/writeLog: \(text\) => appendFileSync\(logFile, text, \{ mode: 0o600 \}\)/);
    expect(src).toMatch(/scrub,/);
  });

  it('佈置／spawn 階段的例外回報 started:false，不往上拋（否則會被當成處理失敗而收屍）', () => {
    expect(src).toMatch(/catch \(err\) \{\s*logError\(`contained print 啟動前失敗[\s\S]*?return \{ ok: false, timedOut: false, started: false \};/);
    // 整個 prepare → spawn 都在這個 try 之內
    const body = src.slice(src.indexOf('async function runContainedPrint('));
    expect(body.indexOf('prepareContainedSessionDir(runName')).toBeLessThan(body.indexOf('啟動前失敗'));
    expect(body.indexOf("spawn('/bin/sh'")).toBeLessThan(body.indexOf('啟動前失敗'));
  });

  it('log 目錄只是輔助：mkdir 失敗不能讓整輪 reject（會被當成處理失敗而收屍）', () => {
    expect(src).toMatch(/try \{ mkdirSync\(logDir, \{ recursive: true \}\); \} catch \{\s*\}/);
  });

  it('清理在最外層 finally：prepare 寫到一半失敗也會清；殘留子程序一併殺；rm 失敗要記 log', () => {
    expect(src).toMatch(/finally\s*\{[\s\S]*?killRunProcesses\(sessionDir\);[\s\S]*?runAsAgent\(\['rm', '-rf', sessionDir\]\);[\s\S]*?logError\(/);
    expect(src.indexOf('const prepared = prepareContainedSessionDir(runName')).toBeGreaterThan(src.indexOf('async function runContainedPrint('));
  });

  it('啟動時清掃上一代殘留（api-server 重啟會留下孤兒 process 與 token 目錄）', () => {
    expect(src).toMatch(/sweepStalePrintRuns\(/);
    expect(src).toMatch(/\nsweepOnStartup\(\);/);
    // listen 之後才清掃（port 被別的實例佔著時不能去殺對方進行中的 run）；只需要 sudo，不看 OAuth 是否就緒
    expect(src.indexOf('\nsweepOnStartup();')).toBeGreaterThan(src.indexOf('Bun.serve('));
    expect(src).toMatch(/function sweepOnStartup[\s\S]*?runAsAgent\(\['true'\]\)/);
    expect(src.slice(src.indexOf('function sweepOnStartup'), src.indexOf('function sweepOnStartup') + 400)).not.toMatch(/containmentReady/);
  });
});
