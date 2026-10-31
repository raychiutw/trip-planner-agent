#!/usr/bin/env node
/**
 * tp-check CLI — 讀 dist JSON 驗證品質規則 R0-R15，輸出紅綠燈報告。
 *
 * Usage:
 *   node scripts/tp-check.js                  # 全部行程
 *   node scripts/tp-check.js okinawa-trip-2026-Ray  # 指定行程
 *   node scripts/tp-check.js --compact        # 精簡模式
 */
const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'data', 'dist');
const compact = process.argv.includes('--compact');
const argSlugs = process.argv.slice(2).filter(a => !a.startsWith('-'));

// ── helpers (與 quality.test.js 同步) ──────────────────────────

function loadTrip(slug) {
  const dir = path.join(DIST, slug);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  // 2026-05-02 (migration 0045 + tp-check sync): trips.footer / auto_scroll /
  // food_prefs / self_drive 已 DROP — tp-check 不再讀這些欄位。新 dist
  // 不含 footer / autoScrollDates。R10 改用 meta.defaultTravelMode === 'driving'
  // 取代 meta.selfDrive（同 trips.default_travel_mode 語意）。R1 改寫見
  // tp-quality-rules（不再要求 meta.foodPreferences）。
  const result = { meta: meta.meta };
  const fp = path.join(dir, 'flights.json');
  if (fs.existsSync(fp)) result.flights = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const dayFiles = fs.readdirSync(dir)
    .filter(f => /^day-\d+\.json$/.test(f))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  result.days = dayFiles.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return result;
}

function parseFlightTimes(flights) {
  if (!flights?.content?.segments?.length) return null;
  const segs = flights.content.segments;
  function ext(seg, which) {
    if (which === 'arrive' && seg.arrive) return seg.arrive;
    if (which === 'depart' && seg.depart) return seg.depart;
    if (!seg.time) return null;
    const exact = seg.time.match(/(\d{1,2}:\d{2})\s*[→→]\s*(\d{1,2}:\d{2})/);
    if (exact) return which === 'depart' ? exact[1] : exact[2];
    const all = [...seg.time.matchAll(/(\d{1,2}:\d{2})/g)].map(m => m[1]);
    if (all.length >= 2) return which === 'depart' ? all[0] : all[all.length - 1];
    return all[0] || null;
  }
  return { arrivalTime: ext(segs[0], 'arrive'), departureTime: ext(segs[segs.length - 1], 'depart') };
}

function toHour(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] + +m[2] / 60 : null;
}

function hasMealEvent(timeline, keyword) {
  return timeline.some(ev => {
    if ((ev.title || '').includes(keyword)) return true;
    if ((ev.description || '').includes(keyword)) return true;
    if (ev.infoBoxes) {
      return ev.infoBoxes.some(b => b.type === 'restaurants' && (b.title || '').includes(keyword));
    }
    return false;
  });
}

// ── rule checkers ──────────────────────────────────────────────

