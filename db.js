'use strict';
// Database layer. Uses Postgres when DATABASE_URL is set (Railway),
// otherwise a local in-process Postgres (PGlite) so `npm start` works with no setup.
const path = require('path');
const { SERVICES } = require('./seed-data');

const DEFAULT_SETTINGS = {
  business_name: 'Page Smart Solutions',
  business_tagline: 'IT and smart home services',
  business_phone: '',
  business_phone_2: '',
  business_email: '',
  business_address: 'Georgetown, TX',
  home_address: '',
  service_area: 'Georgetown and Williamson County, TX',
  payment_instructions: 'Payment accepted by Venmo. Thank you for your business.',
  invoice_terms_days: '7',
  sales_tax_rate: '0',
  travel_free_minutes: '15',
  travel_rate: '50',
  travel_round_minutes: '30',
  onsite_minimum_hours: '1',
  parts_markup: '10',
  timezone: 'America/Chicago',
};

// IRS standard business mileage rates (cents per mile / 100), by effective date.
// 2026 changed mid-year: 72.5 cents through June 30, 76 cents from July 1.
const MILEAGE_RATES = [
  ['2025-01-01', 0.70],
  ['2026-01-01', 0.725],
  ['2026-07-01', 0.76],
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS services (
     id SERIAL PRIMARY KEY,
     category TEXT NOT NULL,
     name TEXT NOT NULL,
     info TEXT NOT NULL DEFAULT '',
     billing TEXT NOT NULL DEFAULT 'Flat',
     price DOUBLE PRECISION,
     price_label TEXT NOT NULL DEFAULT '',
     sort INTEGER NOT NULL DEFAULT 0,
     active BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  `CREATE TABLE IF NOT EXISTS customers (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     phone TEXT NOT NULL DEFAULT '',
     email TEXT NOT NULL DEFAULT '',
     address TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id SERIAL PRIMARY KEY,
     customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
     title TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'Requested',
     service_date TEXT NOT NULL DEFAULT '',
     items JSONB NOT NULL DEFAULT '[]'::jsonb,
     notes TEXT NOT NULL DEFAULT '',
     one_way_minutes INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS invoices (
     id SERIAL PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
     order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
     issue_date TEXT NOT NULL DEFAULT '',
     due_date TEXT NOT NULL DEFAULT '',
     items JSONB NOT NULL DEFAULT '[]'::jsonb,
     subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
     discount DOUBLE PRECISION NOT NULL DEFAULT 0,
     tax_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
     tax DOUBLE PRECISION NOT NULL DEFAULT 0,
     total DOUBLE PRECISION NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'Draft',
     paid_date TEXT NOT NULL DEFAULT '',
     payment_method TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS inquiries (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL DEFAULT '',
     phone TEXT NOT NULL DEFAULT '',
     service TEXT NOT NULL DEFAULT '',
     preferred TEXT NOT NULL DEFAULT '',
     message TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'New',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS expenses (
     id SERIAL PRIMARY KEY,
     date TEXT NOT NULL DEFAULT '',
     vendor TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     category TEXT NOT NULL DEFAULT 'Other',
     amount DOUBLE PRECISION NOT NULL DEFAULT 0,
     payment_method TEXT NOT NULL DEFAULT '',
     reference TEXT NOT NULL DEFAULT '',
     customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
     notes TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS receipts (
     id SERIAL PRIMARY KEY,
     expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
     filename TEXT NOT NULL DEFAULT '',
     mime TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0,
     data BYTEA NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS mileage (
     id SERIAL PRIMARY KEY,
     date TEXT NOT NULL DEFAULT '',
     customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
     order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
     from_addr TEXT NOT NULL DEFAULT '',
     to_addr TEXT NOT NULL DEFAULT '',
     miles DOUBLE PRECISION NOT NULL DEFAULT 0,
     round_trip BOOLEAN NOT NULL DEFAULT FALSE,
     purpose TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS mileage_rates (
     effective_from TEXT PRIMARY KEY,
     rate DOUBLE PRECISION NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tax_years (
     year INTEGER PRIMARY KEY,
     filing_status TEXT NOT NULL DEFAULT 'single',
     salary DOUBLE PRECISION NOT NULL DEFAULT 0,
     fed_withholding DOUBLE PRECISION NOT NULL DEFAULT 0,
     std_deduction DOUBLE PRECISION NOT NULL,
     ss_wage_base DOUBLE PRECISION NOT NULL,
     brackets JSONB NOT NULL,
     qbi_enabled BOOLEAN NOT NULL DEFAULT FALSE,
     notes TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id)`,
  `CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices(customer_id)`,
  `CREATE INDEX IF NOT EXISTS invoices_order_idx ON invoices(order_id)`,
  `CREATE INDEX IF NOT EXISTS receipts_expense_idx ON receipts(expense_id)`,
  `CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(date)`,
  `CREATE INDEX IF NOT EXISTS mileage_date_idx ON mileage(date)`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS expenses_order_idx ON expenses(order_id)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS from_addr TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS one_way_miles DOUBLE PRECISION`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS from_addr TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS one_way_miles DOUBLE PRECISION`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS one_way_minutes INTEGER`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS invoices_token_idx ON invoices(public_token)`,
  `ALTER TABLE services ADD COLUMN IF NOT EXISTS no_travel BOOLEAN NOT NULL DEFAULT FALSE`,
];

let client = null;

async function init() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const needsSsl = /rlwy\.net|sslmode=require/.test(url) || process.env.PGSSL === 'true';
    const pool = new Pool({
      connectionString: url,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    client = { kind: 'postgres', query: (text, params) => pool.query(text, params) };
  } else {
    let PGlite;
    try {
      ({ PGlite } = require('@electric-sql/pglite'));
    } catch (e) {
      throw new Error('DATABASE_URL is not set. Set it to a Postgres URL, or run `npm install` to use the local dev database.');
    }
    const dir = process.env.LOCAL_DB_DIR || path.join(__dirname, '.localdb');
    const pg = new PGlite(dir);
    await pg.waitReady;
    client = { kind: 'pglite', query: (text, params) => pg.query(text, params) };
  }

  for (const stmt of SCHEMA) await client.query(stmt);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query('INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  }

  for (const [from, rate] of MILEAGE_RATES) {
    await client.query('INSERT INTO mileage_rates(effective_from, rate) VALUES ($1, $2) ON CONFLICT (effective_from) DO NOTHING', [from, rate]);
  }

  const count = (await client.query('SELECT COUNT(*)::int AS n FROM services')).rows[0].n;
  if (count === 0) {
    let sort = 0;
    for (const s of SERVICES) {
      sort += 10;
      await client.query(
        'INSERT INTO services(category, name, info, billing, price, price_label, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.category, s.name, s.info, s.billing, s.price ?? null, s.price_label || '', sort]
      );
    }
  }
  // Give every invoice a private customer link token
  const missing = await client.query('SELECT id FROM invoices WHERE public_token IS NULL');
  for (const row of missing.rows) await client.query('UPDATE invoices SET public_token = $1 WHERE id = $2', [require('crypto').randomBytes(16).toString('hex'), row.id]);
  // One time: remote work carries no mileage or travel charge. After this, the admin controls it per service.
  const first = await client.query("INSERT INTO settings(key, value) VALUES ('migr_no_travel', '1') ON CONFLICT (key) DO NOTHING RETURNING key");
  if (first.rows.length) await client.query("UPDATE services SET no_travel = TRUE WHERE name ILIKE 'remote%'");
  return client;
}

function query(text, params) {
  if (!client) throw new Error('Database not initialised');
  return client.query(text, params);
}

module.exports = { init, query, DEFAULT_SETTINGS, kind: () => client && client.kind };
