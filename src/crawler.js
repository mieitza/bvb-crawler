// Crawler that uses the bvb-api.vercel.app JSON API instead of scraping bvb.ro.
// This is faster, more reliable, and avoids BVB's WAF blocking.
import { supabase } from './supabase.js';

const BVB_API = 'https://bvb-api.vercel.app/api/v1';
const PAGE_SIZE = 100;
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 5);
const DELAY = Number(process.env.CRAWL_DELAY || 500);
const MAX_COMPANIES = Number(process.env.CRAWL_MAX || 0); // 0 = all

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ── Discover all listed companies via the API ───────────────────────────
export async function discoverSymbols() {
  console.log(`[discover] fetching company list from ${BVB_API}/companies`);
  const all = [];
  let offset = 0;
  while (true) {
    const url = `${BVB_API}/companies?offset=${offset}&limit=${PAGE_SIZE}`;
    const data = await fetchJson(url);
    const items = data.items || [];
    all.push(...items);
    console.log(`[discover] offset=${offset} got=${items.length} total_so_far=${all.length}`);
    if (!items.length || items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(DELAY);
  }
  const result = MAX_COMPANIES > 0 ? all.slice(0, MAX_COMPANIES) : all;
  console.log(`[discover] found ${result.length} companies`);
  return result;
}

// Convert "DD.MM.YYYY" → "YYYY-MM-DD" for Postgres date columns.
function toIsoDate(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// ── Fetch a single company's full details + persist to Supabase ────────
export async function fetchAndPersist(seed) {
  const symbol = seed.symbol;
  console.log(`[fetch] ${symbol}`);
  try {
    const data = await fetchJson(`${BVB_API}/companies/${encodeURIComponent(symbol)}`);
    await sleep(DELAY);

    // Map API fields to our schema.
    const m = data.latest_metrics || {};
    const p = data.latest_price || {};
    const shareholders = (data.shareholders || []).map((s) => ({
      name: s.holder,
      shares: s.shares ?? null,
      percent: s.pct ?? null,
    }));

    // Upsert company.
    let companyOk = true;
    const { error: coErr } = await supabase.from('companies').upsert({
      symbol: data.symbol,
      isin: data.isin || seed.isin || null,
      name: data.name || seed.name || null,
      instrument_type: data.instrument_type || null,
      segment: data.segment || null,
      category: data.category || null,
      status: data.status || null,
      description: null,
      total_shares: data.total_shares ?? null,
      nominal_value: data.nominal_value ?? null,
      share_capital: data.share_capital ?? null,
      trading_start: toIsoDate(data.trade_start_date),
      vektor: null,
      shareholders,
      details_url: `https://www.bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(data.symbol)}`,
      crawled_at: new Date().toISOString(),
    }, { onConflict: 'symbol' });
    if (coErr) { console.error(`[persist] ${symbol} company upsert failed:`, coErr.message); companyOk = false; }

    // Insert price snapshot (only if company upsert succeeded, to satisfy FK).
    if (companyOk) {
      const { error: snapErr } = await supabase.from('price_snapshots').insert({
        symbol: data.symbol,
        price: p.price ?? m.reference_price ?? null,
        variation_pct: p.var_pct ?? null,
        reference_price: m.reference_price ?? null,
        open_price: p.open ?? null,
        max_price: p.max ?? null,
        min_price: p.min ?? null,
        avg_price: p.avg ?? null,
        volume: p.volume ?? null,
        value_ron: p.value_ron ?? null,
        trades: p.trades ?? null,
        market_cap: m.market_cap ?? null,
        per: m.pe_ratio ?? null,
        pbv: m.pbv ?? null,
        eps: m.eps ?? null,
        div_yield: m.div_yield ?? null,
        dividend: m.dividend ?? null,
        price_datetime: p.date ? `${toIsoDate(p.date)}T00:00:00Z` : (m.as_of ? `${toIsoDate(m.as_of)}T00:00:00Z` : null),
        captured_at: new Date().toISOString(),
      });
      if (snapErr) console.error(`[persist] ${symbol} snapshot insert failed:`, snapErr.message);
    }

    return { symbol, ok: companyOk };
  } catch (err) {
    console.error(`[fetch] ${symbol} error: ${err.message}`);
    return { symbol, ok: false, error: err.message };
  }
}

// ── Orchestrate a full crawl run ───────────────────────────────────────
export async function runCrawl(symbolFilter) {
  const startedAt = Date.now();
  console.log(`[crawl] starting at ${new Date().toISOString()}`);

  let seeds;
  try {
    seeds = await discoverSymbols();
  } catch (err) {
    console.error(`[crawl] discoverSymbols failed: ${err.message}`);
    return { total: 0, ok: 0, failed: 0, error: err.message };
  }

  const targets = symbolFilter
    ? seeds.filter((s) => s.symbol === symbolFilter)
    : seeds;

  if (!targets.length) {
    console.warn(`[crawl] no targets matching filter "${symbolFilter}"`);
    return { total: 0, ok: 0, failed: 0 };
  }

  // Sequential with delay to be gentle on the API.
  let ok = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const result = await fetchAndPersist(targets[i]);
    if (result.ok) ok++; else failed++;
    console.log(`[crawl] ${result.symbol} ${result.ok ? 'OK' : 'FAILED'} (${ok + failed}/${targets.length})`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[crawl] done in ${elapsed}s — ok=${ok} failed=${failed} total=${targets.length}`);
  return { total: targets.length, ok, failed };
}

// No browser needed — pure HTTP API.
export async function launchBrowser() {}
export async function closeBrowser() {}