function check(data, slug) {
  const R = {};
  const pass = r => { R[r] = { s: 'g', d: [] }; };
  const warn = (r, m) => { if (!R[r]) R[r] = { s: 'g', d: [] }; if (R[r].s === 'g') R[r].s = 'y'; R[r].d.push(m); };
  const fail = (r, m) => { if (!R[r]) R[r] = { s: 'g', d: [] }; R[r].s = 'r'; R[r].d.push(m); };

  const days = data.days;
  const meta = data.meta || {};

  // R0 label length
  pass('R0');
  days.forEach(d => { if (d.label && d.label.length > 8) warn('R0', `Day ${d.id} "${d.label}" > 8 chars`); });

  // R1 料理偏好（2026-05-02 改寫 — migration 0045 後 trips.food_prefs 已 DROP）：
  // 不再固定 3 偏好對應 3 餐廳，改由 LLM 從 timeline 上下文 + category 多樣性 +
  // chat 偏好 + 目的地代表料理推薦。R1 在 tp-check 端作廢檢查（運行時無從驗證
  // LLM 是否照新規則推薦），仍 pass 標記以保留欄位順序。
  pass('R1');

  // R2 meals (flight-aware, hotel "家" exemption)
  pass('R2');
  const ft = parseFlightTimes(data.flights);
  const total = days.length;
  days.forEach((day, i) => {
    const tl = day.content?.timeline || [];
    const isFirst = i === 0;
    const isLast = i === total - 1;
    const isHomeStay = day.content?.hotel?.name === '家';
    const hasGroupTour = tl.some(e => /KKday|Klook|一日遊/.test(e.title || ''));

    let needL = true, needD = true;
    if (ft) {
      if (isFirst) { const h = toHour(ft.arrivalTime); if (h !== null) { needL = h < 11.5; needD = h < 17; } }
      if (isLast) { const h = toHour(ft.departureTime); if (h !== null) { needL = h >= 11.5; needD = h >= 17; } }
    }
    if (hasGroupTour) needL = false;
    if (isHomeStay) { needL = false; needD = false; }

    const hasL = hasMealEvent(tl, '午餐') || hasMealEvent(tl, 'lunch');
    const hasD = hasMealEvent(tl, '晚餐') || hasMealEvent(tl, 'dinner') || hasMealEvent(tl, '宵夜');
    if (needL && !hasL) warn('R2', `Day ${day.id} missing lunch`);
    if (needD && !hasD) warn('R2', `Day ${day.id} missing dinner`);
  });

  // R3 restaurants 1-3, hours, reservation, duplicate brands
  pass('R3');
  const brandMap = new Map(); // normalized brand → first full name
  days.forEach(day => {
    const tl = day.content?.timeline || [];
    tl.forEach(ev => {
      (ev.infoBoxes || []).forEach(box => {
        if (box.type !== 'restaurants' || !box.restaurants) return;
        if (box.restaurants.length > 3) warn('R3', `Day ${day.id} "${ev.title}" > 3 restaurants`);
        if (box.restaurants.length < 1) warn('R3', `Day ${day.id} "${ev.title}" 0 restaurants`);
        box.restaurants.forEach(r => {
          if (!r.hours) warn('R3', `Day ${day.id} "${r.name}" missing hours`);
          if (r.reservation === undefined || r.reservation === '') warn('R3', `Day ${day.id} "${r.name}" missing reservation`);
          // duplicate brand: strip branch suffix
          const norm = (r.name || '').replace(/\s*(本店|.+[店舖鋪]|.+점)$/u, '').trim();
          if (norm && brandMap.has(norm) && brandMap.get(norm) !== r.name) {
            // user-source gets priority
            if (r.source !== 'user' && !brandMap.get(norm + '_src')) {
              warn('R3', `Dup brand: "${r.name}" vs "${brandMap.get(norm)}"`);
            }
          }
          brandMap.set(norm, r.name);
          if (r.source === 'user') brandMap.set(norm + '_src', true);
        });
      });
    });
  });

  // R7 hotel shopping
  pass('R7');
  days.forEach(day => {
    const h = day.content?.hotel;
    if (!h || h.name === '家' || h.name.startsWith('（')) return;
    const boxes = h.infoBoxes || [];
    const sb = boxes.find(b => b.type === 'shopping');
    if (!sb) { warn('R7', `Day ${day.id} hotel "${h.name}" no shopping`); return; }
    if (!sb.shops || sb.shops.length < 3) warn('R7', `Day ${day.id} hotel "${h.name}" < 3 shops`);
    (sb.shops || []).forEach(s => {
      if (!Array.isArray(s.mustBuy) || s.mustBuy.length < 3) warn('R7', `Day ${day.id} shop "${s.name}" mustBuy < 3`);
    });
  });

  // R8 breakfast
  pass('R8');
  days.forEach(day => {
    const h = day.content?.hotel;
    if (!h) return;
    if (!h.breakfast) warn('R8', `Day ${day.id} hotel missing breakfast`);
    else if (![true, false, null].includes(h.breakfast.included)) warn('R8', `Day ${day.id} breakfast.included invalid`);
  });

  // R10 gasStation (only when 還車 event exists, 自駕 trip only)
  // 2026-05-02 (migration 0045): meta.selfDrive 已 DROP → 改讀 meta.defaultTravelMode
  // === 'driving'（同 trips.default_travel_mode 語意，由 dist export pipeline
  // 從 trips row 帶到 meta JSON）。
  pass('R10');
  if (meta.defaultTravelMode === 'driving') {
    days.forEach(day => {
      (day.content?.timeline || []).forEach(ev => {
        if (!(ev.title || '').includes('還車')) return;
        const has = (ev.infoBoxes || []).some(b => b.type === 'gasStation');
        if (!has) fail('R10', `Day ${day.id} "${ev.title}" missing gasStation`);
      });
    });
  }

  // R11 locations
  pass('R11');
  let ml = 0;
  days.forEach(day => {
    (day.content?.timeline || []).forEach(ev => {
      if (ev.travel) return;
      if ((ev.title || '').includes('餐廳未定')) return;
      if (!Array.isArray(ev.locations) || ev.locations.length === 0) ml++;
    });
  });
  if (ml > 0) warn('R11', `${ml} events missing locations`);

  // R12 googleRating
  pass('R12');
  let rAi = 0, rUser = 0;
  const ckR = o => {
    if (typeof o.googleRating !== 'number' || o.googleRating < 1 || o.googleRating > 5) {
      if (o.source === 'user') rUser++; else rAi++;
    }
  };
  days.forEach(day => {
    (day.content?.timeline || []).forEach(ev => {
      if (ev.travel) return;
      if ((ev.title || '').includes('餐廳未定')) return;
      ckR(ev);
      (ev.infoBoxes || []).forEach(box => {
        if (box.type === 'restaurants') (box.restaurants || []).forEach(ckR);
        if (box.type === 'shopping') (box.shops || []).forEach(ckR);
        if (box.type === 'gasStation') ckR(box);
      });
    });
    const h = day.content?.hotel;
    if (h?.infoBoxes) h.infoBoxes.forEach(box => {
      if (box.type === 'restaurants') (box.restaurants || []).forEach(ckR);
      if (box.type === 'shopping') (box.shops || []).forEach(ckR);
    });
  });
  if (rAi > 0) fail('R12', `${rAi} ai POIs missing googleRating`);
  if (rUser > 0) warn('R12', `${rUser} user POIs missing googleRating`);

  // R13 source existence
  pass('R13');
  let ms = 0;
  days.forEach(day => {
    (day.content?.timeline || []).forEach(ev => {
      if (ev.travel) return;
      if ((ev.title || '').includes('餐廳未定')) return;
      if (!ev.source) ms++;
      (ev.infoBoxes || []).forEach(box => {
        if (box.type === 'restaurants') (box.restaurants || []).forEach(r => { if (!r.source) ms++; });
        if (box.type === 'shopping') (box.shops || []).forEach(s => { if (!s.source) ms++; });
      });
    });
    const h = day.content?.hotel;
    if (h && h.name !== '家' && !h.name.startsWith('（') && !h.source) ms++;
    if (h?.infoBoxes) h.infoBoxes.forEach(box => {
      if (box.type === 'shopping') (box.shops || []).forEach(s => { if (!s.source) ms++; });
    });
  });
  if (ms > 0) fail('R13', `${ms} POIs missing source`);

  // R14 naverQuery for KR
  pass('R14');
  if (meta.countries?.includes('KR')) {
    let mn = 0;
    days.forEach(day => {
      (day.content?.timeline || []).forEach(ev => {
        if (ev.travel) return;
        if (Array.isArray(ev.locations)) {
          ev.locations.forEach(loc => { if (!loc.naverQuery) mn++; });
        }
      });
    });
    if (mn > 0) warn('R14', `${mn} locations missing naverQuery`);
  }

  // R15 note
  pass('R15');
  let mnote = 0;
  days.forEach(day => {
    (day.content?.timeline || []).forEach(ev => {
      if (ev.travel) return;
      if (typeof ev.note !== 'string') mnote++;
      (ev.infoBoxes || []).forEach(box => {
        if (box.type === 'restaurants') (box.restaurants || []).forEach(r => { if (typeof r.note !== 'string') mnote++; });
        if (box.type === 'shopping') (box.shops || []).forEach(s => { if (typeof s.note !== 'string') mnote++; });
      });
    });
    const h = day.content?.hotel;
    if (h) {
      if (typeof h.note !== 'string') mnote++;
      (h.infoBoxes || []).forEach(box => {
        if (box.type === 'shopping') (box.shops || []).forEach(s => { if (typeof s.note !== 'string') mnote++; });
      });
    }
  });
  if (mnote > 0) warn('R15', `${mnote} POIs missing note`);

  return R;
}

