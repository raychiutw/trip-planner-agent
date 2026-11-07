/**
 * 來源 IP 判定：只放行本機與 Cloudflare（issue #12）。
 *
 * Funnel 流量經 Tailscale → Caddy → agent，TCP 對端永遠是 127.0.0.1；真實來源在
 * Tailscale 以 Set 寫入的 X-Forwarded-For（Caddy 設了 trusted_proxies 後會在後面追加自己的跳點）。
 * 所以：對端必須是 loopback 才信 XFF；XFF 第一段是真實來源，其後的跳點都必須是 loopback。
 * 判不出來一律拒絕（fail closed）。
 */
import { BlockList, isIP } from 'node:net';

// Cloudflare 官方公布網段，2026-11-07 取自 https://www.cloudflare.com/ips-v4 與 /ips-v6。
// 網段異動時只改這裡；刻意不在執行期抓取（不讓啟動依賴外部網路）。
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

// v4 與 v6 規則放同一份 BlockList：IPv4-mapped IPv6（::ffff:a.b.c.d）要靠 v4 規則才比對得到。
function listOf(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    list.addSubnet(addr, Number(bits), isIP(addr) === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

const cloudflare = listOf([...CLOUDFLARE_V4, ...CLOUDFLARE_V6]);
const loopback = listOf(['127.0.0.0/8', '::1/128']);

/** 純 IP 字串（不含 port、不含 zone）才算數；其餘回 null。 */
function inList(raw: string, list: BlockList): boolean | null {
  const ip = raw.trim();
  const kind = isIP(ip);
  if (kind === 0) return null;
  return list.check(ip, kind === 4 ? 'ipv4' : 'ipv6');
}

export type SourceVerdict =
  | { ok: true; ip: string }
  | { ok: false; ip: string; reason: string };

/**
 * viaFunnel：請求帶 Tailscale-Funnel-Request（Tailscale 會先刪掉 client 自帶的同名 header，所以可信）。
 * 這種請求一定來自公網，來源只能是 Cloudflare；若 XFF 看起來是 loopback 或不見了，代表 Caddy 沒設
 * trusted_proxies 把它改寫掉了 —— 這時要擋，不能把公網流量當成本機。
 */
export function checkSource(peer: string | undefined, forwardedFor: string | null, viaFunnel = false): SourceVerdict {
  if (!peer) return { ok: false, ip: '-', reason: 'peer-unknown' };
  if (inList(peer, loopback) !== true) return { ok: false, ip: peer, reason: 'peer-not-loopback' };
  if (forwardedFor === null) {
    return viaFunnel ? { ok: false, ip: '-', reason: 'funnel-without-xff' } : { ok: true, ip: peer };
  }

  const [client, ...hops] = forwardedFor.split(',');
  if (inList(client, cloudflare) === null) return { ok: false, ip: forwardedFor.slice(0, 64), reason: 'xff-malformed' };
  if (hops.some((h) => inList(h, loopback) !== true)) {
    return { ok: false, ip: forwardedFor.slice(0, 64), reason: 'xff-untrusted-hop' };
  }
  const ip = client.trim();
  if (inList(ip, loopback)) {
    return viaFunnel ? { ok: false, ip, reason: 'funnel-not-cloudflare' } : { ok: true, ip };
  }
  return inList(ip, cloudflare) ? { ok: true, ip } : { ok: false, ip, reason: 'not-local-or-cloudflare' };
}
