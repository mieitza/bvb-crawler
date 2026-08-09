import { chromium } from 'playwright';
import pLimit from 'p-limit';
import { roNumber, roDate, parseDateOnly, cellValue } from './parse.js';
import { supabase } from './supabase.js';

const BVB = 'https://www.bvb.ro';
const SHARES_LIST = `${BVB}/FinancialInstruments/Markets/Shares`;
const DETAILS = (s) => `${BVB}/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(s)}`;

// Realistic browser UA to avoid WAF blocking.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EXTRA_HTTP_HEADERS = {
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 1);
const NAV_TIMEOUT = Number(process.env.CRAWL_TIMEOUT || 60000);
const HEADFUL = process.env.CRAWL_HEADFUL === '1';
const DELAY_BETWEEN_FETCHES = Number(process.env.CRAWL_DELAY || 3000);

let browser;

export async function launchBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  console.log(`[browser] launched (headless=${!HEADFUL})`);
  return browser;
}

export async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; }
}

// ── Discover symbols via BVB download endpoint (Excel) ──────────────────
// BVB provides a downloadable list at /FinancialInstruments/Markets/SharesListForDownload.ashx
// This may bypass the WAF that blocks the HTML page.
async function discoverSymbolsViaDownload() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ userAgent: UA, extraHTTPHeaders: EXTRA_HTTP_HEADERS });
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const downloadUrl = `${BVB}/FinancialInstruments/Markets/SharesListForDownload.ashx?filetype=excel`;
  console.log(`[discover] trying download: ${downloadUrl}`);
  try {
    const resp = await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' });
    const contentType = await resp?.headerValue('content-type') || '';
    console.log(`[discover] download response content-type: ${contentType}`);
    if (contentType.includes('excel') || contentType.includes('spreadsheet') || contentType.includes('octet-stream')) {
      const body = await resp?.body();
      if (body) {
        // The Excel file is HTML-based (old .xls format). Parse it as HTML.
        const html = body.toString('utf-8');
        return parseSymbolsFromExcelHtml(html);
      }
    }
    // If not Excel, the page might be the WAF block page.
    const text = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log(`[discover] download page text: ${text}`);
  } catch (e) {
    console.error(`[discover] download failed: ${e.message}`);
  } finally {
    await page.close();
  }
  return [];
}

// Parse the BVB Excel-HTML format to extract symbols.
function parseSymbolsFromExcelHtml(html) {
  // The old .xls format is HTML with <table> rows.
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const symbols = [];
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cm;
    while ((cm = cellRegex.exec(m[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]*>/g, '').trim());
    }
    if (cells.length >= 2) {
      const symbol = cells[0];
      if (symbol && /^[A-Z0-9]{1,10}$/.test(symbol) && symbol !== 'Symbol') {
        symbols.push({
          symbol,
          isin: cells.find((c) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(c)) || null,
          name: cells[1] || null,
          category: null,
        });
      }
    }
  }
  console.log(`[discover] parsed ${symbols.length} symbols from Excel download`);
  return symbols;
}

