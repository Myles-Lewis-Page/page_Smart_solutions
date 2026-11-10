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
    from_addr: str(b.from_addr, 300),
    one_way_miles: b.one_way_miles === '' || b.one_way_miles == null ? null : (Math.max(0, Math.round(Number(b.one_way_miles) * 10) / 10) || null),
    one_way_minutes: intOrNull(b.one_way_minutes),
  };
}

async function insertInvoice(f, today) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextInvoiceNumber(today);
    try {
      const r = await q(
        `INSERT INTO invoices(number, customer_id, order_id, issue_date, due_date, items, subtotal, discount, tax_rate, tax, total, status, paid_date, payment_method, notes, from_addr, one_way_miles, one_way_minutes, public_token)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [number, f.customer_id, f.order_id, f.issue_date, f.due_date, JSON.stringify(f.items), f.subtotal, f.discount, f.tax_rate, f.tax, f.total, f.status, f.paid_date, f.payment_method, f.notes, f.from_addr, f.one_way_miles, f.one_way_minutes, crypto.randomBytes(16).toString('hex')]
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
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------- roles ----------
// One place decides who can do what. The admin screens read the same table through /api/me.
const ROLES = ['admin', 'accounting', 'employee'];
const ROLE_LABEL = { admin: 'Admin', accounting: 'Accounting', employee: 'Employee' };
const R = {
  admin: ['admin'],
  money: ['admin', 'accounting'],
  all: ['admin', 'accounting', 'employee'],
};
const CAPS = {
  users: R.admin,          // add and manage team members
  settings_edit: R.admin,  // business settings
  financial: R.admin,      // tax page, profit and set-aside numbers
  expenses: R.admin,       // expenses and receipts
  mileage: R.admin,        // mileage tax tracker
  invoices: R.money,       // see, create and change invoices (including saved ones)
  inquiries: R.money,      // contact form inbox
  services_edit: R.money,  // price list changes
  assign: R.money,         // choose who works a job
  delete_records: R.money, // delete jobs and customers
};
const capsFor = role => Object.fromEntries(Object.entries(CAPS).map(([k, roles]) => [k, roles.includes(role)]));

// Who may call which API path. First match wins. Methods not listed fall back to '*'.
const RULES = [
  [/^\/notify-test$/, { '*': R.admin }],
  [/^\/settings$/, { GET: R.all, '*': R.admin }],
  [/^\/services(-order)?(\/|$)/, { GET: R.all, '*': R.money }],
  [/^\/customers(\/|$)/, { GET: R.all, POST: R.all, PUT: R.all, '*': R.money }],
  [/^\/orders\/\d+\/invoice$/, { '*': R.money }],
  [/^\/orders(\/|$)/, { GET: R.all, POST: R.all, PUT: R.all, '*': R.money }],
  [/^\/invoices(\/|$)/, { '*': R.money }],
  [/^\/inquiries(\/|$)/, { '*': R.money }],
  [/^\/(expenses|receipts|mileage|mileage-rates|tax)(\/|$)/, { '*': R.admin }],
  [/^\/(address|distance|dashboard|team|me)(\/|$)/, { '*': R.all }],
  [/^\/users(\/|$)/, { '*': R.admin }],
];
function roleGate(req, res, next) {
  const rule = RULES.find(([re]) => re.test(req.path));
  if (!rule) return next(); // unknown paths end in the normal 404
  const roles = rule[1][req.method] || rule[1]['*'];
  if (roles.includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Your account does not have access to that.' });
}

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, 32, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`))));
}
function checkPassword(pw, stored) {
  const [kind, saltHex, keyHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return Promise.resolve(false);
  return new Promise(resolve => crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, (err, key) => {
    const want = Buffer.from(keyHex, 'hex');
    resolve(!err && key.length === want.length && crypto.timingSafeEqual(key, want));
  }));
}
const passwordOk = pw => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

