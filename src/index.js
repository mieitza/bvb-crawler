import { createServer } from 'http';
import { runCrawl, closeBrowser } from './crawler.js';
import { supabase } from './supabase.js';

const PORT = process.env.PORT || 8080;
const RUN_ON_START = process.env.RUN_ON_START !== '0';
// Cron schedule in "HH:MM" (UTC). Default 18:00 UTC = 21:00 EET (after BVB close).
const CRAWL_TIME = process.env.CRAWL_TIME || '18:00';

let crawling = false;
let lastResult = null;

async function handleCrawl(symbol) {
  if (crawling) return { status: 409, body: { error: 'A crawl is already running' } };
  crawling = true;
  try {
    lastResult = await runCrawl(symbol);
    return { status: 200, body: { ok: true, result: lastResult } };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  } finally {
    crawling = false;
  }
}

// ── Daily scheduler ─────────────────────────────────────────────────────
function scheduleDaily() {
  const [hh, mm] = CRAWL_TIME.split(':').map(Number);
  function nextRun() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  function arm() {
    const delay = nextRun().getTime() - Date.now();
    console.log(`[scheduler] next crawl at ${CRAWL_TIME} UTC (in ${(delay / 1000 / 60).toFixed(0)} min)`);
    setTimeout(async () => {
      console.log(`[scheduler] starting scheduled crawl at ${new Date().toISOString()}`);
      await handleCrawl(null);
      console.log(`[scheduler] scheduled crawl done:`, lastResult);
      arm(); // re-arm for the next day
    }, delay);
  }
  arm();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', crawling, lastResult, crawlTime: CRAWL_TIME, time: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/crawl') {
    const symbol = url.searchParams.get('s') || null;
    const { status, body } = await handleCrawl(symbol);
    res.statusCode = status;
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/companies') {
    const { data, error } = await supabase
      .from('companies')
      .select('symbol, isin, name, segment, category, status, crawled_at')
      .order('symbol', { ascending: true })
      .limit(500);
    if (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); return; }
    res.end(JSON.stringify({ count: data.length, companies: data }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, async () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[scheduler] daily crawl scheduled for ${CRAWL_TIME} UTC`);
  scheduleDaily();
  if (RUN_ON_START) {
    console.log('[server] RUN_ON_START=1 → starting backfill crawl');
    await handleCrawl(null);
    console.log('[server] backfill complete');
  }
});

process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received, shutting down');
  await closeBrowser();
  server.close(() => process.exit(0));
});