// ── output ─────────────────────────────────────────────────────

const RULES = ['R0','R1','R2','R3','R7','R8','R10','R11','R12','R13','R14','R15'];
const NAMES = { R0:'結構', R1:'偏好', R2:'餐次', R3:'餐廳品質', R7:'購物', R8:'早餐',
  R10:'加油站', R11:'地圖導航', R12:'評分', R13:'來源標記', R14:'國家感知', R15:'note' };
const ICON = { g: '\u{1F7E2}', y: '\u{1F7E1}', r: '\u{1F534}' };

const registry = JSON.parse(fs.readFileSync(path.join(DIST, 'trips.json'), 'utf8'));
const slugs = argSlugs.length
  ? argSlugs
  : registry.map(t => t.tripId);

let totalG = 0, totalY = 0, totalR = 0;
const reports = [];

for (const slug of slugs) {
  const dir = path.join(DIST, slug);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) { console.error(`skip: ${slug} (no meta.json)`); continue; }
  const data = loadTrip(slug);
  const R = check(data, slug);

  let g = 0, y = 0, r = 0;
  RULES.forEach(rule => { const s = (R[rule] || { s: 'g' }).s; if (s === 'g') g++; else if (s === 'y') y++; else r++; });
  totalG += g; totalY += y; totalR += r;

  if (compact) {
    reports.push(`${slug}: ${ICON.g} ${g}  ${ICON.y} ${y}  ${ICON.r} ${r}`);
  } else {
    const lines = [];
    lines.push('');
    lines.push('\u2550'.repeat(50));
    lines.push(`  tp-check: ${slug}`);
    lines.push(`  ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`);
    lines.push('\u2550'.repeat(50));
    lines.push(`  Summary:  ${ICON.g} ${g}  ${ICON.y} ${y}  ${ICON.r} ${r}`);
    lines.push('');
    lines.push('\u2500'.repeat(50));
    lines.push('  Rule          Status   Detail');
    lines.push('\u2500'.repeat(50));
    RULES.forEach(rule => {
      const res = R[rule] || { s: 'g', d: [] };
      const icon = ICON[res.s];
      const detail = res.d.length > 0 ? '     ' + res.d[0] : '';
      lines.push(`  ${rule.padEnd(5)} ${(NAMES[rule] || '').padEnd(8)} ${icon}${detail}`);
      res.d.slice(1).forEach(d => lines.push(`                       ${d}`));
    });
    lines.push('\u2500'.repeat(50));

    const warnings = [];
    const failures = [];
    RULES.forEach(rule => {
      const res = R[rule] || { s: 'g', d: [] };
      if (res.s === 'y') res.d.forEach(d => warnings.push(`${rule}: ${d}`));
      if (res.s === 'r') res.d.forEach(d => failures.push(`${rule}: ${d}`));
    });
    if (warnings.length) {
      lines.push('');
      lines.push(`  ${ICON.y} Warnings (${warnings.length}):`);
      warnings.forEach((w, i) => lines.push(`  ${i === warnings.length - 1 ? '\u2514' : '\u251C'}\u2500\u2500 ${w}`));
    }
    if (failures.length) {
      lines.push('');
      lines.push(`  ${ICON.r} Failures (${failures.length}):`);
      failures.forEach((f, i) => lines.push(`  ${i === failures.length - 1 ? '\u2514' : '\u251C'}\u2500\u2500 ${f}`));
    }
    lines.push('\u2550'.repeat(50));
    reports.push(lines.join('\n'));
  }
}

if (compact) {
  console.log(`tp-check: ${ICON.g} ${totalG}  ${ICON.y} ${totalY}  ${ICON.r} ${totalR}`);
  reports.forEach(r => console.log('  ' + r));
} else {
  reports.forEach(r => console.log(r));
  if (slugs.length > 1) {
    console.log('');
    console.log('\u2550'.repeat(50));
    console.log(`  TOTAL: ${ICON.g} ${totalG}/${totalG + totalY + totalR}  ${ICON.y} ${totalY}  ${ICON.r} ${totalR}`);
    console.log('\u2550'.repeat(50));
  }
}

process.exit(totalR > 0 ? 1 : 0);
