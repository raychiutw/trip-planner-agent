/**
 * funnel-guard health probe — authoritative-NS edition (v2.55.17)
 *
 * 2026-07-05 incident：原 L2/L3 用 recursive resolver (1.1.1.1/8.8.8.8) 判 funnel
 * 對外可達，但大型 recursive 對 *.ts.net funnel hostname 因 Tailscale 週期 re-publish
 * 造成 negative-cache 300s → 反覆 NXDOMAIN → guard 誤判 drift → serve reset 惡化 →
 * self-perpetuating flapping。funnel 服務本身全程健康。
 *
 * 改查 authoritative NS (dnsimple) 的 A record（= 控制平面實際發布的真相，不受
 * recursive cache 污染）：真 drift（authoritative 也無 record）仍偵測得到 → heal；
 * 假 drift（authoritative 有、只是 recursive cache）→ 判 healthy 不 heal。
 *
 * source-grep 鎖關鍵邏輯防誤改回 recursive。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUARD = readFileSync(
  join(__dirname, '../../scripts/funnel-guard/guard.sh'),
  'utf8',
);

describe('funnel-guard 3-layer probe', () => {
  it('is_funnel_healthy 依序檢 L1 local / L2 authoritative DNS / L3 reach', () => {
    expect(GUARD).toMatch(/is_funnel_local_healthy \|\| \{ log "L1/);
    expect(GUARD).toContain('is_funnel_dns_published "$host"');
    expect(GUARD).toContain('is_funnel_reach_ok "$host"');
  });

  it('L1 (local) 邏輯保留 — AllowFunnel + Proxy jq query', () => {
    expect(GUARD).toContain('is_funnel_local_healthy()');
    expect(GUARD).toMatch(/AllowFunnel.*endswith\(":443"\)/s);
    expect(GUARD).toMatch(/Proxy] \| any\(\. == \$proxy\)/);
  });

  it('funnel_hostname helper 取 first :443 key from AllowFunnel', () => {
    expect(GUARD).toContain('funnel_hostname()');
    expect(GUARD).toMatch(/AllowFunnel \/\/ \{\} \| keys\[\]\?/);
    expect(GUARD).toMatch(/sed 's\/:443\$\/\/'/);
  });
});

describe('authoritative NS resolve (2026-07-05 recursive-negative-cache incident fix)', () => {
  it('查 authoritative NS 而非 recursive resolver — 舊 recursive 實作已移除', () => {
    expect(GUARD).toContain('funnel_resolve_authoritative()');
    expect(GUARD).not.toContain('PUBLIC_RESOLVERS');
    expect(GUARD).not.toContain('funnel_resolve_public');
  });

  it('動態取 ts.net NS delegation + grep 白名單防 dig 診斷污染 stdout', () => {
    expect(GUARD).toContain('dig +short +time=3 +tries=1 NS ts.net');
    // dig 連線層失敗會把 `;; ...` 診斷印到 stdout — grep 只留合法 NS hostname 行
    expect(GUARD).toContain("grep -E '^[A-Za-z0-9._-]+\\.$'");
  });

  it('dig NS 取不到時 fallback 到已知 dnsimple NS', () => {
    expect(GUARD).toContain('FALLBACK_NS=(ns1.dnsimple.com');
    expect(GUARD).toContain('nslist=("${FALLBACK_NS[@]}")');
  });

  it('A record 查詢經 IPv4 白名單過濾（排除 CNAME/雜訊 + injection）', () => {
    expect(GUARD).toContain('dig +short +time=3 +tries=1 A "$host" @"$ns"');
    // 嚴格四段式（2026-09-04 security 稽核：舊的 ^[0-9]+\.[0-9.]+$ 連 1.2.3.4.5 都放行）
    expect(GUARD).toContain("grep -E '^([0-9]{1,3}\\.){3}[0-9]{1,3}$'");
  });

  it('L2 is_funnel_dns_published = authoritative 有 record（控制平面已發布）', () => {
    expect(GUARD).toContain('is_funnel_dns_published()');
    expect(GUARD).toContain('funnel_resolve_authoritative "$host" >/dev/null');
  });
});

describe('L3 HTTPS reach probe — curl 000 false-healthy guard', () => {
  it('curl --resolve 用 authoritative IP（避過本機 MagicDNS + recursive 污染）', () => {
    expect(GUARD).toContain('ips=$(funnel_resolve_authoritative "$host") || { REACH_DETAIL="authoritative resolve failed"; return 1; }');
    expect(GUARD).toContain('curl -sS -o /dev/null -w "%{http_code}" --max-time 10');
    expect(GUARD).toContain('--resolve "${host}:443:${ip}" "https://${host}/"');
  });

  it('reach 結果存 REACH_DETAIL 診斷（ip / curl exit / http_code）— 型態 D 事後不用猜', () => {
    expect(GUARD).toContain('REACH_DETAIL="ip=${ip} curl_exit=${curl_exit} http_code=${http_code}"');
    // 全 edge 失敗時逐一列出每個 edge 的細節，不只最後一個
    expect(GUARD).toContain('details+=("ip=${ip} curl_exit=${curl_exit} http_code=${http_code:-none}")');
  });

  it('只認真 HTTP response (1xx-5xx) — 排除 curl transport-fail 000（dead ingress 不誤判 healthy）', () => {
    expect(GUARD).toMatch(/\[\[ "\$http_code" =~ \^\[1-5\]\[0-9\]\{2\}\$ \]\]/);
    // 000 false-healthy regression guard：不可退回接受任意 3-digit
    expect(GUARD).not.toMatch(/\^\[0-9\]\{3\}\$/);
  });

  it('10s timeout 涵蓋 DERP relay cold path', () => {
    expect(GUARD).toContain('--max-time 10');
  });
});

describe('real-drift detection preserved', () => {
  it('authoritative 也無 record → L2 判「控制平面未發布，真 drift」→ 仍 heal', () => {
    expect(GUARD).toContain('控制平面未發布，真 drift');
  });
});

describe('L3 blip 容忍（2026-07-07 型態 D：edge 33s 瞬斷誤 heal ×3 + 噪音）', () => {
  it('L3 fail 重試確認（max_attempts 預設 3 + 間隔）才判 unhealthy — 不可退回單次即 heal', () => {
    expect(GUARD).toContain('local max_attempts="${1:-3}"');
    expect(GUARD).toMatch(/for \(\( attempt=1; attempt<=max_attempts; attempt\+\+ \)\)/);
    expect(GUARD).toContain('sleep "$L3_RETRY_INTERVAL"');
  });

  it('L3_RETRY_INTERVAL 環境變數可覆寫（test-guard.sh 設 0 加速），預設 15s', () => {
    expect(GUARD).toContain('L3_RETRY_INTERVAL="${L3_RETRY_INTERVAL:-15}"');
  });

  it('heal 後重驗單次（is_funnel_healthy 1）— retry 窗不可 double，sustained outage 警報不能拖過 120s interval', () => {
    expect(GUARD).toContain('if is_funnel_healthy 1; then');
  });

  it('重試通過 → 明確 log blip 自癒不 heal（可觀測性）', () => {
    expect(GUARD).toContain('短暫 blip 自癒，不 heal');
  });
});

describe('L3 多 edge 探測（2026-09-01 incident：單 edge head -1 誤報 159 次 / 36 次無效 heal）', () => {
  /**
   * funnel hostname 由 Tailscale 發布多個 A record（本次 103.84.155.153 /
   * .217）。真實 client（CF Worker / 瀏覽器 / curl）拿到整份 A record 清單，
   * 第一個 edge 不通會自動 fallback 到下一個 → 單一 edge 抖動不代表服務不可達。
   *
   * 舊實作 funnel_resolve_authoritative 用 `head -1`，恆定只探第一個 IP
   * (.153)：整份 log 528 次 L3 fail 全部是 .153，.217 從未被探測過。.153 一
   * 抖動 guard 就判整個 funnel unhealthy → serve reset（對 edge 側問題無效，
   * 且 reset 瞬間 funnel 真 off 反而加重）→ 2026-09-01 單日 38 次 heal 有 36
   * 次「heal 後仍 unhealthy」+ 20 則 Telegram 噪音。
   *
   * IPv6：本機無 IPv6 出口（AAAA edge curl exit=7），刻意不納入探測 —— 探不到
   * 不代表服務壞，納入會製造新的誤報來源。
   */
  it('resolve 回傳所有 IPv4 A record — 不可退回 head -1 單 edge', () => {
    expect(GUARD).toContain("ips=$(dig +short +time=3 +tries=1 A \"$host\" @\"$ns\" 2>/dev/null | grep -E '^([0-9]{1,3}\\.){3}[0-9]{1,3}$')");
    // head -1 是本 incident 的根因，不可復現
    expect(GUARD).not.toMatch(/grep -E '\^\[0-9\]\+\\\.\[0-9\.\]\+\$' \| head -1/);
  });

  it('L3 逐一嘗試每個 edge，任一通即判 reachable', () => {
    // (u) 去重：重複 A record 不得讓探測時間翻倍
    expect(GUARD).toContain('probe_list=(${(u)${(f)ips}})');
    expect(GUARD).toContain('for ip in "${probe_list[@]}"; do');
    // 探測數量上限：DNS 回覆是外部輸入，沒有上限等於讓對方決定腳本跑多久
    expect(GUARD).toContain('MAX_EDGE_PROBES="${MAX_EDGE_PROBES:-4}"');
    // 截斷用的是使用點 clamp 過的 cap，不是可被呼叫者改掉的全域值
    expect(GUARD).toContain('probe_list=(${probe_list[1,$cap]})');
    // 命中 → 設 REACH_DETAIL 後立即 return 0（早退，不必等其餘 edge）
    expect(GUARD).toMatch(
      /REACH_DETAIL="ip=\$\{ip\} curl_exit=\$\{curl_exit\} http_code=\$\{http_code\}"[\s\S]{0,400}return 0/,
    );
    // 失敗的 edge 累積後才 return 1（迴圈外），不可第一個 edge 不通就放棄
    expect(GUARD).toMatch(/details\+=\([\s\S]{0,200}done[\s\S]{0,200}return 1/);
  });

  it('全部 edge 都不通才判 unhealthy（REACH_DETAIL 匯總所有 edge）', () => {
    expect(GUARD).toContain('REACH_DETAIL="${(j:; :)details}"');
  });

  it('IPv6 AAAA 刻意不探（本機無 IPv6 出口，探不到 ≠ 服務壞）', () => {
    expect(GUARD).not.toContain('AAAA');
  });

  it('REACH_DEGRADED 在任何 early return 之前就清空（殘值不得跨呼叫存活）', () => {
    expect(GUARD).toMatch(
      /REACH_DEGRADED=""[\s\S]{0,120}\[ -z "\$host" \] && return 1[\s\S]{0,200}authoritative resolve failed/,
    );
  });

  it('部分 edge 掛掉但服務可達 → 記錄降級並明說不 heal（追蹤單 edge 長期劣化）', () => {
    expect(GUARD).toContain('REACH_DEGRADED=""');
    expect(GUARD).toContain('[ ${#details[@]} -gt 0 ] && REACH_DEGRADED="${(j:; :)details}"');
    expect(GUARD).toContain('L3 部分 edge 不可達但服務仍可達，不 heal');
  });
});

