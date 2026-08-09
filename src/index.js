import { createServer } from 'http';
import { runCrawl, closeBrowser } from './crawler.js';
import { supabase } from './supabase.js';

const PORT = process.env.PORT || 8080;
const RUN_ON_START = process.env.RUN_ON_START !== '0';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && url.pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', crawling, lastResult, time: new Date().toISOString() }));
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