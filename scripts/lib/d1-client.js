'use strict';
/**
 * Cloudflare D1 REST API helper for Node.js scripts.
 *
 * v2.33.29: 統一 5 個 script 各自 inline 的 queryD1/execD1 — 之前
 * 因 result shape 處理不同（`results` vs `meta.changes`）容易在 SELECT vs
 * DELETE 路徑誤用。
 *
 * Env required (caller 應先 `loadEnvLocal()`):
 *   CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID
 */
function getConfig() {
  const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
  const D1_DB = process.env.D1_DATABASE_ID;
  if (!CF_TOKEN || !CF_ACCOUNT || !D1_DB) {
    throw new Error(
      'Missing CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DATABASE_ID env',
    );
  }
  return { CF_TOKEN, CF_ACCOUNT, D1_DB };
}

async function rawQuery(sql, params = []) {
  const { CF_TOKEN, CF_ACCOUNT, D1_DB } = getConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_DB}/query`;
  // v2.33.50 round 8b: 1 retry on transient 5xx — D1 偶發 capacity / control-plane
  // hiccup，daily cron 不該因一次 503 整輪 fail。500ms backoff 避免 thundering。
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    if (res.status < 500 || attempt > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const json = await res.json();
  if (!json.success) {
    // v2.33.50 round 8b: only stringify errors (json fallback 含 request body，
    // 可能 leak SQL params to log)。
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors || 'unknown')}`);
  }
  return (json.result && json.result[0]) || {};
}

/** SELECT — returns rows array. */
async function queryD1(sql, params = []) {
  const result = await rawQuery(sql, params);
  return result.results || [];
}

/** INSERT / UPDATE / DELETE — returns changes count. */
async function execD1(sql, params = []) {
  const result = await rawQuery(sql, params);
  return (result.meta && result.meta.changes) || 0;
}

module.exports = { queryD1, execD1, rawQuery };