describe('probe seam 與端到端接線（2026-09-04 codex + testing 稽核）', () => {
  it('curl 抽成 probe_edge_http_code seam — 行為測試才能不依賴真 funnel／網路', () => {
    expect(GUARD).toContain('probe_edge_http_code() {');
    expect(GUARD).toContain('http_code=$(probe_edge_http_code "$ip" "$host")');
  });

  it('is_funnel_healthy 消費 REACH_DEGRADED 的接線存在（mutation 曾兩層全綠漏掉）', () => {
    expect(GUARD).toMatch(/\[ -n "\$\{REACH_DEGRADED:-\}" \] && log "L3 部分 edge 不可達但服務仍可達/);
  });
});

describe('外部輸入硬化（2026-09-05 red team）', () => {
  it('REPO_ROOT 預設從腳本自身路徑推導，不再硬編碼', () => {
    expect(GUARD).toContain('REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${(%):-%x}")/../.." && pwd)}"');
    expect(GUARD).not.toContain('REPO_ROOT="/Users/ray/Projects/trip-planner"');
  });

  it('被 source 時不開 errexit — 測試 harness 要 bad() 聚合而非直接終止', () => {
    expect(GUARD).toContain('[ "${GUARD_SOURCE_ONLY:-}" = "1" ] || set -eo pipefail');
  });

  it('使用點再 clamp 一次 — source 後改全域值不得繞過 source 時的驗證', () => {
    expect(GUARD).toContain('local cap="$MAX_EDGE_PROBES"');
    expect(GUARD).toContain('[[ "$cap" == <1-16> ]] || cap=4');
    expect(GUARD).toContain('probe_list=(${probe_list[1,$cap]})');
  });

  it('MAX_EDGE_PROBES 必須驗證為有界正整數（<1-> 只驗下界，超大值等於沒有上限）', () => {
    expect(GUARD).toMatch(/if \[\[ "\$MAX_EDGE_PROBES" != <1-16> \]\]; then\s*\n\s*MAX_EDGE_PROBES=4/);
    // 不可退回只驗下界
    expect(GUARD).not.toContain('!= <1-> ]]');
  });
});
