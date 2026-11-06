'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { computeTax, newTaxYear } = require('./tax');
const { renderHome } = require('./render-home');

const q = (text, params) => db.query(text, params);

// ---------- small helpers ----------
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const dateOr = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const intOrNull = v => (v !== '' && v != null && Number.isInteger(Number(v)) ? Number(v) : null);
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

const BILLING = ['Hourly', 'Flat', 'Device', 'Custom'];
const ORDER_STATUS = ['Requested', 'Scheduled', 'In progress', 'Completed', 'Invoiced', 'Cancelled'];
const INVOICE_STATUS = ['Draft', 'Sent', 'Paid', 'Void'];
const INQUIRY_STATUS = ['New', 'Read', 'Done'];
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

async function getSettings() {
  const rows = (await q('SELECT key, value FROM settings')).rows;
  const s = { ...db.DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function todayStr(s) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: s.timezone || 'America/Chicago' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(dateString, n) {
  const d = new Date(dateString + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- line items and totals ----------
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(it => ({
    desc: str(it.desc, 300),
    billing: BILLING.includes(it.billing) ? it.billing : 'Flat',
    rate: r2(it.rate),
    qty: Math.max(0, Math.round((Number(it.qty) || 0) * 100) / 100),
    kind: ['service', 'travel', 'custom', 'mileage'].includes(it.kind) ? it.kind : 'custom',
    service_id: Number.isInteger(it.service_id) ? it.service_id : null,
  })).filter(it => it.desc || it.rate || it.qty);
}
const lineTotal = it => r2(it.rate * it.qty);

function totals(items, discount, taxRate) {
  const subtotal = r2(items.reduce((sum, it) => sum + lineTotal(it), 0));
  const disc = Math.min(Math.max(r2(discount), 0), subtotal);
  const rate = Math.min(Math.max(Number(taxRate) || 0, 0), 20);
  const tax = r2((subtotal - disc) * rate / 100);
  return { subtotal, discount: disc, tax_rate: rate, tax, total: r2(subtotal - disc + tax) };
}

async function nextInvoiceNumber(today) {
  const prefix = `PSS-${today.slice(0, 4)}-`;
  const row = (await q('SELECT number FROM invoices WHERE number LIKE $1 ORDER BY number DESC LIMIT 1', [prefix + '%'])).rows[0];
  const n = row ? parseInt(row.number.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

function invoiceFields(b, s, today) {
  const items = normalizeItems(b.items);
  const t = totals(items, b.discount, b.tax_rate ?? s.sales_tax_rate);
  const status = INVOICE_STATUS.includes(b.status) ? b.status : 'Draft';
  const paid = status === 'Paid';
  return {
    items, ...t, status,
    paid_date: paid ? (dateOr(b.paid_date) || today) : '',
    payment_method: paid ? str(b.payment_method, 40) : '',
    notes: str(b.notes, 2000),
    issue_date: dateOr(b.issue_date) || today,
    due_date: dateOr(b.due_date),
    customer_id: intOrNull(b.customer_id),
    order_id: intOrNull(b.order_id),
  };
}

async function insertInvoice(f, today) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextInvoiceNumber(today);
    try {
      const r = await q(
        `INSERT INTO invoices(number, customer_id, order_id, issue_date, due_date, items, subtotal, discount, tax_rate, tax, total, status, paid_date, payment_method, notes)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [number, f.customer_id, f.order_id, f.issue_date, f.due_date, JSON.stringify(f.items), f.subtotal, f.discount, f.tax_rate, f.tax, f.total, f.status, f.paid_date, f.payment_method, f.notes]
      );
      return r.rows[0].id;
    } catch (e) {
      if (e.code !== '23505' || attempt === 2) throw e;
    }
  }
}

// ---------- tax and mileage ----------
async function getRates() {
  return (await q('SELECT effective_from, rate FROM mileage_rates ORDER BY effective_from ASC')).rows;
}
function rateFor(date, rates) {
  let rate = rates.length ? rates[0].rate : 0;
  for (const r of rates) if (r.effective_from <= date) rate = r.rate;
  return rate;
}

async function getTaxYear(year) {
  let row = (await q('SELECT * FROM tax_years WHERE year = $1', [year])).rows[0];
  if (!row) {
    const prev = (await q('SELECT * FROM tax_years WHERE year < $1 ORDER BY year DESC LIMIT 1', [year])).rows[0];
    const base = prev ? { ...prev, fed_withholding: 0 } : newTaxYear();
    await q(
      `INSERT INTO tax_years(year, filing_status, salary, fed_withholding, std_deduction, ss_wage_base, brackets, qbi_enabled)
       VALUES ($1,'single',$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (year) DO NOTHING`,
      [year, base.salary || 0, base.fed_withholding || 0, base.std_deduction, base.ss_wage_base, JSON.stringify(base.brackets), !!base.qbi_enabled]
    );
    row = (await q('SELECT * FROM tax_years WHERE year = $1', [year])).rows[0];
  }
  return row;
}

async function taxReport(year) {
  const cfg = await getTaxYear(year);
  const y = String(year);
  const invoices = (await q("SELECT total, tax, paid_date FROM invoices WHERE status = 'Paid' AND substr(paid_date, 1, 4) = $1", [y])).rows;
  const expenses = (await q('SELECT amount, date FROM expenses WHERE substr(date, 1, 4) = $1', [y])).rows;
  const trips = (await q('SELECT date, miles, round_trip FROM mileage WHERE substr(date, 1, 4) = $1', [y])).rows;
  const rates = await getRates();

  const monthly = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, revenue: 0, expenses: 0, miles: 0, mileage: 0 }));
  let revenue = 0, expenseTotal = 0, miles = 0, mileageDeduction = 0;
  for (const i of invoices) {
    const net = r2(i.total - i.tax); // sales tax collected is not income
    revenue += net;
    const m = parseInt(i.paid_date.slice(5, 7), 10) - 1;
    if (monthly[m]) monthly[m].revenue += net;
  }
  for (const e of expenses) {
    expenseTotal += e.amount;
    const m = parseInt(e.date.slice(5, 7), 10) - 1;
    if (monthly[m]) monthly[m].expenses += e.amount;
  }
  for (const t of trips) {
    const mi = t.miles * (t.round_trip ? 2 : 1);
    const ded = mi * rateFor(t.date, rates);
    miles += mi;
    mileageDeduction += ded;
    const m = parseInt(t.date.slice(5, 7), 10) - 1;
    if (monthly[m]) { monthly[m].miles += mi; monthly[m].mileage += ded; }
  }
  for (const m of monthly) {
    m.revenue = r2(m.revenue); m.expenses = r2(m.expenses); m.miles = Math.round(m.miles * 10) / 10; m.mileage = r2(m.mileage);
  }

  const result = computeTax({
    revenue, expenses: expenseTotal, mileageDeduction,
    salary: cfg.salary, withholding: cfg.fed_withholding,
    stdDeduction: cfg.std_deduction, ssWageBase: cfg.ss_wage_base,
    brackets: cfg.brackets, qbiEnabled: cfg.qbi_enabled,
  });
  return {
    year, config: cfg,
    inputs: { revenue: r2(revenue), expenses: r2(expenseTotal), miles: Math.round(miles * 10) / 10, mileageDeduction: r2(mileageDeduction) },
    result, monthly,
  };
}

// ---------- auth ----------
const PASSWORD = process.env.ADMIN_PASSWORD || (process.env.DATABASE_URL ? '' : 'dev');
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('pss-session:' + PASSWORD).digest('hex');
const COOKIE = 'pss_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;

const sign = value => crypto.createHmac('sha256', SECRET).update(value).digest('hex');
const sha = v => crypto.createHash('sha256').update(String(v)).digest();

function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
}
function validToken(token) {
  if (!token) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const requireAuth = (req, res, next) => (validToken(cookies(req)[COOKIE]) ? next() : res.status(401).json({ error: 'Sign in required' }));

function limiter(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'x';
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

// ---------- optional email notification (Resend) ----------
async function notifyInquiry(inq) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Page Smart Solutions <onboarding@resend.dev>',
        to: [to],
        subject: `New inquiry from ${inq.name}`,
        text: `Name: ${inq.name}\nPhone: ${inq.phone}\nEmail: ${inq.email}\nNeeds: ${inq.service}\nPrefers: ${inq.preferred}\n\n${inq.message}`,
      }),
    });
  } catch (e) {
    console.error('Inquiry email failed:', e.message);
  }
}

// ---------- app ----------
function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Public pages
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', ah(async (req, res) => {
    const settings = await getSettings();
    const services = (await q('SELECT * FROM services WHERE active = TRUE ORDER BY sort, id')).rows;
    res.set('Cache-Control', 'no-cache').type('html').send(renderHome(settings, services));
  }));
  app.get('/contact', (req, res) => res.redirect(302, '/#contact'));
  app.get('/prices', (req, res) => res.redirect(302, '/#services'));
  // Web files live in public/ or, when uploaded flat, next to server.js. Only these names are served.
  const WEB_FILES = ['base.css', 'home.css', 'contact.js', 'admin.html', 'admin.css', 'admin.js', 'print.html'];
  const webDir = fs.existsSync(path.join(__dirname, 'public', 'base.css')) ? path.join(__dirname, 'public') : __dirname;
  const sendWeb = (name, res) => res.sendFile(path.join(webDir, name));
  app.get('/admin', (req, res) => { res.set('X-Robots-Tag', 'noindex'); sendWeb('admin.html', res); });
  app.get('/print', (req, res) => { res.set('X-Robots-Tag', 'noindex'); sendWeb('print.html', res); });
  WEB_FILES.filter(f => f !== 'admin.html' && f !== 'print.html').forEach(f => app.get('/' + f, (req, res) => sendWeb(f, res)));

  // Driving distance (OpenStreetMap geocoding + OSRM routing), used to auto-fill miles and drive time
  const geoCache = new Map();
  const geocode = async place => {
    const key = place.trim().toLowerCase();
    if (geoCache.has(key)) return geoCache.get(key);
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(place), {
      headers: { 'User-Agent': 'PageSmartSolutionsAdmin/1.0' }, signal: AbortSignal.timeout(8000),
    });
    const hit = (await r.json())[0];
    if (!hit) throw new Error('not found');
    const pt = [hit.lon, hit.lat];
    geoCache.set(key, pt);
    return pt;
  };

  // Public API
  app.post('/api/contact', limiter(5, 3600 * 1000), ah(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // honeypot
    const tooFast = Number(b.ts) && Date.now() - Number(b.ts) < 2500;
    const name = str(b.name, 100), email = str(b.email, 200), phone = str(b.phone, 40), message = str(b.message, 3000);
    if (!name) throw httpError(400, 'Please enter your name.');
    if (!email && !phone) throw httpError(400, 'Please enter an email or phone number so I can reply.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'That email address does not look right.');
    if (message.length < 5) throw httpError(400, 'Please add a short message.');
    if (tooFast) return res.json({ ok: true });
    const inq = { name, email, phone, message, service: str(b.service, 100), preferred: str(b.preferred, 20) };
    await q('INSERT INTO inquiries(name, email, phone, service, preferred, message) VALUES ($1,$2,$3,$4,$5,$6)',
      [inq.name, inq.email, inq.phone, inq.service, inq.preferred, inq.message]);
    notifyInquiry(inq);
    res.json({ ok: true });
  }));

  app.post('/api/login', limiter(8, 10 * 60 * 1000), (req, res) => {
    const given = sha(req.body && req.body.password);
    if (!PASSWORD || !crypto.timingSafeEqual(given, sha(PASSWORD))) return res.status(401).json({ error: 'Wrong password.' });
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything below needs the admin login
  app.use('/api', requireAuth);
  app.get('/api/me', (req, res) => res.json({ ok: true }));

  // Settings
  app.get('/api/settings', ah(async (req, res) => res.json(await getSettings())));
  app.put('/api/settings', ah(async (req, res) => {
    for (const key of Object.keys(db.DEFAULT_SETTINGS)) {
      if (req.body[key] === undefined) continue;
      await q('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, str(req.body[key], 500)]);
    }
    res.json(await getSettings());
  }));

  // Services
  const serviceBody = b => {
    const price = b.price === '' || b.price == null ? null : r2(b.price);
    if (!str(b.name)) throw httpError(400, 'Service name is required.');
    return [str(b.category, 80) || 'Other', str(b.name, 150), str(b.info, 300), BILLING.includes(b.billing) ? b.billing : 'Flat', price, str(b.price_label, 40), b.active === false ? false : true, !!b.no_travel];
  };
  app.get('/api/services', ah(async (req, res) => res.json((await q('SELECT * FROM services ORDER BY sort, id')).rows)));
  app.post('/api/services', ah(async (req, res) => {
    const max = (await q('SELECT COALESCE(MAX(sort),0)::int AS m FROM services')).rows[0].m;
    const r = await q('INSERT INTO services(category,name,info,billing,price,price_label,active,no_travel,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [...serviceBody(req.body), max + 10]);
    res.json(r.rows[0]);
  }));
  app.put('/api/services-order', ah(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    for (let i = 0; i < ids.length; i++) await q('UPDATE services SET sort=$1 WHERE id=$2', [(i + 1) * 10, ids[i]]);
    res.json((await q('SELECT * FROM services ORDER BY sort, id')).rows);
  }));
  app.put('/api/services/:id', ah(async (req, res) => {
    const r = await q('UPDATE services SET category=$1,name=$2,info=$3,billing=$4,price=$5,price_label=$6,active=$7,no_travel=$8 WHERE id=$9 RETURNING *', [...serviceBody(req.body), Number(req.params.id)]);
    if (!r.rows[0]) throw httpError(404, 'Not found');
    res.json(r.rows[0]);
  }));
  app.delete('/api/services/:id', ah(async (req, res) => { await q('DELETE FROM services WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

  // Customers
  const customerBody = b => {
    if (!str(b.name)) throw httpError(400, 'Customer name is required.');
    return [str(b.name, 150), str(b.phone, 40), str(b.email, 200), str(b.address, 300), str(b.notes, 2000)];
  };
  app.get('/api/customers', ah(async (req, res) => res.json((await q('SELECT * FROM customers ORDER BY lower(name)')).rows)));
  app.post('/api/customers', ah(async (req, res) => {
    const r = await q('INSERT INTO customers(name,phone,email,address,notes) VALUES ($1,$2,$3,$4,$5) RETURNING *', customerBody(req.body));
    res.json(r.rows[0]);
  }));
  app.put('/api/customers/:id', ah(async (req, res) => {
    const r = await q('UPDATE customers SET name=$1,phone=$2,email=$3,address=$4,notes=$5 WHERE id=$6 RETURNING *', [...customerBody(req.body), Number(req.params.id)]);
    if (!r.rows[0]) throw httpError(404, 'Not found');
    res.json(r.rows[0]);
  }));
  app.delete('/api/customers/:id', ah(async (req, res) => { await q('DELETE FROM customers WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

  // Jobs (orders)
  const ORDER_SELECT = `SELECT o.*, c.name AS customer_name,
      (SELECT i.id FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) AS invoice_id,
      (SELECT i.status FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) AS invoice_status
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id`;
  const withTotal = o => ({ ...o, total: r2((o.items || []).reduce((sum, it) => sum + lineTotal(it), 0)) });
  const orderBody = b => {
    const items = normalizeItems(b.items);
    return [intOrNull(b.customer_id), str(b.title, 200), ORDER_STATUS.includes(b.status) ? b.status : 'Requested', dateOr(b.service_date), JSON.stringify(items), str(b.notes, 2000), intOrNull(b.one_way_minutes), str(b.from_addr, 300), b.one_way_miles === '' || b.one_way_miles == null ? null : Math.max(0, Math.round(Number(b.one_way_miles) * 10) / 10) || null];
  };
  app.get('/api/orders', ah(async (req, res) => res.json((await q(ORDER_SELECT + ' ORDER BY o.service_date DESC, o.id DESC')).rows.map(withTotal))));
  app.post('/api/orders', ah(async (req, res) => {
    const r = await q('INSERT INTO orders(customer_id,title,status,service_date,items,notes,one_way_minutes,from_addr,one_way_miles) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id', orderBody(req.body));
    res.json(withTotal((await q(ORDER_SELECT + ' WHERE o.id=$1', [r.rows[0].id])).rows[0]));
  }));
  app.put('/api/orders/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const r = await q('UPDATE orders SET customer_id=$1,title=$2,status=$3,service_date=$4,items=$5::jsonb,notes=$6,one_way_minutes=$7,from_addr=$8,one_way_miles=$9 WHERE id=$10 RETURNING id', [...orderBody(req.body), id]);
    if (!r.rows[0]) throw httpError(404, 'Not found');
    res.json(withTotal((await q(ORDER_SELECT + ' WHERE o.id=$1', [id])).rows[0]));
  }));
  app.delete('/api/orders/:id', ah(async (req, res) => { await q('DELETE FROM orders WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));
  app.post('/api/orders/:id/invoice', ah(async (req, res) => {
    const id = Number(req.params.id);
    const o = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!o) throw httpError(404, 'Job not found');
    const existing = (await q('SELECT id FROM invoices WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
    if (existing) return res.json({ id: existing.id, existing: true });
    const s = await getSettings();
    const today = todayStr(s);
    const paid = !!(req.body && req.body.paid);
    const f = invoiceFields({
      items: o.items, customer_id: o.customer_id, order_id: id,
      status: paid ? 'Paid' : 'Draft',
      paid_date: req.body && req.body.paid_date, payment_method: req.body && req.body.payment_method,
      issue_date: o.service_date || today, due_date: addDays(today, Number(s.invoice_terms_days) || 7),
      tax_rate: s.sales_tax_rate, notes: '',
    }, s, today);
    const newId = await insertInvoice(f, today);
    await q("UPDATE orders SET status = 'Invoiced' WHERE id = $1", [id]);
    res.json({ id: newId });
  }));

  // Invoices
  const INVOICE_SELECT = 'SELECT i.*, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id';
  app.get('/api/invoices', ah(async (req, res) => res.json((await q(INVOICE_SELECT + ' ORDER BY i.issue_date DESC, i.id DESC')).rows)));
  app.get('/api/invoices/:id', ah(async (req, res) => {
    const inv = (await q(INVOICE_SELECT + ' WHERE i.id=$1', [Number(req.params.id)])).rows[0];
    if (!inv) throw httpError(404, 'Invoice not found');
    inv.customer = inv.customer_id ? (await q('SELECT * FROM customers WHERE id=$1', [inv.customer_id])).rows[0] || null : null;
    res.json(inv);
  }));
  app.post('/api/invoices', ah(async (req, res) => {
    const s = await getSettings();
    const today = todayStr(s);
    const body = { due_date: addDays(today, Number(s.invoice_terms_days) || 7), ...req.body };
    const id = await insertInvoice(invoiceFields(body, s, today), today);
    res.json((await q(INVOICE_SELECT + ' WHERE i.id=$1', [id])).rows[0]);
  }));
  app.put('/api/invoices/:id', ah(async (req, res) => {
    const s = await getSettings();
    const f = invoiceFields(req.body, s, todayStr(s));
    const r = await q(
      `UPDATE invoices SET customer_id=$1, order_id=$2, issue_date=$3, due_date=$4, items=$5::jsonb, subtotal=$6, discount=$7, tax_rate=$8, tax=$9, total=$10, status=$11, paid_date=$12, payment_method=$13, notes=$14 WHERE id=$15 RETURNING id`,
      [f.customer_id, f.order_id, f.issue_date, f.due_date, JSON.stringify(f.items), f.subtotal, f.discount, f.tax_rate, f.tax, f.total, f.status, f.paid_date, f.payment_method, f.notes, Number(req.params.id)]
    );
    if (!r.rows[0]) throw httpError(404, 'Invoice not found');
    res.json((await q(INVOICE_SELECT + ' WHERE i.id=$1', [r.rows[0].id])).rows[0]);
  }));
  app.delete('/api/invoices/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const inv = (await q('SELECT order_id FROM invoices WHERE id=$1', [id])).rows[0];
    await q('DELETE FROM invoices WHERE id=$1', [id]);
    if (inv && inv.order_id) await q("UPDATE orders SET status='Completed' WHERE id=$1 AND status='Invoiced'", [inv.order_id]);
    res.json({ ok: true });
  }));

  // Inquiries (contact form inbox)
  app.get('/api/inquiries', ah(async (req, res) => res.json((await q('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 500')).rows)));
  app.put('/api/inquiries/:id', ah(async (req, res) => {
    if (!INQUIRY_STATUS.includes(req.body.status)) throw httpError(400, 'Bad status');
    const r = await q('UPDATE inquiries SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, Number(req.params.id)]);
    res.json(r.rows[0]);
  }));
  app.delete('/api/inquiries/:id', ah(async (req, res) => { await q('DELETE FROM inquiries WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

  // Expenses and receipts
  const expenseBody = b => [dateOr(b.date), str(b.vendor, 150), str(b.description, 300), str(b.category, 60) || 'Other', r2(b.amount), str(b.payment_method, 40), str(b.reference, 120), intOrNull(b.customer_id), str(b.notes, 1000), intOrNull(b.order_id)];
  async function expensesWithReceipts(where, params) {
    const rows = (await q(`SELECT e.*, c.name AS customer_name FROM expenses e LEFT JOIN customers c ON c.id = e.customer_id ${where} ORDER BY e.date DESC, e.id DESC`, params)).rows;
    const rec = (await q('SELECT id, expense_id, filename, mime, size FROM receipts ORDER BY id')).rows;
    return rows.map(e => ({ ...e, receipts: rec.filter(r => r.expense_id === e.id) }));
  }
  app.get('/api/expenses', ah(async (req, res) => res.json(await expensesWithReceipts('', []))));
  app.post('/api/expenses', ah(async (req, res) => {
    const r = await q('INSERT INTO expenses(date,vendor,description,category,amount,payment_method,reference,customer_id,notes,order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', expenseBody(req.body));
    res.json((await expensesWithReceipts('WHERE e.id = $1', [r.rows[0].id]))[0]);
  }));
  app.put('/api/expenses/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const body = { ...req.body };
    if (body.order_id === undefined) { const cur = (await q('SELECT order_id FROM expenses WHERE id=$1', [id])).rows[0]; body.order_id = cur ? cur.order_id : null; }
    const r = await q('UPDATE expenses SET date=$1,vendor=$2,description=$3,category=$4,amount=$5,payment_method=$6,reference=$7,customer_id=$8,notes=$9,order_id=$10 WHERE id=$11 RETURNING id', [...expenseBody(body), id]);
    if (!r.rows[0]) throw httpError(404, 'Not found');
    res.json((await expensesWithReceipts('WHERE e.id = $1', [id]))[0]);
  }));
  app.delete('/api/expenses/:id', ah(async (req, res) => { await q('DELETE FROM expenses WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

  app.post('/api/expenses/:id/receipts', express.raw({ type: () => true, limit: '8mb' }), ah(async (req, res) => {
    const id = Number(req.params.id);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!RECEIPT_TYPES.includes(mime)) throw httpError(400, 'Receipts must be a photo (JPG, PNG, WebP, HEIC) or a PDF.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Empty file.');
    const exp = (await q('SELECT id FROM expenses WHERE id=$1', [id])).rows[0];
    if (!exp) throw httpError(404, 'Expense not found');
    const count = (await q('SELECT COUNT(*)::int AS n FROM receipts WHERE expense_id=$1', [id])).rows[0].n;
    if (count >= 10) throw httpError(400, 'That expense already has 10 receipts.');
    let filename = 'receipt';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'receipt')).replace(/[^\w.\- ]+/g, '_').slice(0, 120); } catch { /* keep default */ }
    const r = await q('INSERT INTO receipts(expense_id, filename, mime, size, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, expense_id, filename, mime, size', [id, filename, mime, req.body.length, req.body]);
    res.json(r.rows[0]);
  }));
  app.get('/api/receipts/:id', ah(async (req, res) => {
    const row = (await q('SELECT * FROM receipts WHERE id=$1', [Number(req.params.id)])).rows[0];
    if (!row) throw httpError(404, 'Receipt not found');
    res.set({
      'Content-Type': row.mime,
      'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=300',
    });
    res.send(Buffer.from(row.data));
  }));
  app.delete('/api/receipts/:id', ah(async (req, res) => { await q('DELETE FROM receipts WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));

  // Mileage
  const mileageBody = b => {
    const miles = Math.max(0, Math.round((Number(b.miles) || 0) * 10) / 10);
    return [dateOr(b.date), intOrNull(b.customer_id), intOrNull(b.order_id), str(b.from_addr, 300), str(b.to_addr, 300), miles, !!b.round_trip, str(b.purpose, 200)];
  };
  async function mileageRows(where, params) {
    const rates = await getRates();
    const rows = (await q(`SELECT m.*, c.name AS customer_name FROM mileage m LEFT JOIN customers c ON c.id = m.customer_id ${where} ORDER BY m.date DESC, m.id DESC`, params)).rows;
    return rows.map(m => {
      const total_miles = Math.round(m.miles * (m.round_trip ? 2 : 1) * 10) / 10;
      const rate = rateFor(m.date, rates);
      return { ...m, total_miles, rate, deduction: r2(total_miles * rate) };
    });
  }
  app.get('/api/mileage', ah(async (req, res) => res.json({ rates: await getRates(), trips: await mileageRows('', []) })));
  app.post('/api/mileage', ah(async (req, res) => {
    const r = await q('INSERT INTO mileage(date,customer_id,order_id,from_addr,to_addr,miles,round_trip,purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', mileageBody(req.body));
    res.json((await mileageRows('WHERE m.id = $1', [r.rows[0].id]))[0]);
  }));
  app.put('/api/mileage/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const r = await q('UPDATE mileage SET date=$1,customer_id=$2,order_id=$3,from_addr=$4,to_addr=$5,miles=$6,round_trip=$7,purpose=$8 WHERE id=$9 RETURNING id', [...mileageBody(req.body), id]);
    if (!r.rows[0]) throw httpError(404, 'Not found');
    res.json((await mileageRows('WHERE m.id = $1', [id]))[0]);
  }));
  app.delete('/api/mileage/:id', ah(async (req, res) => { await q('DELETE FROM mileage WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }));
  app.put('/api/mileage-rates', ah(async (req, res) => {
    const list = Array.isArray(req.body.rates) ? req.body.rates : [];
    const clean = list.map(r => ({ effective_from: dateOr(r.effective_from), rate: Number(r.rate) })).filter(r => r.effective_from && r.rate > 0 && r.rate < 5);
    if (!clean.length) throw httpError(400, 'Add at least one rate.');
    await q('DELETE FROM mileage_rates');
    for (const r of clean) await q('INSERT INTO mileage_rates(effective_from, rate) VALUES ($1,$2) ON CONFLICT (effective_from) DO UPDATE SET rate = EXCLUDED.rate', [r.effective_from, r.rate]);
    res.json(await getRates());
  }));

  // Financial / tax
  app.get('/api/tax/:year', ah(async (req, res) => {
    const year = Number(req.params.year);
    if (!(year >= 2020 && year <= 2100)) throw httpError(400, 'Bad year');
    res.json(await taxReport(year));
  }));
  app.put('/api/tax/:year', ah(async (req, res) => {
    const year = Number(req.params.year);
    if (!(year >= 2020 && year <= 2100)) throw httpError(400, 'Bad year');
    await getTaxYear(year);
    const b = req.body || {};
    const brackets = Array.isArray(b.brackets)
      ? b.brackets.map(x => ({ upTo: x.upTo === null || x.upTo === '' ? null : Number(x.upTo), rate: Number(x.rate) })).filter(x => x.rate >= 0 && x.rate <= 1)
      : null;
    if (brackets && (!brackets.length || brackets[brackets.length - 1].upTo !== null)) throw httpError(400, 'The last bracket must have no upper limit.');
    await q(
      `UPDATE tax_years SET salary=$1, fed_withholding=$2, std_deduction=$3, ss_wage_base=$4, qbi_enabled=$5, notes=$6 ${brackets ? ', brackets=$8::jsonb' : ''} WHERE year=$7`,
      brackets
        ? [r2(b.salary), r2(b.fed_withholding), r2(b.std_deduction), r2(b.ss_wage_base), !!b.qbi_enabled, str(b.notes, 2000), year, JSON.stringify(brackets)]
        : [r2(b.salary), r2(b.fed_withholding), r2(b.std_deduction), r2(b.ss_wage_base), !!b.qbi_enabled, str(b.notes, 2000), year]
    );
    res.json(await taxReport(year));
  }));

  // Dashboard
  app.get('/api/address', ah(async (req, res) => {
    const q0 = String(req.query.q || '').trim().slice(0, 150);
    if (q0.length < 3) return res.json([]);
    try {
      const r = await fetch('https://photon.komoot.io/api/?limit=6&lang=en&lat=30.63&lon=-97.68&q=' + encodeURIComponent(q0), { headers: { 'User-Agent': 'PageSmartSolutionsAdmin/1.0' }, signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      const seen = new Set();
      const out = [];
      for (const f of data.features || []) {
        const p = f.properties || {};
        if (p.countrycode && p.countrycode !== 'US') continue;
        const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.street || p.name || '');
        const label = [street, p.city || p.locality || p.county, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        if (!street || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
      }
      res.json(out);
    } catch (e) { res.json([]); }
  }));

  app.get('/api/distance', ah(async (req, res) => {
    const from = String(req.query.from || '').slice(0, 300);
    const to = String(req.query.to || '').slice(0, 300);
    if (!from || !to) throw httpError(400, 'Both a starting address and a destination are needed.');
    try {
      const [a, b] = await Promise.all([geocode(from), geocode(to)]);
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=false`, { signal: AbortSignal.timeout(8000) });
      const route = (await r.json()).routes?.[0];
      if (!route) throw new Error('no route');
      res.json({ miles: Math.round((route.distance / 1609.344) * 10) / 10, minutes: Math.max(1, Math.round(route.duration / 60)) });
    } catch (e) {
      throw httpError(502, 'Could not look up that distance. Check both addresses, or type the miles yourself.');
    }
  }));

  app.get('/api/dashboard', ah(async (req, res) => {
    const s = await getSettings();
    const today = todayStr(s);
    const year = Number(today.slice(0, 4));
    const invoices = (await q(INVOICE_SELECT)).rows;
    const sum = list => r2(list.reduce((t, i) => t + i.total, 0));
    const sent = invoices.filter(i => i.status === 'Sent');
    const overdue = sent.filter(i => i.due_date && i.due_date < today);
    const tax = await taxReport(year);
    const orders = (await q(ORDER_SELECT + " WHERE o.status IN ('Requested','Scheduled','In progress','Completed') ORDER BY o.service_date ASC, o.id ASC")).rows.map(withTotal);
    const inquiries = (await q("SELECT * FROM inquiries WHERE status = 'New' ORDER BY created_at DESC LIMIT 10")).rows;
    res.json({
      today, year,
      outstanding: sum(sent), outstandingCount: sent.length, overdueCount: overdue.length,
      draftTotal: sum(invoices.filter(i => i.status === 'Draft')),
      paidYtd: tax.inputs.revenue, profitYtd: tax.result.netProfit, setAside: tax.result.sideTotalTax,
      orders: orders.slice(0, 8), openOrders: orders.length,
      unpaid: sent.sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9')).slice(0, 8),
      inquiries,
    });
  }));

  // API 404 and errors
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (8 MB max).' });
    if (err.code === '23505') return res.status(409).json({ error: 'That already exists.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });
  return app;
}

async function start(port = Number(process.env.PORT) || 3000) {
  if (!PASSWORD) {
    console.error('ADMIN_PASSWORD is not set. Add it as an environment variable before starting.');
    process.exit(1);
  }
  await db.init();
  const app = createApp();
  return new Promise(resolve => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Page Smart Solutions listening on ${server.address().port} (${db.kind()})`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { start, createApp };
