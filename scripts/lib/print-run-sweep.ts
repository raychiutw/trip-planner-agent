/**
 * 啟動清扫：api-server 在一輪 `claude -p` 處理到一半被重啟（kickstart、崩潰、機器重開）時，
 * 舊 process 不會被帶走：tp-agent 的 claude／MCP 子程序繼續跑、帶著 restrict token 的 session 目錄
 * （含 OAuth token 檔）永遠留在磁碟，而新實例的 in-memory 鎖是空的，會對同一請求再起一個 claude。
 *
 * 新實例啟動時沒有任何自己的 run 在跑，所以「所有 contained run 目錄」都是上一代留下的：
 * 先殺殘留 process 再刪目錄。目錄名來自 sessionPrefix + now + pid（+ `-r<round>`），只認這個格式，
 * 其他東西（例如人為放進去的檔案）不碰。
 * 抽成獨立模組同 request-worker：tripline-api-server.ts import 即啟動 server，無法在 vitest 直接執行。
 */

/** contained run 目錄名：舊 REPL 路徑（無 -r）與 print 路徑（-r<round>）都算上一代殘留。 */
export const RUN_DIR_RE = /^tripline-tp-request-\d+-\d+(-r\d+)?$/;

export interface SweepDeps {
  /** CONTAINED_BASE_DIR 底下的項目名稱；目錄不存在或讀不到回 []。 */
  listEntries: () => string[];
  /** 殺掉命令列帶有該目錄的 tp-agent process。 */
  killRun: (dirName: string) => void;
  /** 刪除該目錄；回傳是否成功。 */
  removeDir: (dirName: string) => boolean;
  log: (msg: string) => void;
  logError: (msg: string) => void;
}

/** @returns 清掉的目錄數 */
export function sweepStalePrintRuns(deps: SweepDeps): number {
  let swept = 0;
  for (const name of deps.listEntries()) {
    if (!RUN_DIR_RE.test(name)) continue;
    deps.killRun(name);
    if (deps.removeDir(name)) swept++;
    else deps.logError(`啟動清掃：刪除 ${name} 失敗（token 檔可能殘留）`);
  }
  if (swept > 0) deps.log(`啟動清掃：清掉上一代留下的 contained run 目錄 ${swept} 個（含殘留 process）`);
  return swept;
}