// ── Discover all listed symbols from the Shares market page ──────────────
export async function discoverSymbols() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 }, userAgent: UA, extraHTTPHeaders: EXTRA_HTTP_HEADERS });
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  console.log(`[discover] ${SHARES_LIST}`);
  let pageLoaded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(SHARES_LIST, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      pageLoaded = true;
      break;
    } catch (e) {
      console.log(`[discover] attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
  }
  if (!pageLoaded) {
    console.error('[discover] All attempts failed. Trying Excel download fallback.');
    await page.close();
    return discoverSymbolsViaDownload();
  }
  await page.waitForTimeout(5000);

  // Check if the page was blocked by WAF.
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Web Page Blocked') || bodyText.includes('Attack ID')) {
    console.error('[discover] BVB WAF blocked the request. Trying alternative approach.');
    await page.close();
    // Fallback: try the BVB download endpoint (Excel/CSV) which may not be blocked.
    return discoverSymbolsViaDownload();
  }

  // Try multiple selectors — BVB may use table, div grid, or load via AJAX.
  let rows = [];
  try {
    rows = await page.$$eval('table tbody tr, table tr', (trs) =>
      trs
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()))
        .filter((cells) => cells.length >= 2 && /RO|CY|AT|NL|[A-Z]{2}/.test(cells[0]))
    );
  } catch (e) {}
  console.log(`[discover] found ${rows.length} raw rows from table`);

  // If no table rows, try div-based layout (BVB may use a JS grid).
  if (!rows.length) {
    try {
      // Dump first 2000 chars of page text for debugging.
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log(`[discover] page text preview: ${bodyText.slice(0, 500)}`);
      // Try to find symbol-like patterns in links or data attributes.
      const links = await page.$$eval('a[href*="FinancialInstrumentsDetails"]', (as) =>
        as.map((a) => ({ href: a.href, text: a.textContent.trim() })).filter((a) => a.text)
      );
      console.log(`[discover] found ${links.length} detail-page links`);
      if (links.length) {
        for (const link of links) {
          const m = link.href.match(/s=([^&]+)/);
          const symbol = m ? m[1] : link.text.split(/\s+/)[0];
          if (symbol) rows.push([symbol, link.text]);
        }
      }
    } catch (e) {
      console.log(`[discover] fallback extraction failed: ${e.message}`);
    }
  }

  await page.close();

  // Each row: [ "SYMBOL+ISIN", "Company name", "Price", "Var%", "Date", "Category" ]
  // Symbol and ISIN are often concatenated without a separator (e.g. "CFHROM2TZIHW2M4").
  const symbols = [];
  for (const cells of rows) {
    const first = (cells[0] || '').trim();
    if (!first) continue;
    // Try to split on a space first; otherwise the ISIN is the trailing 12 chars.
    let symbol = null, isin = null;
    const parts = first.split(/\s+/).filter(Boolean);
    const isinMatch = parts.find((c) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(c));
    if (isinMatch && parts.length >= 2) {
      isin = isinMatch;
      symbol = parts.find((c) => c !== isin);
    } else {
      // Concatenated: ISIN is the last 12 chars.
      isin = first.length > 12 ? first.slice(-12) : null;
      if (isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) {
        symbol = first.slice(0, -12);
      } else {
        symbol = first;
        isin = null;
      }
    }
    if (!symbol) continue;
    symbols.push({
      symbol,
      isin,
      name: cells[1] || null,
      category: cells[cells.length - 1] || null,
    });
  }
  // Deduplicate by symbol.
  const seen = new Map();
  for (const s of symbols) if (!seen.has(s.symbol)) seen.set(s.symbol, s);
  const unique = [...seen.values()];
  console.log(`[discover] found ${unique.length} symbols`);
  return unique;
}

// ── Parse one company detail page ───────────────────────────────────────
export async function fetchCompany(symbol, seed = {}) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 }, userAgent: UA, extraHTTPHeaders: EXTRA_HTTP_HEADERS });
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const url = DETAILS(symbol);
  console.log(`[fetch] ${symbol} → ${url}`);
  let company;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body', { timeout: NAV_TIMEOUT });
    // Wait for the price block to render (ASP.NET partial).
    await page.waitForFunction(() => document.body.textContent.includes('Simbol:'), { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);
    company = await page.evaluate(parseInPage, { symbol, seed });
    company.raw_html = await page.content();
  } catch (err) {
    console.error(`[fetch] ${symbol} error: ${err.message}`);
    company = { symbol, ...seed, error: err.message };
  } finally {
    await page.close();
  }
  return company;
}

// This function runs in the browser context. `seed` is the discovery info.
function parseInPage({ symbol, seed }) {
  const txt = document.body.innerText;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ── Core identification block ──
  const pick = (label) => {
    const m = txt.match(new RegExp(label + '\\s*[:\\n]\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : null;
  };

  const isin = pick('ISIN') || seed.isin || null;
  const instrumentType = pick('Tip') || null;
  const segment = pick('Segment') || null;
  const category = pick('Categorie') || seed.category || null;
  const statusMatch = txt.match(/Stare\s*:\s*\n?\s*(Tranzactionabila|Suspendata|Delistata|N\/A)/i);
  const status = statusMatch ? statusMatch[1].trim() : null;

  // Company name: from the page title "BVB - Actiuni <SYMBOL> <NAME>" or header.
  const titleMatch = document.title.match(/-\s*Actiuni\s+\S+\s+(.+)$/i);
  const name = (titleMatch ? titleMatch[1] : seed.name || '').trim();

  // ── Prices block ──
  const price = parseRo(txt.match(/Pret referinta\s*([\d.,]+)/i)?.[1]);
  const lastPrice = parseRo(txt.match(/Ultimul pret\s*([\d.,]+)/i)?.[1]);
  const variation = parseRo(txt.match(/\n\s*Var\s*([\d.,-]+)/i)?.[1]);
  const variationPct = parseRo(txt.match(/Var\s*\(%\)\s*([\d.,-]+)/i)?.[1]);
  const openPrice = parseRo(txt.match(/Pret deschidere\s*([\d.,]+)/i)?.[1]);
  const maxPrice = parseRo(txt.match(/Pret maxim\s*([\d.,]+)/i)?.[1]);
  const minPrice = parseRo(txt.match(/Pret minim\s*([\d.,]+)/i)?.[1]);
  const avgPrice = parseRo(txt.match(/Pret mediu\s*([\d.,]+)/i)?.[1]);
  const high52 = parseRo(txt.match(/Max\.\s*52\s*saptamani\s*([\d.,]+)/i)?.[1]);
  const low52 = parseRo(txt.match(/Min\.\s*52\s*saptamani\s*([\d.,]+)/i)?.[1]);

  const bidAsk = txt.match(/Bid \/ Ask\s*([\d.,]+)\s*\/\s*([\d.,]+)/i);
  const bid = bidAsk ? parseRo(bidAsk[1]) : null;
  const ask = bidAsk ? parseRo(bidAsk[2]) : null;
  const bidAskVol = txt.match(/Bid \/ Ask Vol\.\s*([\d.]+)\s*\/\s*([\d.]+)/i);
  const bidVol = bidAskVol ? parseInt(bidAskVol[1].replace(/\./g, ''), 10) : null;
  const askVol = bidAskVol ? parseInt(bidAskVol[2].replace(/\./g, ''), 10) : null;

  const priceDt = roDate(txt.match(/Data\/ora\s*([\d.:\s]+)/i)?.[1]);

  // ── Market indicators ──
  const marketCap = parseRo(txt.match(/Capitalizare(?:\s*\([^)]+\))?\s*([\d.,]+)/i)?.[1]);
  const per = parseRo(txt.match(/PER\s*([\d.,-]+)/i)?.[1]);
  const pbv = parseRo(txt.match(/P\/BV\s*([\d.,-]+)/i)?.[1]);
  const eps = parseRo(txt.match(/EPS\s*([\d.,-]+)/i)?.[1]);
  const divY = parseRo(txt.match(/DIVY\s*([\d.,-]+)/i)?.[1]);
  const dividend = parseRo(txt.match(/Dividend\s*\((\d{4})\)\s*([\d.,-]+)/i)?.[2]);

  // ── Issue info ──
  const totalShares = parseInt((txt.match(/Numar total actiuni\s*([\d.]+)/i)?.[1] || '').replace(/\./g, ''), 10) || null;
  const nominalValue = parseRo(txt.match(/Valoare Nominala\s*([\d.,]+)/i)?.[1]);
  const shareCapital = parseRo(txt.match(/Capital social\s*([\d.,]+)/i)?.[1]);
  const tradingStart = parseDateOnly(txt.match(/Data start tranzactionare\s*([\d.]+)/i)?.[1]);
  const vektor = parseRo(txt.match(/Indicatorul VEKTOR[\s\S]*?VEKTOR\s*\n\s*([\d.,]+)/i)?.[1]);

  // ── Shareholders ──
  const shareholders = [];
  const shTable = $$('table').find((t) => /Actionar\s*Actiuni\s*Procent/i.test(t.textContent));
  if (shTable) {
    const rows = Array.from(shTable.querySelectorAll('tbody tr, tr')).slice(1);
    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
      if (cells.length >= 3) {
        shareholders.push({
          name: cells[0],
          shares: parseInt(cells[1].replace(/\./g, ''), 10) || null,
          percent: parseRo(cells[2]),
        });
      }
    }
  }

  return {
    symbol,
    isin,
    name,
    instrument_type: instrumentType,
    segment,
    category,
    status,
    description: null,
    total_shares: totalShares,
    nominal_value: nominalValue,
    share_capital: shareCapital,
    trading_start: tradingStart,
    vektor,
    shareholders,
    details_url: location.href,
    // snapshot
    snapshot: {
      price: lastPrice ?? price,
      variation,
      variation_pct: variationPct,
      reference_price: price,
      open_price: openPrice,
      max_price: maxPrice,
      min_price: minPrice,
      avg_price: avgPrice,
      bid,
      ask,
      bid_volume: bidVol,
      ask_volume: askVol,
      high_52w: high52,
      low_52w: low52,
      market_cap: marketCap,
      per,
      pbv,
      eps,
      div_yield: divY,
      dividend,
      price_datetime: priceDt,
    },
  };

  // ── helpers available in page context ──
  function parseRo(v) {
    if (v == null) return null;
    const s = String(v).trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    if (s.includes('.') && s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    if (s.includes(',')) return parseFloat(s.replace(',', '.'));
    return parseFloat(s);
  }
  function roDate(raw) {
    if (!raw) return null;
    const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  function parseDateOnly(raw) {
    const iso = roDate(raw);
    return iso ? iso.slice(0, 10) : null;
  }
}

// ── Persist a parsed company to Supabase ───────────────────────────────
export async function persistCompany(company) {
  if (!company || company.error) {
    console.warn(`[persist] skipping ${company?.symbol} (error)`);
    return null;
  }
  const { symbol, snapshot, shareholders, raw_html, ...companyFields } = company;

  // Upsert company.
  const { error: coErr } = await supabase
    .from('companies')
    .upsert(
      {
        ...companyFields,
        symbol,
        shareholders: shareholders || [],
        raw_html: process.env.STORE_RAW_HTML === '1' ? raw_html : undefined,
        crawled_at: new Date().toISOString(),
      },
      { onConflict: 'symbol' }
    )
    .select();
  if (coErr) console.error(`[persist] ${symbol} company upsert failed:`, coErr.message);

  // Insert price snapshot (always append for historical series).
  if (snapshot) {
    const { error: snapErr } = await supabase.from('price_snapshots').insert({
      symbol,
      ...snapshot,
      captured_at: new Date().toISOString(),
    });
    if (snapErr) console.error(`[persist] ${symbol} snapshot insert failed:`, snapErr.message);
  }
  return symbol;
}

// ── Orchestrate a full crawl run ───────────────────────────────────────
export async function runCrawl(symbolFilter) {
  const startedAt = Date.now();
  console.log(`[crawl] starting at ${new Date().toISOString()}`);

  let symbols;
  try {
    symbols = await discoverSymbols();
  } catch (err) {
    console.error(`[crawl] discoverSymbols failed: ${err.message}`);
    console.error(err.stack);
    await closeBrowser();
    return { total: 0, ok: 0, failed: 0, error: err.message };
  }
  if (!symbols.length) {
    console.error('[crawl] discoverSymbols returned 0 symbols — aborting');
    await closeBrowser();
    return { total: 0, ok: 0, failed: 0 };
  }
  const targets = symbolFilter
    ? symbols.filter((s) => s.symbol === symbolFilter)
    : symbols;

  if (!targets.length) {
    console.warn(`[crawl] no targets matching filter "${symbolFilter}"`);
    await closeBrowser();
    return { total: 0, ok: 0, failed: 0 };
  }

  const limiter = pLimit(CONCURRENCY);
  let ok = 0, failed = 0;
  let fetchIndex = 0;
  const tasks = targets.map((seed) =>
    limiter(async () => {
      // Stagger requests to avoid BVB rate-limiting / WAF blocks.
      const wait = (fetchIndex++) * DELAY_BETWEEN_FETCHES;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const company = await fetchCompany(seed.symbol, seed);
        await persistCompany(company);
        if (company.error) failed++; else ok++;
        console.log(`[crawl] ${seed.symbol} ${company.error ? 'FAILED' : 'OK'} (${ok + failed}/${targets.length})`);
      } catch (err) {
        failed++;
        console.error(`[crawl] ${seed.symbol} uncaught: ${err.message}`);
      }
    })
  );
  await Promise.all(tasks);

  await closeBrowser();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[crawl] done in ${elapsed}s — ok=${ok} failed=${failed} total=${targets.length}`);
  return { total: targets.length, ok, failed };
}