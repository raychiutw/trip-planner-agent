/**
 * place_id 回填的比對規則（純函式，#1605）。
 *
 * 合格候選 = 名稱相似度 >= minSimilarity 且 座標距離 <= maxDistanceM。
 * 恰好 1 個合格才選；0 個或 2 個以上（不同 place_id）一律不選，交給人工。
 * 寧可漏補也不要補錯：錯的 place_id 會讓評分與營業時間顯示成別的店。
 */

export interface MatchOpts {
  /** 名稱相似度下限，0~1。1 = 正規化後完全相同。 */
  minSimilarity: number;
  /** 座標距離上限（公尺）。 */
  maxDistanceM: number;
}

/** 保守預設：名稱幾乎一致（Dice >= 0.9）且 150 m 內。 */
export const DEFAULT_MATCH_OPTS: MatchOpts = { minSimilarity: 0.9, maxDistanceM: 150 };

export interface Candidate {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface PoiRef {
  name: string;
  lat: number;
  lng: number;
}

export type Decision =
  | { kind: 'match'; candidate: Candidate; similarity: number; distanceM: number }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'none'; reason: 'no-results' | 'no-name-match' | 'name-match-too-far' | 'bad-coords' };

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** NFKC + 小寫 + 只留字母數字（去空白、標點、全半形差異）。 */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 正規化後相同為 1，否則字元 bigram 的 Dice 係數（單字元名稱只認完全相同）。 */
export function nameSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) ?? 0);
  return (2 * common) / (x.length - 1 + (y.length - 1));
}

export function decide(poi: PoiRef, candidates: Candidate[], opts: MatchOpts): Decision {
  if (![poi.lat, poi.lng].every(Number.isFinite)) return { kind: 'none', reason: 'bad-coords' };
  if (candidates.length === 0) return { kind: 'none', reason: 'no-results' };

  const seen = new Set<string>();
  const ok: Array<{ c: Candidate; similarity: number; distanceM: number }> = [];
  let nameMatched = false;
  for (const c of candidates) {
    if (seen.has(c.place_id)) continue;
    seen.add(c.place_id);
    const similarity = nameSimilarity(poi.name, c.name);
    if (similarity < opts.minSimilarity) continue;
    nameMatched = true;
    const distanceM = haversineM(poi.lat, poi.lng, c.lat, c.lng);
    // NaN（候選座標壞掉）比較為 false，不會被當成通過
    if (distanceM <= opts.maxDistanceM) ok.push({ c, similarity, distanceM });
  }

  if (ok.length === 1) return { kind: 'match', candidate: ok[0]!.c, similarity: ok[0]!.similarity, distanceM: ok[0]!.distanceM };
  if (ok.length > 1) return { kind: 'ambiguous', candidates: ok.map((o) => o.c) };
  return { kind: 'none', reason: nameMatched ? 'name-match-too-far' : 'no-name-match' };
}