// ---------- sessions ----------
// Cookie value: userId.expiry.mac. The mac covers a fingerprint of the password hash, so changing a password signs that person out everywhere.
const fingerprint = u => sha(u.password_hash).toString('hex').slice(0, 16);
function makeToken(u) {
  const body = `${u.id}.${Date.now() + SESSION_MS}`;
  return `${body}.${sign(body + '.' + fingerprint(u))}`;
}
async function userFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [id, exp, mac] = parts;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const u = (await q('SELECT * FROM users WHERE id=$1', [Number(id)])).rows[0];
  if (!u || !u.active) return null;
  const want = Buffer.from(sign(`${id}.${exp}.${fingerprint(u)}`));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? u : null;
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name || u.username, role: u.role, phone: u.phone, active: u.active });
const sessionCookie = (req, value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

// The first admin account is created from ADMIN_PASSWORD the first time the server starts.
async function ensureOwner() {
  const n = (await q('SELECT COUNT(*)::int AS n FROM users')).rows[0].n;
  if (n > 0) return;
  await q("INSERT INTO users(username, name, role, password_hash) VALUES ('admin', 'Owner', 'admin', $1)", [await hashPassword(PASSWORD)]);
}
const ownerId = async () => ((await q("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0] || {}).id;
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const requireAuth = ah(async (req, res, next) => {
  const u = await userFromToken(cookies(req)[COOKIE]);
  if (!u) return res.status(401).json({ error: 'Sign in required' });
  req.user = u;
  next();
});

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

// ---------- optional email alerts (Resend) ----------
// NOTIFY_EMAIL may hold several addresses separated by commas. A carrier text address can be one of them.
async function sendAlert(subject, text, replyTo) {
  const key = process.env.RESEND_API_KEY;
  const to = String(process.env.NOTIFY_EMAIL || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!key || !to.length) return { ok: false, error: 'Alerts are not set up yet. Add RESEND_API_KEY and NOTIFY_EMAIL in Railway.' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Page Smart Solutions <onboarding@resend.dev>',
        to, subject, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('Alert email failed:', r.status, body.slice(0, 300));
      let msg = body;
      try { msg = JSON.parse(body).message || body; } catch (e) { /* keep raw */ }
      return { ok: false, error: `Resend refused it (${r.status}): ${String(msg).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('Alert email failed:', e.message);
    return { ok: false, error: 'Could not reach Resend: ' + e.message };
  }
}
function notifyInquiry(inq, baseUrl) {
  const text = `New message from your website\n\nName: ${inq.name}\nPhone: ${inq.phone || 'not given'}\nEmail: ${inq.email || 'not given'}\nNeeds: ${inq.service || 'not specified'}\nPrefers: ${inq.preferred || 'any'}\n\n${inq.message}\n\nOpen your inbox: ${baseUrl}/admin#/inbox`;
  return sendAlert(`New inquiry from ${inq.name}`, text, inq.email || undefined);
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
  const UA = { 'User-Agent': 'PageSmartSolutionsAdmin/1.0' };
  const getJson = async (url, opt = {}) => {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const geocoders = [
    async q => { const hit = (await getJson('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: UA }))[0]; return hit ? [hit.lon, hit.lat] : null; },
    async q => { const f = ((await getJson('https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q), { headers: UA })).features || [])[0]; return f ? f.geometry.coordinates : null; },
  ];
  const geocode = async place => {
    const key = place.trim().toLowerCase();
    if (geoCache.has(key)) return geoCache.get(key);
    const noUnit = place.replace(/[,\s]+(apt|apartment|unit|suite|ste|bldg|building|#)\.?\s*[\w-]+/ig, '').replace(/\s+#\s*[\w-]+/g, '');
    const variants = [...new Set([place.trim(), noUnit.trim()])];
    for (const v of variants) {
      for (const g of geocoders) {
        try { const pt = await g(v); if (pt) { geoCache.set(key, pt); return pt; } } catch (e) { console.error('geocode failed:', e.message); }
      }
    }
    return null;
  };
  const routers = [
    (a, b) => `https://router.project-osrm.org/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=false`,
    (a, b) => `https://routing.openstreetmap.de/routed-car/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=false`,
  ];

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
    notifyInquiry(inq, `${req.protocol}://${req.get('host')}`);
    res.json({ ok: true });
  }));

  app.post('/api/login', limiter(20, 10 * 60 * 1000), ah(async (req, res) => {
    const username = str(req.body && req.body.username, 60).toLowerCase() || 'admin';
    const given = String((req.body && req.body.password) || '');
    const u = (await q('SELECT * FROM users WHERE lower(username)=$1', [username])).rows[0];
    let good = false;
    if (u && u.active) {
      good = await checkPassword(given, u.password_hash);
      // Recovery: the ADMIN_PASSWORD set in Railway always opens the first admin account.
      if (!good && PASSWORD && u.id === (await ownerId()) && safeEqual(given, PASSWORD)) good = true;
    } else {
      await checkPassword(given, 'scrypt$00$00'); // keep timing similar when the username is unknown
    }
    if (!good) return res.status(401).json({ error: 'Wrong username or password.' });
    res.set('Set-Cookie', sessionCookie(req, makeToken(u), SESSION_MS / 1000));
    res.json({ ok: true, user: publicUser(u) });
  }));
  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Customer-facing invoice by private link (no login). The token is 128 random bits.
  app.get('/i/:token', (req, res) => { res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }); sendWeb('print.html', res); });
  app.get('/api/public/invoice/:token', limiter(60, 60 * 1000), ah(async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) throw httpError(404, 'Invoice not found');
    const inv = (await q('SELECT * FROM invoices WHERE public_token=$1', [token])).rows[0];
    if (!inv) throw httpError(404, 'Invoice not found');
    const c = inv.customer_id ? (await q('SELECT name, address, phone, email FROM customers WHERE id=$1', [inv.customer_id])).rows[0] : null;
    const s = await getSettings();
    res.set('Cache-Control', 'no-store');
    res.json({
      invoice: {
        number: inv.number, issue_date: inv.issue_date, due_date: inv.due_date, status: inv.status, paid_date: inv.paid_date, payment_method: inv.payment_method,
        items: inv.items, subtotal: inv.subtotal, discount: inv.discount, tax_rate: inv.tax_rate, tax: inv.tax, total: inv.total, notes: inv.notes, customer: c,
      },
      settings: {
        business_name: s.business_name, business_tagline: s.business_tagline, business_address: s.business_address,
        business_phone: s.business_phone, business_phone_2: s.business_phone_2, business_email: s.business_email, payment_instructions: s.payment_instructions,
      },
    });
  }));

  // Everything below needs the admin login
  app.use('/api', requireAuth, roleGate);
  app.get('/api/me', (req, res) => res.json({ ok: true, user: publicUser(req.user), caps: capsFor(req.user.role) }));
  app.post('/api/me/password', limiter(10, 10 * 60 * 1000), ah(async (req, res) => {
    const { current, next } = req.body || {};
    if (!(await checkPassword(current, req.user.password_hash)) && !(req.user.id === (await ownerId()) && PASSWORD && safeEqual(current, PASSWORD))) throw httpError(422, 'Your current password is not right.');
    if (!passwordOk(next)) throw httpError(422, 'The new password needs at least 8 characters.');
    const hash = await hashPassword(next);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    // Keep this browser signed in with the new password
    res.set('Set-Cookie', sessionCookie(req, makeToken({ ...req.user, password_hash: hash }), SESSION_MS / 1000));
    res.json({ ok: true });
  }));

  // Team members (admin only), plus a names-only list everyone can use to schedule jobs
  app.get('/api/team', ah(async (req, res) => res.json((await q('SELECT id, name, username, role FROM users WHERE active ORDER BY lower(name), id')).rows.map(u => ({ id: u.id, name: u.name || u.username, role: u.role })))));
  const userBody = async (b, existing) => {
    const username = str(b.username, 30).toLowerCase();
    if (!USERNAME_RE.test(username)) throw httpError(422, 'Username must be 3 to 30 letters, numbers, dots, dashes or underscores.');
    if (!ROLES.includes(b.role)) throw httpError(422, 'Pick a role.');
    if (!str(b.name)) throw httpError(422, 'Name is required.');
    return { username, name: str(b.name, 100), role: b.role, phone: str(b.phone, 40), active: b.active !== false && b.active !== 'false' };
  };
  const otherAdmins = async id => (await q("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1", [id])).rows[0].n;
  app.get('/api/users', ah(async (req, res) => res.json((await q('SELECT * FROM users ORDER BY active DESC, lower(name), id')).rows.map(publicUser))));
  app.post('/api/users', ah(async (req, res) => {
    const f = await userBody(req.body);
    if (!passwordOk(req.body.password)) throw httpError(422, 'Set a password of at least 8 characters.');
    const r = await q('INSERT INTO users(username,name,role,phone,active,password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [f.username, f.name, f.role, f.phone, f.active, await hashPassword(req.body.password)]);
    res.json(publicUser(r.rows[0]));
  }));
  app.put('/api/users/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const cur = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!cur) throw httpError(404, 'Not found');
    const f = await userBody({ username: cur.username, ...req.body }, cur);
    if (cur.role === 'admin' && cur.active && (f.role !== 'admin' || !f.active) && !(await otherAdmins(id))) throw httpError(422, 'There must always be at least one active admin.');
    if (id === req.user.id && (!f.active || f.role !== 'admin')) throw httpError(422, 'You cannot lock yourself out. Ask another admin to change your own role.');
    if (req.body.password) {
      if (!passwordOk(req.body.password)) throw httpError(422, 'The new password needs at least 8 characters.');
      await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(req.body.password), id]);
    }
    const r = await q('UPDATE users SET username=$1,name=$2,role=$3,phone=$4,active=$5 WHERE id=$6 RETURNING *', [f.username, f.name, f.role, f.phone, f.active, id]);
    res.json(publicUser(r.rows[0]));
  }));
  app.delete('/api/users/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const cur = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!cur) throw httpError(404, 'Not found');
    if (id === req.user.id) throw httpError(422, 'You cannot delete your own account.');
    if (cur.role === 'admin' && cur.active && !(await otherAdmins(id))) throw httpError(422, 'There must always be at least one active admin.');
    await q('DELETE FROM users WHERE id=$1', [id]);
    res.json({ ok: true });
  }));
  app.post('/api/notify-test', limiter(5, 60 * 1000), ah(async (req, res) => {
    const r = await sendAlert('Test alert from Page Smart Solutions', 'If you can read this, new contact form messages will reach you here.');
    res.json(r);
  }));

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
      (SELECT i.status FROM invoices i WHERE i.order_id = o.id ORDER BY i.id DESC LIMIT 1) AS invoice_status,
      COALESCE((SELECT jsonb_agg(a.user_id ORDER BY a.user_id) FROM job_assignments a WHERE a.order_id = o.id), '[]'::jsonb) AS assignee_ids
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id`;
  const withTotal = o => ({
    ...o,
    assignee_ids: typeof o.assignee_ids === 'string' ? JSON.parse(o.assignee_ids) : (o.assignee_ids || []),
    total: r2((o.items || []).reduce((sum, it) => sum + lineTotal(it), 0)),
  });
  // Employees only see jobs they are assigned to. Admin and accounting see everything.
  const MINE = 'EXISTS (SELECT 1 FROM job_assignments m WHERE m.order_id = o.id AND m.user_id = ';
  const scoped = (user, where = '', params = []) => (user.role === 'employee'
    ? { where: (where ? where + ' AND ' : ' WHERE ') + MINE + '$' + (params.length + 1) + ')', params: [...params, user.id] }
    : { where, params });
  const timeOr = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
  const orderBody = b => {
    const items = normalizeItems(b.items);
    const dur = intOrNull(b.duration_minutes);
    return [intOrNull(b.customer_id), str(b.title, 200), ORDER_STATUS.includes(b.status) ? b.status : 'Requested', dateOr(b.service_date), JSON.stringify(items), str(b.notes, 2000), intOrNull(b.one_way_minutes), str(b.from_addr, 300), b.one_way_miles === '' || b.one_way_miles == null ? null : Math.max(0, Math.round(Number(b.one_way_miles) * 10) / 10) || null,
      timeOr(b.start_time), dur ? Math.min(1440, Math.max(15, dur)) : null];
  };
  const setAssignees = async (orderId, ids) => {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
    const valid = wanted.length ? (await q('SELECT id FROM users WHERE active AND id = ANY($1::int[])', [wanted])).rows.map(r => r.id) : [];
    await q('DELETE FROM job_assignments WHERE order_id=$1', [orderId]);
    for (const uid of valid) await q('INSERT INTO job_assignments(order_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [orderId, uid]);
  };
  app.get('/api/orders', ah(async (req, res) => {
    const s = scoped(req.user);
    res.json((await q(ORDER_SELECT + s.where + ' ORDER BY o.service_date DESC, o.start_time DESC, o.id DESC', s.params)).rows.map(withTotal));
  }));
  app.post('/api/orders', ah(async (req, res) => {
    const r = await q('INSERT INTO orders(customer_id,title,status,service_date,items,notes,one_way_minutes,from_addr,one_way_miles,start_time,duration_minutes,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) RETURNING id', [...orderBody(req.body), req.user.id]);
    const id = r.rows[0].id;
    // Employees can only add jobs for themselves. Admin and accounting choose the crew.
    await setAssignees(id, CAPS.assign.includes(req.user.role) ? req.body.assignee_ids : [req.user.id]);
    res.json(withTotal((await q(ORDER_SELECT + ' WHERE o.id=$1', [id])).rows[0]));
  }));
  app.put('/api/orders/:id', ah(async (req, res) => {
    const id = Number(req.params.id);
    const s = scoped(req.user, ' WHERE o.id=$1', [id]);
    if (!(await q('SELECT o.id FROM orders o' + s.where, s.params)).rows[0]) throw httpError(404, 'Not found');
    await q('UPDATE orders SET customer_id=$1,title=$2,status=$3,service_date=$4,items=$5::jsonb,notes=$6,one_way_minutes=$7,from_addr=$8,one_way_miles=$9,start_time=$10,duration_minutes=$11 WHERE id=$12', [...orderBody(req.body), id]);
    if (CAPS.assign.includes(req.user.role) && Array.isArray(req.body.assignee_ids)) await setAssignees(id, req.body.assignee_ids);
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
      from_addr: o.from_addr, one_way_miles: o.one_way_miles, one_way_minutes: o.one_way_minutes,
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
      `UPDATE invoices SET customer_id=$1, order_id=$2, issue_date=$3, due_date=$4, items=$5::jsonb, subtotal=$6, discount=$7, tax_rate=$8, tax=$9, total=$10, status=$11, paid_date=$12, payment_method=$13, notes=$14, from_addr=$15, one_way_miles=$16, one_way_minutes=$17 WHERE id=$18 RETURNING id`,
      [f.customer_id, f.order_id, f.issue_date, f.due_date, JSON.stringify(f.items), f.subtotal, f.discount, f.tax_rate, f.tax, f.total, f.status, f.paid_date, f.payment_method, f.notes, f.from_addr, f.one_way_miles, f.one_way_minutes, Number(req.params.id)]
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
  // Address suggestions: Google Places when GOOGLE_MAPS_API_KEY is set, free OpenStreetMap (Photon) otherwise.
  async function googleSuggest(input) {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY },
      body: JSON.stringify({
        input, includedRegionCodes: ['us'], includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
        locationBias: { circle: { center: { latitude: 30.63, longitude: -97.68 }, radius: 50000 } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error('google ' + r.status);
    const data = await r.json();
    return (data.suggestions || []).map(x => x.placePrediction && x.placePrediction.text && x.placePrediction.text.text).filter(Boolean).map(t => t.replace(/, USA$/, ''));
  }
  async function photonSuggest(input) {
    const r = await fetch('https://photon.komoot.io/api/?limit=6&lang=en&lat=30.63&lon=-97.68&q=' + encodeURIComponent(input), { headers: { 'User-Agent': 'PageSmartSolutionsAdmin/1.0' }, signal: AbortSignal.timeout(5000) });
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
    return out;
  }
  app.get('/api/address', ah(async (req, res) => {
    const input = String(req.query.q || '').trim().slice(0, 150);
    if (input.length < 3) return res.json([]);
    if (process.env.GOOGLE_MAPS_API_KEY) {
      try { return res.json(await googleSuggest(input)); } catch (e) { console.error('Google address lookup failed:', e.message); }
    }
    try { res.json(await photonSuggest(input)); } catch (e) { res.json([]); }
  }));

  app.get('/api/distance', ah(async (req, res) => {
    const from = String(req.query.from || '').slice(0, 300);
    const to = String(req.query.to || '').slice(0, 300);
    if (!from || !to) throw httpError(400, 'Both a starting address and a destination are needed.');
    const a = await geocode(from);
    if (!a) throw httpError(422, `Could not find the starting address "${from}". Pick it from the suggestions or add the city and state.`);
    const b = await geocode(to);
    if (!b) throw httpError(422, `Could not find the customer address "${to}". Pick it from the suggestions or add the city and state.`);
    for (const url of routers) {
      try {
        const route = (await getJson(url(a, b))).routes?.[0];
        if (route) return res.json({ miles: Math.round((route.distance / 1609.344) * 10) / 10, minutes: Math.max(1, Math.round(route.duration / 60)) });
      } catch (e) { console.error('routing failed:', e.message); }
    }
    throw httpError(422, 'Found both addresses but the driving route service did not answer. Try again in a moment, or type the miles yourself.');
  }));

  app.get('/api/dashboard', ah(async (req, res) => {
    const s = await getSettings();
    const today = todayStr(s);
    const year = Number(today.slice(0, 4));
    const s2 = scoped(req.user, " WHERE o.status IN ('Requested','Scheduled','In progress','Completed')");
    const orders = (await q(ORDER_SELECT + s2.where + ' ORDER BY o.service_date ASC, o.start_time ASC, o.id ASC', s2.params)).rows.map(withTotal);
    // Employees only get their own jobs. Money figures need the invoices permission, profit and tax need the financial permission.
    if (!CAPS.invoices.includes(req.user.role)) {
      return res.json({ today, year, orders: orders.slice(0, 8), openOrders: orders.length, unpaid: [], inquiries: [], outstanding: 0, outstandingCount: 0, overdueCount: 0, draftTotal: 0, paidYtd: null, profitYtd: null, setAside: null });
    }
    const invoices = (await q(INVOICE_SELECT)).rows;
    const sum = list => r2(list.reduce((t, i) => t + i.total, 0));
    const sent = invoices.filter(i => i.status === 'Sent');
    const overdue = sent.filter(i => i.due_date && i.due_date < today);
    const fin = CAPS.financial.includes(req.user.role) ? await taxReport(year) : null;
    const inquiries = (await q("SELECT * FROM inquiries WHERE status = 'New' ORDER BY created_at DESC LIMIT 10")).rows;
    res.json({
      today, year,
      outstanding: sum(sent), outstandingCount: sent.length, overdueCount: overdue.length,
      draftTotal: sum(invoices.filter(i => i.status === 'Draft')),
      paidYtd: fin ? fin.inputs.revenue : r2(invoices.filter(i => i.status === 'Paid' && (i.paid_date || '').startsWith(String(year))).reduce((t, i) => t + i.total - i.tax, 0)),
      profitYtd: fin ? fin.result.netProfit : null, setAside: fin ? fin.result.sideTotalTax : null,
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
  await ensureOwner();
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
