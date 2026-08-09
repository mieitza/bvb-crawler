import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Supabase JS doesn't run arbitrary multi-statement SQL via the PostgREST API.
// Use the pg connection directly if DATABASE_URL is provided; otherwise print instructions.
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (dbUrl) {
  const { default: pg } = await import('pg').catch(() => ({}));
  if (!pg.Pool) {
    console.error('pg module not installed. Install with: npm i pg');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    await pool.query(sql);
    console.log('[schema] applied successfully via DATABASE_URL');
  } catch (e) {
    console.error('[schema] error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
} else {
  console.log('No DATABASE_URL set. Apply the following SQL in the Supabase SQL editor:\n');
  console.log('--- BEGIN SQL ---');
  console.log(sql);
  console.log('--- END SQL ---');
  console.log('\nOr set DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres and re-run.');
}