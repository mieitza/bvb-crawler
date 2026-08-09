# bvb-crawler

Crawls [bvb.ro](https://www.bvb.ro) for **all companies listed on the Bucharest Stock Exchange** and stores them in Supabase. Dockerized, ready to deploy on Coolify.

## What it collects

For every listed instrument (discovered from the [Shares market page](https://www.bvb.ro/FinancialInstruments/Markets/Shares)):

**Companies table**
- `symbol`, `isin`, `name`
- `instrument_type`, `segment`, `category`, `status`
- `total_shares`, `nominal_value`, `share_capital`, `trading_start`
- `vektor`
- `shareholders` (JSON array: name, shares, percent)
- `details_url`, `crawled_at`

**Price snapshots table** (one row per crawl run — builds a historical series)
- `price`, `variation`, `variation_pct`, `reference_price`
- `open_price`, `max_price`, `min_price`, `avg_price`
- `bid`, `ask`, `bid_volume`, `ask_volume`
- `high_52w`, `low_52w`
- `market_cap`, `per`, `pbv`, `eps`, `div_yield`, `dividend`
- `price_datetime`, `captured_at`

## How it works

1. **Discover** — loads the BVB Shares market page with Playwright (handles ASP.NET rendering) and extracts every symbol + ISIN.
2. **Fetch** — opens each company's detail page (`FinancialInstrumentsDetails.aspx?s=<symbol>`), parses the core info, prices, market indicators, issue info and shareholders.
3. **Persist** — upserts the company row and appends a price snapshot.

## Setup

### 1. Apply the Supabase schema

Either:
- run `npm run schema` (needs `DATABASE_URL`), or
- paste `src/schema.sql` into the Supabase SQL editor.

### 2. Configure env

```bash
cp .env.example .env
# edit if needed
```

### 3. Run locally

```bash
npm install
npx playwright install --with-deps chromium
npm start          # starts HTTP server + runs backfill crawl
```

## HTTP API

| Method | Path        | Description |
|--------|-------------|-------------|
| `GET`  | `/health`   | health + crawl status |
| `POST` | `/crawl?s=FP` | trigger a crawl (all symbols, or one via `?s=`) |
| `GET`  | `/companies`| list stored companies |

`RUN_ON_START=1` runs the backfill crawl immediately on boot.

## Docker / Coolify

Build & run locally:

```bash
docker build -t bvb-crawler .
docker run --rm -p 8080:8080 --env-file .env bvb-crawler
```

Coolify deploy:
1. Create a new app → **Dockerfile** build pack → point at this repo/directory.
2. Add the env vars from `.env.example` in the Coolify **Environment Variables** editor.
3. Deploy. The container starts the HTTP server and runs the backfill crawl on boot.

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `SUPABASE_URL` | — | Supabase project URL (required) |
| `SUPABASE_SERVICE_ROLE_KEY` | — | service_role key (required) |
| `RUN_ON_START` | `1` | run the crawl when the container starts |
| `CRAWL_CONCURRENCY` | `3` | parallel page fetches |
| `CRAWL_TIMEOUT` | `60000` | per-page navigation timeout (ms) |
| `STORE_RAW_HTML` | `0` | store full HTML in `companies.raw_html` |
| `PORT` | `8080` | HTTP server port |