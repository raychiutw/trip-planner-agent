/**
 * #1605 place_id 回填的比對規則（純函式）。
 * 規則：名稱相似度 >= minSimilarity 且 座標距離 <= maxDistanceM 才算「合格候選」；
 * 合格候選恰好 1 個才選，0 個或 2 個以上一律不選。
 */
import { describe, it, expect } from 'vitest';
import { decide, haversineM, nameSimilarity, DEFAULT_MATCH_OPTS, type Candidate } from '../../scripts/lib/place-id-match';

const poi = { name: '東京鐵塔', lat: 35.6586, lng: 139.7454 };
const cand = (over: Partial<Candidate>): Candidate => ({
  place_id: 'ChIJ_a', name: '東京鐵塔', lat: 35.6586, lng: 139.7454, ...over,
});
// 緯度 +0.001 約 111 m；+0.01 約 1.1 km
const NEAR = { lat: 35.6586 + 0.001 };
const FAR = { lat: 35.6586 + 0.01 };

describe('haversineM', () => {
  it('同點 0；緯度差 0.001 度約 111 m', () => {
    expect(haversineM(1, 1, 1, 1)).toBe(0);
    expect(haversineM(35, 139, 35.001, 139)).toBeGreaterThan(105);
    expect(haversineM(35, 139, 35.001, 139)).toBeLessThan(117);
  });
});

describe('nameSimilarity', () => {
  it('忽略大小寫、空白、標點、全半形', () => {
    expect(nameSimilarity('Tokyo Tower', 'tokyo-tower')).toBe(1);
    expect(nameSimilarity('ＡＢＣ　咖啡', 'abc咖啡')).toBe(1);
  });
  it('完全不同為 0；空字串為 0', () => {
    expect(nameSimilarity('東京鐵塔', '淺草寺')).toBe(0);
    expect(nameSimilarity('', '東京鐵塔')).toBe(0);
  });
});

describe('decide', () => {
  it('同名近距離 → match', () => {
    const r = decide(poi, [cand({ ...NEAR })], DEFAULT_MATCH_OPTS);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.candidate.place_id).toBe('ChIJ_a');
  });
  it('同名遠距離 → none（name-match-too-far）', () => {
    expect(decide(poi, [cand({ ...FAR })], DEFAULT_MATCH_OPTS)).toMatchObject({ kind: 'none', reason: 'name-match-too-far' });
  });
  it('不同名（即使同座標）→ none（no-name-match）', () => {
    expect(decide(poi, [cand({ name: '淺草寺' })], DEFAULT_MATCH_OPTS)).toMatchObject({ kind: 'none', reason: 'no-name-match' });
  });
  it('無候選 → none（no-results）', () => {
    expect(decide(poi, [], DEFAULT_MATCH_OPTS)).toMatchObject({ kind: 'none', reason: 'no-results' });
  });
  it('兩個不同 place_id 都合格 → ambiguous，不選', () => {
    const r = decide(poi, [cand({ place_id: 'A' }), cand({ place_id: 'B', ...NEAR })], DEFAULT_MATCH_OPTS);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.place_id)).toEqual(['A', 'B']);
  });
  it('同一 place_id 重複出現不算歧義', () => {
    expect(decide(poi, [cand({ place_id: 'A' }), cand({ place_id: 'A' })], DEFAULT_MATCH_OPTS).kind).toBe('match');
  });
  it('一個合格 + 一個不合格 → 選合格者', () => {
    const r = decide(poi, [cand({ place_id: 'X', name: '淺草寺' }), cand({ place_id: 'OK', ...NEAR })], DEFAULT_MATCH_OPTS);
    expect(r).toMatchObject({ kind: 'match', candidate: { place_id: 'OK' } });
  });
  it('門檻是參數：放寬距離後遠距離可過；放寬相似度後近似名可過', () => {
    expect(decide(poi, [cand({ ...FAR })], { minSimilarity: 0.9, maxDistanceM: 2000 }).kind).toBe('match');
    expect(decide(poi, [cand({ name: '東京鐵塔展望台' })], DEFAULT_MATCH_OPTS).kind).toBe('none');
    expect(decide(poi, [cand({ name: '東京鐵塔展望台' })], { minSimilarity: 0.5, maxDistanceM: 150 }).kind).toBe('match');
  });
  it('座標非有限數 → none（bad-coords），不拿 NaN 當通過', () => {
    expect(decide({ ...poi, lat: NaN }, [cand({})], DEFAULT_MATCH_OPTS)).toMatchObject({ kind: 'none', reason: 'bad-coords' });
  });
});
