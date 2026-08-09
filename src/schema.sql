-- BVB Crawler — Supabase schema
-- Run via: npm run schema   (uses service_role key)
-- Or apply manually in the Supabase SQL editor.

create table if not exists public.companies (
  symbol          text primary key,
  isin            text unique,
  name            text,
  instrument_type text,        -- Actiuni / Obligatiuni / ...
  segment         text,        -- SMT / Principal / ...
  category        text,        -- Premium / Standard / Int'l
  status          text,        -- Tranzactionabila / Suspendata / ...
  description     text,
  total_shares    bigint,
  nominal_value   numeric,
  share_capital   numeric,
  trading_start   date,
  vektor          numeric,
  shareholders    jsonb,       -- [{name, shares, percent}]
  raw_html        text,         -- archived page for reparsing
  details_url     text,
  crawled_at      timestamptz default now()
);

create table if not exists public.price_snapshots (
  id              bigserial primary key,
  symbol          text not null references public.companies(symbol) on delete cascade,
  price           numeric,
  variation       numeric,
  variation_pct   numeric,
  reference_price numeric,
  open_price      numeric,
  max_price       numeric,
  min_price       numeric,
  avg_price       numeric,
  volume          bigint,
  value_ron       numeric,
  trades          integer,
  bid             numeric,
  ask             numeric,
  bid_volume      bigint,
  ask_volume      bigint,
  high_52w        numeric,
  low_52w         numeric,
  market_cap      numeric,
  per             numeric,
  pbv             numeric,
  eps             numeric,
  div_yield       numeric,
  dividend        numeric,
  price_datetime  timestamptz,
  captured_at     timestamptz default now()
);

create index if not exists idx_price_snap_symbol on public.price_snapshots(symbol);
create index if not exists idx_price_snap_time  on public.price_snapshots(price_datetime desc);