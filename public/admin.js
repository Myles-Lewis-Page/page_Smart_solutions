(() => {
'use strict';

/* ---------- constants ---------- */
const ORDER_STATUS = ['Requested', 'Scheduled', 'In progress', 'Completed', 'Invoiced', 'Cancelled'];
const OPEN_STATUS = ['Requested', 'Scheduled', 'In progress', 'Completed'];
const INVOICE_STATUS = ['Draft', 'Sent', 'Paid', 'Void'];
const PAY_METHODS = ['Venmo', 'Zelle', 'Cash', 'Check', 'Card', 'Other'];
const BILLING = ['Hourly', 'Flat', 'Device', 'Custom'];
const EXPENSE_CATEGORIES = ['Equipment & parts', 'Software & subscriptions', 'Tools', 'Supplies', 'Advertising & website', 'Insurance & licenses', 'Education & training', 'Phone & internet', 'Vehicle (not mileage)', 'Professional fees', 'Other'];
const NAV = [
  ['dashboard', 'Dashboard'], ['inbox', 'Inbox'], ['jobs', 'Jobs'], ['invoices', 'Invoices'], ['customers', 'Customers'],
  ['expenses', 'Expenses'], ['mileage', 'Mileage'], ['financial', 'Financial'], ['services', 'Services'], ['settings', 'Settings'],
];
const CHIP = {
  Requested: 'info', Scheduled: 'info', 'In progress': 'warn', Completed: 'ok', Invoiced: 'accent', Cancelled: '',
  Draft: '', Sent: 'info', Paid: 'ok', Void: '', Overdue: 'danger', New: 'warn', Read: 'info', Done: 'ok',
};

/* ---------- state and helpers ---------- */
const state = { settings: {}, services: [], customers: [], orders: [], invoices: [], inquiries: [], expenses: [], mileage: { rates: [], trips: [] } };
const ui = { year: new Date().getFullYear(), view: 'dashboard' };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const num = v => Number(v) || 0;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const todayStr = () => new Date().toLocaleDateString('en-CA');
const fmtDate = d => { const p = String(d || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}/${p[0]}` : ''; };
const fmtStamp = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const chip = (text, cls) => `<span class="chip ${cls ?? CHIP[text] ?? ''}">${esc(text)}</span>`;
const opts = (list, selected) => list.map(v => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
const sumItems = items => r2(items.reduce((s, it) => s + r2(num(it.rate) * num(it.qty)), 0));
const findBy = (list, id) => list.find(x => x.id === Number(id));
const isOverdue = i => i.status === 'Sent' && i.due_date && i.due_date < todayStr();
const invStatus = i => (isOverdue(i) ? 'Overdue' : i.status);

let toastTimer;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'err' ? 5000 : 2600);
}

async function api(path, opt = {}) {
  const res = await fetch('/api' + path, {
    method: opt.method || 'GET',
    headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('auth'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const guard = fn => async (...args) => {
  try { await fn(...args); } catch (e) { if (e.message !== 'auth') toast(e.message, 'err'); }
};

function downloadCsv(name, header, rows) {
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = [header, ...rows].map(r => r.map(cell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- data loading ---------- */
const FETCH = {
  settings: async () => { state.settings = await api('/settings'); },
  services: async () => { state.services = await api('/services'); },
  customers: async () => { state.customers = await api('/customers'); },
  orders: async () => { state.orders = await api('/orders'); },
  invoices: async () => { state.invoices = await api('/invoices'); },
  inquiries: async () => { state.inquiries = await api('/inquiries'); },
  expenses: async () => { state.expenses = await api('/expenses'); },
  mileage: async () => { state.mileage = await api('/mileage'); },
};
const reload = (...keys) => Promise.all((keys.length ? keys : Object.keys(FETCH)).map(k => FETCH[k]()));

/* ---------- dialogs ---------- */
const dlg = $('#dlg');
const dlg2 = $('#dlg2');
function openDialog(el, html) { el.innerHTML = html; if (!el.open) el.showModal(); }
function closeDialog(el) { if (el.open) el.close(); }
// Dialogs close only from their own Close, X or Save buttons, never from a stray click or the Escape key.
[dlg, dlg2].forEach(d => d.addEventListener('cancel', e => e.preventDefault()));

function confirmDelete(btn, fn) {
  btn.addEventListener('click', guard(async () => {
    if (btn.dataset.armed) { await fn(); return; }
    btn.dataset.armed = '1';
    const label = btn.textContent;
    btn.textContent = 'Click again to confirm';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 4000);
  }));
}

/* ---------- travel ---------- */
function travelCharge(oneWay, s) {
  const free = num(s.travel_free_minutes);
  const rate = num(s.travel_rate);
  const step = num(s.travel_round_minutes) || 30;
  if (!(oneWay > 0) || oneWay <= free) return { free: true, minutes: 0, hours: 0, amount: 0 };
  const minutes = Math.max(step, Math.round((oneWay * 2) / step) * step);
  return { free: false, minutes, hours: minutes / 60, amount: r2((rate * minutes) / 60) };
}
function travelItem(oneWay) {
  const t = travelCharge(oneWay, state.settings);
  return t.free
    ? { desc: `Travel (${oneWay} min each way, no charge)`, billing: 'Flat', rate: 0, qty: 1, kind: 'travel' }
    : { desc: `Travel (${oneWay} min each way, ${t.minutes} min billed)`, billing: 'Hourly', rate: num(state.settings.travel_rate), qty: t.hours, kind: 'travel' };
}
function travelHint(minutes) {
  const t = travelCharge(num(minutes), state.settings);
  if (!num(minutes)) return `Free within ${state.settings.travel_free_minutes} min one way.`;
  return t.free ? 'Within the free range, no charge.' : `Round trip billed ${t.minutes} min at ${money(state.settings.travel_rate)}/hr = ${money(t.amount)}`;
}

/* ---------- line item editor ---------- */
function createItemEditor(root, items, onChange) {
  const rowHtml = (it, i) => `
    <div class="item" data-i="${i}">
      <input data-f="desc" value="${esc(it.desc)}" aria-label="Description" placeholder="Description">
      <select data-f="billing" aria-label="Billing type">${opts(BILLING, it.billing)}</select>
      <input data-f="rate" type="number" step="0.01" min="0" value="${esc(it.rate)}" aria-label="Rate">
      <input data-f="qty" type="number" step="any" min="0" value="${esc(it.qty)}" aria-label="Quantity or hours">
      <output>${money(r2(num(it.rate) * num(it.qty)))}</output>
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove line">&times;</button>
    </div>`;
  function render() {
    const groups = {};
    state.services.filter(s => s.active).forEach(s => (groups[s.category] = groups[s.category] || []).push(s));
    root.innerHTML = `<div class="items">
      <div class="items-head"><span>Description</span><span>Billing</span><span>Rate</span><span>Qty / hrs</span><span>Total</span><span></span></div>
      ${items.length ? items.map(rowHtml).join('') : '<p class="empty-note">No line items yet. Add a service below.</p>'}
      <select class="add-service" aria-label="Add a service">
        <option value="">+ Add a service</option>
        ${Object.entries(groups).map(([c, list]) => `<optgroup label="${esc(c)}">${list.map(s => `<option value="${s.id}">${esc(s.name)}${s.price != null ? ' (' + money(s.price) + ')' : ''}</option>`).join('')}</optgroup>`).join('')}
        <option value="custom">Custom line item</option>
      </select></div>`;
  }
  root.addEventListener('input', e => {
    const row = e.target.closest('.item');
    const f = e.target.dataset && e.target.dataset.f;
    if (!row || !f) return;
    const it = items[Number(row.dataset.i)];
    it[f] = f === 'rate' || f === 'qty' ? num(e.target.value) : e.target.value;
    $('output', row).textContent = money(r2(num(it.rate) * num(it.qty)));
    if (onChange) onChange();
  });
  root.addEventListener('change', e => {
    if (!e.target.classList.contains('add-service') || !e.target.value) return;
    if (e.target.value === 'custom') items.push({ desc: '', billing: 'Flat', rate: 0, qty: 1, kind: 'custom' });
    else {
      const s = findBy(state.services, e.target.value);
      items.push({ desc: s.name, billing: s.billing, rate: s.price || 0, qty: 1, kind: 'service', service_id: s.id });
    }
    render();
    if (onChange) onChange();
    const inputs = $$('.item [data-f="desc"]', root);
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  root.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    items.splice(Number(rm.dataset.rm), 1);
    render();
    if (onChange) onChange();
  });
  render();
  return { render, add(item) { items.push(item); render(); if (onChange) onChange(); } };
}

const customerOptions = selected => `<option value="">No customer</option>` +
  state.customers.map(c => `<option value="${c.id}"${Number(selected) === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

/* ---------- filters on list tables ---------- */
function applyFilter(root, id) {
  const q = ($(`input[data-filter="${id}"]`, root) || { value: '' }).value.toLowerCase().trim();
  const sel = $(`select[data-filter="${id}"]`, root);
  const g = sel ? sel.value : '';
  let shown = 0;
  $$(`#${id} tbody tr[data-row]`, root).forEach(tr => {
    const ok = (!q || tr.dataset.text.includes(q)) && (!g || tr.dataset.tags.split(' ').includes(g));
    tr.hidden = !ok;
    if (ok) shown++;
  });
  const empty = $(`#${id}-empty`, root);
  if (empty) empty.hidden = shown > 0;
}
function wireFilters(root) {
  $$('[data-filter]', root).forEach(ctl => {
    ctl.addEventListener('input', () => applyFilter(root, ctl.dataset.filter));
    applyFilter(root, ctl.dataset.filter);
  });
}
const yearOptions = () => {
  const years = new Set([new Date().getFullYear(), ui.year]);
  state.expenses.forEach(e => e.date && years.add(Number(e.date.slice(0, 4))));
  state.mileage.trips.forEach(t => t.date && years.add(Number(t.date.slice(0, 4))));
  state.invoices.forEach(i => i.paid_date && years.add(Number(i.paid_date.slice(0, 4))));
  return [...years].filter(y => y >= 2025).sort();
};
const yearSelect = () => `<select id="year" aria-label="Year">${yearOptions().map(y => `<option${y === ui.year ? ' selected' : ''}>${y}</option>`).join('')}</select>`;
function wireYear(main) {
  const y = $('#year', main);
  if (y) y.addEventListener('change', () => { ui.year = Number(y.value); route(); });
}

/* ---- Address suggestions while typing ---- */
(() => {
  const style = document.createElement('style');
  style.textContent = '#addr-menu{position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.3);max-height:260px;overflow:auto;padding:4px}#addr-menu[hidden]{display:none}#addr-menu button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--ink);font:inherit;font-size:15px;padding:10px 12px;border-radius:6px;cursor:pointer}#addr-menu button:hover,#addr-menu button[aria-selected=true]{background:var(--accent-soft);color:var(--accent)}';
  style.textContent += '.brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}.brand:hover{color:var(--ink)}.mark{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:8px;background:var(--ink);color:var(--bg);font:600 12px/1 var(--font-mono);letter-spacing:.04em}.brand-name{font:700 17px/1.1 var(--font-display)}';
  document.head.appendChild(style);
  const menu = document.createElement('div');
  menu.id = 'addr-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  let target = null, items = [], active = -1, timer, seq = 0, picking = false;
  const hide = () => { menu.hidden = true; items = []; active = -1; };
  const mark = () => $$('button', menu).forEach((b, i) => b.setAttribute('aria-selected', i === active ? 'true' : 'false'));
  const show = list => {
    items = list; active = -1;
    if (!list.length || !target) { hide(); return; }
    (target.closest('dialog') || document.body).appendChild(menu);
    menu.innerHTML = list.map((v, i) => `<button type="button" role="option" data-i="${i}">${esc(v)}</button>`).join('');
    const r = target.getBoundingClientRect();
    menu.style.left = r.left + 'px'; menu.style.top = (r.bottom + 4) + 'px'; menu.style.width = r.width + 'px';
    menu.hidden = false;
  };
  const pick = i => {
    if (!target || !items[i]) return;
    const t = target;
    picking = true;
    t.value = items[i];
    hide();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    picking = false;
  };
  menu.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('button'); if (b) pick(Number(b.dataset.i)); });
  document.addEventListener('input', e => {
    const t = e.target;
    if (picking || !t.matches || !t.matches('[data-addr]')) return;
    target = t;
    clearTimeout(timer);
    const q = t.value.trim();
    if (q.length < 4) { hide(); return; }
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const res = await api('/address?q=' + encodeURIComponent(q));
        if (mine === seq && document.activeElement === t) show(res);
      } catch (err) { /* suggestions are optional */ }
    }, 250);
  });
  document.addEventListener('keydown', e => {
    if (menu.hidden || !e.target.matches || !e.target.matches('[data-addr]')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; mark(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  document.addEventListener('focusout', e => { if (e.target.matches && e.target.matches('[data-addr]')) { seq++; hide(); } });
  window.addEventListener('resize', hide);
})();

/* =====================================================================
   Views
   ===================================================================== */
const VIEWS = {};

/* ---- Dashboard ---- */
VIEWS.dashboard = async main => {
  const [d] = await Promise.all([api('/dashboard'), reload('inquiries', 'orders', 'invoices')]);
  const jobLi = o => `<li data-act="open-job" data-id="${o.id}"><div class="main"><b>${esc(o.title || 'Untitled job')}</b><span>${esc(o.customer_name || 'No customer')} &middot; ${fmtDate(o.service_date)}</span></div>${chip(o.status)}</li>`;
  const invLi = i => `<li data-act="open-invoice" data-id="${i.id}"><div class="main"><b>${esc(i.customer_name || 'No customer')}</b><span>${esc(i.number)} &middot; due ${fmtDate(i.due_date) || 'on receipt'}</span></div><span class="num">${money(i.total)}</span></li>`;
  const inqLi = q => `<li data-act="open-inquiry" data-id="${q.id}"><div class="main"><b>${esc(q.name)}</b><span>${esc(q.service || 'General question')} &middot; ${fmtStamp(q.created_at)}</span></div>${chip('New')}</li>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p class="sub">${esc(state.settings.business_name)} &middot; ${d.year} year to date</p></div>
      <div class="head-actions"><button class="btn primary" data-act="new-job">New job</button><button class="btn" data-act="new-expense">Add expense</button></div></div>
    <div class="tiles">
      <div class="tile${d.overdueCount ? ' bad' : ''}"><div class="k">Waiting on payment</div><div class="v">${money(d.outstanding)}</div><div class="s">${d.outstandingCount} sent${d.overdueCount ? `, ${d.overdueCount} overdue` : ''}</div></div>
      <div class="tile"><div class="k">Paid this year</div><div class="v">${money(d.paidYtd)}</div><div class="s">Cash received, before sales tax</div></div>
      <div class="tile"><div class="k">Net profit</div><div class="v">${money(d.profitYtd)}</div><div class="s">After expenses and mileage</div></div>
      <div class="tile warn"><div class="k">Set aside for tax</div><div class="v">${money(d.setAside)}</div><div class="s">Estimated, side business only</div></div>
      <div class="tile"><div class="k">Open jobs</div><div class="v">${d.openOrders}</div><div class="s">${money(d.draftTotal)} in drafts</div></div>
    </div>
    <div class="cols">
      <section class="panel"><h2>New messages</h2>${d.inquiries.length ? `<ul class="list">${d.inquiries.map(inqLi).join('')}</ul>` : '<p class="empty">No new messages from the contact form.</p>'}</section>
      <section class="panel"><h2>Open jobs</h2>${d.orders.length ? `<ul class="list">${d.orders.map(jobLi).join('')}</ul>` : '<p class="empty">No open jobs.</p>'}</section>
      <section class="panel"><h2>Waiting on payment</h2>${d.unpaid.length ? `<ul class="list">${d.unpaid.map(invLi).join('')}</ul>` : '<p class="empty">Nothing waiting on payment.</p>'}</section>
    </div>`;
  updateBadge();
};

/* ---- Inbox ---- */
VIEWS.inbox = async main => {
  await reload('inquiries');
  main.innerHTML = `
    <div class="page-head"><div><h1>Inbox</h1><p class="sub">Messages from the contact form on your site.</p></div></div>
    <div class="table-wrap"><table id="inbox-table"><thead><tr><th>Received</th><th>Name</th><th>Contact</th><th>Needs</th><th>Message</th><th>Status</th></tr></thead><tbody>
      ${state.inquiries.map(q => `<tr data-row data-act="open-inquiry" data-id="${q.id}" data-text="" data-tags=""><td class="muted">${fmtStamp(q.created_at)}</td><td><b>${esc(q.name)}</b></td><td>${esc(q.phone || q.email)}</td><td>${esc(q.service)}</td><td class="clip muted">${esc(q.message)}</td><td>${chip(q.status)}</td></tr>`).join('')}
    </tbody></table>${state.inquiries.length ? '' : '<p class="empty">No messages yet. They will show up here when someone uses the contact form.</p>'}</div>`;
  updateBadge();
};

/* ---- Jobs ---- */
VIEWS.jobs = async main => {
  await reload('orders', 'customers', 'services', 'invoices');
  const tag = o => ['all', o.status.toLowerCase().replace(/ /g, '-'), OPEN_STATUS.includes(o.status) ? 'open' : ''].join(' ');
  main.innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p class="sub">Every visit and project, from first request to paid.</p></div>
      <div class="head-actions"><button class="btn" data-act="csv-jobs">Export CSV</button><button class="btn primary" data-act="new-job">New job</button></div></div>
    <div class="toolbar">
      <input type="search" class="grow" placeholder="Search customer or job" data-filter="jobs-table" aria-label="Search jobs">
      <select data-filter="jobs-table" aria-label="Filter by status"><option value="open">Open jobs</option><option value="all">All jobs</option>${ORDER_STATUS.map(s => `<option value="${s.toLowerCase().replace(/ /g, '-')}">${s}</option>`).join('')}</select>
    </div>
    <div class="table-wrap"><table id="jobs-table"><thead><tr><th>Date</th><th>Customer</th><th>Job</th><th>Status</th><th class="num">Total</th><th>Invoice</th></tr></thead><tbody>
      ${state.orders.map(o => `<tr data-row data-act="open-job" data-id="${o.id}" data-tags="${tag(o)}" data-text="${esc((o.customer_name + ' ' + o.title).toLowerCase())}"><td class="muted">${fmtDate(o.service_date)}</td><td><b>${esc(o.customer_name || 'No customer')}</b></td><td>${esc(o.title)}</td><td>${chip(o.status)}</td><td class="num">${money(o.total)}</td><td>${o.invoice_status ? chip(o.invoice_status) : ''}</td></tr>`).join('')}
    </tbody></table><p class="empty" id="jobs-table-empty" hidden>No jobs match.</p></div>`;
  wireFilters(main);
};

/* ---- Invoices ---- */
VIEWS.invoices = async main => {
  await reload('invoices', 'customers', 'services', 'orders');
  const tag = i => ['all', i.status.toLowerCase(), isOverdue(i) ? 'overdue' : ''].join(' ');
  main.innerHTML = `
    <div class="page-head"><div><h1>Invoices</h1><p class="sub">Invoices and receipts. Open one to print it or save it as a PDF.</p></div>
      <div class="head-actions"><button class="btn" data-act="csv-invoices">Export CSV</button><button class="btn primary" data-act="new-invoice">New invoice</button></div></div>
    <div class="toolbar">
      <input type="search" class="grow" placeholder="Search number or customer" data-filter="inv-table" aria-label="Search invoices">
      <select data-filter="inv-table" aria-label="Filter by status"><option value="all">All invoices</option><option value="draft">Draft</option><option value="sent">Sent</option><option value="overdue">Overdue</option><option value="paid">Paid</option><option value="void">Void</option></select>
    </div>
    <div class="table-wrap"><table id="inv-table"><thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
      ${state.invoices.map(i => `<tr data-row data-act="open-invoice" data-id="${i.id}" data-tags="${tag(i)}" data-text="${esc((i.number + ' ' + (i.customer_name || '')).toLowerCase())}"><td><b>${esc(i.number)}</b></td><td>${esc(i.customer_name || 'No customer')}</td><td class="muted">${fmtDate(i.issue_date)}</td><td class="muted">${fmtDate(i.due_date)}</td><td>${chip(invStatus(i))}</td><td class="num">${money(i.total)}</td></tr>`).join('')}
    </tbody></table><p class="empty" id="inv-table-empty" hidden>No invoices match.</p></div>`;
  wireFilters(main);
};

/* ---- Customers ---- */
VIEWS.customers = async main => {
  await reload('customers', 'orders', 'invoices');
  const stats = id => ({
    jobs: state.orders.filter(o => o.customer_id === id).length,
    paid: r2(state.invoices.filter(i => i.customer_id === id && i.status === 'Paid').reduce((s, i) => s + i.total, 0)),
  });
  main.innerHTML = `
    <div class="page-head"><div><h1>Customers</h1><p class="sub">Contact details and service addresses.</p></div>
      <div class="head-actions"><button class="btn" data-act="csv-customers">Export CSV</button><button class="btn primary" data-act="new-customer">New customer</button></div></div>
    <div class="toolbar"><input type="search" class="grow" placeholder="Search name, phone, or address" data-filter="cust-table" aria-label="Search customers"></div>
    <div class="table-wrap"><table id="cust-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Address</th><th class="num">Jobs</th><th class="num">Paid</th></tr></thead><tbody>
      ${state.customers.map(c => { const s = stats(c.id); return `<tr data-row data-act="open-customer" data-id="${c.id}" data-tags="" data-text="${esc((c.name + ' ' + c.phone + ' ' + c.address + ' ' + c.email).toLowerCase())}"><td><b>${esc(c.name)}</b></td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td class="clip">${esc(c.address)}</td><td class="num">${s.jobs}</td><td class="num">${money(s.paid)}</td></tr>`; }).join('')}
    </tbody></table>${state.customers.length ? '<p class="empty" id="cust-table-empty" hidden>No customers match.</p>' : '<p class="empty">No customers yet. Add your first one.</p>'}</div>`;
  wireFilters(main);
};

/* ---- Expenses ---- */
VIEWS.expenses = async main => {
  await reload('expenses', 'customers');
  const list = state.expenses.filter(e => (e.date || '').startsWith(String(ui.year)));
  const total = r2(list.reduce((s, e) => s + e.amount, 0));
  const noReceipt = list.filter(e => !e.receipts.length).length;
  const byCat = {};
  list.forEach(e => { byCat[e.category] = r2((byCat[e.category] || 0) + e.amount); });
  main.innerHTML = `
    <div class="page-head"><div><h1>Expenses</h1><p class="sub">Purchases for the business, with receipts attached.</p></div>
      <div class="head-actions">${yearSelect()}<button class="btn" data-act="csv-expenses">Export CSV</button><button class="btn primary" data-act="new-expense">Add expense</button></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Total ${ui.year}</div><div class="v">${money(total)}</div><div class="s">${list.length} expense${list.length === 1 ? '' : 's'}</div></div>
      <div class="tile${noReceipt ? ' warn' : ''}"><div class="k">Missing receipts</div><div class="v">${noReceipt}</div><div class="s">${noReceipt ? 'Attach a photo or PDF' : 'All have receipts'}</div></div>
      ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `<div class="tile"><div class="k">${esc(c)}</div><div class="v">${money(v)}</div></div>`).join('')}
    </div>
    <div class="toolbar"><input type="search" class="grow" placeholder="Search vendor, description, or order number" data-filter="exp-table" aria-label="Search expenses"></div>
    <div class="table-wrap"><table id="exp-table"><thead><tr><th>Date</th><th>Vendor</th><th>Description</th><th>Category</th><th class="num">Amount</th><th>Receipts</th></tr></thead><tbody>
      ${list.map(e => `<tr data-row data-act="open-expense" data-id="${e.id}" data-tags="" data-text="${esc((e.vendor + ' ' + e.description + ' ' + e.reference + ' ' + e.category).toLowerCase())}"><td class="muted">${fmtDate(e.date)}</td><td><b>${esc(e.vendor)}</b></td><td class="clip">${esc(e.description)}</td><td class="muted">${esc(e.category)}</td><td class="num">${money(e.amount)}</td><td>${e.receipts.length ? chip(e.receipts.length + ' attached', 'ok') : chip('None', 'warn')}</td></tr>`).join('')}
    </tbody>${list.length ? `<tfoot><tr><td colspan="4">Total</td><td class="num">${money(total)}</td><td></td></tr></tfoot>` : ''}</table>${list.length ? '<p class="empty" id="exp-table-empty" hidden>No expenses match.</p>' : `<p class="empty">No expenses in ${ui.year} yet.</p>`}</div>`;
  wireYear(main);
  wireFilters(main);
};

/* ---- Mileage ---- */
const rateOn = (date, rates) => { let r = rates.length ? rates[0].rate : 0; rates.forEach(x => { if (x.effective_from <= date) r = x.rate; }); return r; };
VIEWS.mileage = async main => {
  await reload('mileage', 'customers', 'settings');
  const trips = state.mileage.trips.filter(t => (t.date || '').startsWith(String(ui.year)));
  const miles = Math.round(trips.reduce((s, t) => s + t.total_miles, 0) * 10) / 10;
  const ded = r2(trips.reduce((s, t) => s + t.deduction, 0));
  main.innerHTML = `
    <div class="page-head"><div><h1>Mileage</h1><p class="sub">Business trips and the IRS standard mileage deduction. The rate follows the trip date.</p></div>
      <div class="head-actions">${yearSelect()}<button class="btn" data-act="csv-mileage">Export CSV</button><button class="btn primary" data-act="new-trip">Log trip</button></div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Trips ${ui.year}</div><div class="v">${trips.length}</div></div>
      <div class="tile"><div class="k">Business miles</div><div class="v">${miles.toLocaleString()}</div></div>
      <div class="tile"><div class="k">Deduction</div><div class="v">${money(ded)}</div><div class="s">Counts toward Financial</div></div>
    </div>
    <div class="toolbar"><input type="search" class="grow" placeholder="Search customer or place" data-filter="trip-table" aria-label="Search trips"></div>
    <div class="table-wrap"><table id="trip-table"><thead><tr><th>Date</th><th>Customer</th><th>Route</th><th class="num">Miles</th><th class="num">Rate</th><th class="num">Deduction</th></tr></thead><tbody>
      ${trips.map(t => `<tr data-row data-act="open-trip" data-id="${t.id}" data-tags="" data-text="${esc((t.customer_name + ' ' + t.from_addr + ' ' + t.to_addr + ' ' + t.purpose).toLowerCase())}"><td class="muted">${fmtDate(t.date)}</td><td><b>${esc(t.customer_name || '')}</b></td><td class="clip">${esc(t.from_addr)} to ${esc(t.to_addr)}${t.round_trip ? ' (round trip)' : ''}</td><td class="num">${t.total_miles}</td><td class="num">${t.rate.toFixed(3)}</td><td class="num">${money(t.deduction)}</td></tr>`).join('')}
    </tbody>${trips.length ? `<tfoot><tr><td colspan="3">Total</td><td class="num">${miles}</td><td></td><td class="num">${money(ded)}</td></tr></tfoot>` : ''}</table>${trips.length ? '<p class="empty" id="trip-table-empty" hidden>No trips match.</p>' : `<p class="empty">No trips logged for ${ui.year}.</p>`}</div>
    <section class="panel" style="margin-top:20px"><h2>IRS standard mileage rates</h2>
      <div class="body"><p class="hint" style="margin-bottom:12px">Each trip uses the latest rate that started on or before its date. The IRS raised the 2026 rate from 72.5 to 76 cents per mile on July 1, 2026.</p>
      <div id="rates">${state.mileage.rates.map(r => rateRow(r)).join('')}</div>
      <div class="actions" style="justify-content:flex-start;margin-top:8px"><button class="btn small" data-act="add-rate">Add rate</button><button class="btn small primary" data-act="save-rates">Save rates</button></div></div></section>`;
  wireYear(main);
  wireFilters(main);
};
const rateRow = r => `<div class="grid3 rate-row" style="grid-template-columns:1fr 1fr auto;margin-bottom:8px;align-items:end"><label>Effective from<input type="date" data-r="date" value="${esc(r ? r.effective_from : '')}"></label><label>Dollars per mile<input type="number" step="0.001" min="0" data-r="rate" value="${esc(r ? r.rate : '')}"></label><button type="button" class="icon-btn" data-act="rm-rate" aria-label="Remove rate">&times;</button></div>`;

/* ---- Financial ---- */
VIEWS.financial = async main => {
  await reload('expenses', 'mileage', 'invoices');
  const t = await api('/tax/' + ui.year);
  const { config: c, inputs: i, result: r } = t;
  const row = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><b>${value}</b></div>`;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const owes = r.balance > 0;
  main.innerHTML = `
    <div class="page-head"><div><h1>Financial</h1><p class="sub">Federal tax estimate for ${ui.year}: your salary plus ${esc(state.settings.business_name)}. Income counts when an invoice is marked paid.</p></div>
      <div class="head-actions">${yearSelect()}</div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Net profit</div><div class="v">${money(r.netProfit)}</div><div class="s">Income less expenses and mileage</div></div>
      <div class="tile warn"><div class="k">Tax on side business</div><div class="v">${money(r.sideTotalTax)}</div><div class="s">${r.setAsidePct}% of profit (income tax + self-employment tax)</div></div>
      <div class="tile"><div class="k">Side business take-home</div><div class="v">${money(r.takeHome)}</div><div class="s">Profit after that tax</div></div>
      <div class="tile${owes ? ' bad' : ''}"><div class="k">${owes ? 'Estimated balance due' : 'Estimated refund'}</div><div class="v">${money(Math.abs(r.balance))}</div><div class="s">All federal tax less ${money(r.withholding)} withheld</div></div>
    </div>
    <div class="fin">
      <section class="panel"><h2>Main job and tax settings</h2>
        <form class="body" id="tax-form" style="display:grid;gap:14px">
          <div class="grid2"><label>Salary (gross, yearly)<input name="salary" type="number" step="0.01" min="0" value="${esc(c.salary)}"></label>
          <label>Federal tax withheld (yearly)<input name="fed_withholding" type="number" step="0.01" min="0" value="${esc(c.fed_withholding)}"></label></div>
          <div class="grid2"><label>Standard deduction<input name="std_deduction" type="number" step="0.01" min="0" value="${esc(c.std_deduction)}"></label>
          <label>Social Security wage base<input name="ss_wage_base" type="number" step="0.01" min="0" value="${esc(c.ss_wage_base)}"></label></div>
          <label class="check"><input type="checkbox" name="qbi_enabled"${c.qbi_enabled ? ' checked' : ''}> Apply the 20% qualified business income deduction</label>
          <p class="hint">Filing status: single. The salary and withholding are yours to enter. Your pay stub or W-2 shows the withholding.</p>
          <div class="actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Save and recalculate</button></div>
        </form></section>
      <section class="panel"><h2>Side business</h2><div class="rows">
        ${row('Income received (paid invoices, before sales tax)', money(i.revenue))}
        ${row('Expenses', '- ' + money(i.expenses))}
        ${row(`Mileage deduction (${i.miles} miles)`, '- ' + money(i.mileageDeduction))}
        ${row('Net profit', money(r.netProfit), 'strong')}
      </div></section>
      <section class="panel"><h2>Self-employment tax</h2><div class="rows">
        ${row('Net earnings from self-employment (92.35% of profit)', money(r.seEarnings))}
        ${row('Self-employment tax (15.3%)', money(r.seTax))}
        ${r.seApplies ? row('Half of it is deductible', '- ' + money(r.halfSe), 'sub') : '<div class="sub"><span>Under $400 of earnings, so no self-employment tax is owed yet.</span></div>'}
      </div></section>
      <section class="panel"><h2>Income tax</h2><div class="rows">
        ${row('Salary', money(r.salary))}
        ${row('Side business profit', money(r.netProfit))}
        ${row('Half of self-employment tax', '- ' + money(r.halfSe))}
        ${row('Adjusted gross income', money(r.agi), 'strong')}
        ${row('Standard deduction', '- ' + money(r.stdDeduction))}
        ${r.qbiDeduction ? row('Qualified business income deduction', '- ' + money(r.qbiDeduction)) : ''}
        ${row('Taxable income', money(r.taxableIncome), 'strong')}
        ${row('Federal income tax', money(r.incomeTax))}
        ${row('From your salary alone', money(r.salaryTax), 'sub')}
        ${row('Added by the side business', money(r.sideIncomeTax), 'sub')}
        ${row('Top bracket you reach', Math.round(r.marginalRate * 100) + '%')}
      </div></section>
      <section class="panel"><h2>What to set aside</h2><div class="rows">
        ${row('Income tax on side business', money(r.sideIncomeTax))}
        ${row('Self-employment tax', money(r.seTax))}
        ${row('Total tax from the side business', money(r.sideTotalTax), 'strong')}
        ${row('Take-home from the side business', money(r.takeHome), 'strong')}
        ${row('Total federal tax (income + self-employment)', money(r.totalTax))}
        ${row('Withheld from your paychecks', '- ' + money(r.withholding))}
        ${row(owes ? 'Estimated balance due' : 'Estimated refund', money(Math.abs(r.balance)), 'strong')}
      </div><p class="note">An estimate for planning, not tax advice. It covers federal income tax and self-employment tax only. Texas has no state income tax. Texas sales tax on your services is separate: check with the Texas Comptroller and set your sales tax rate in Settings.</p></section>
      <details class="panel"><summary>Tax brackets for ${ui.year}</summary><form class="body" id="bracket-form">
        ${c.brackets.map(b => `<div class="bracket-row"><label>Up to<input data-b="upTo" type="number" step="1" min="0" value="${b.upTo == null ? '' : esc(b.upTo)}" ${b.upTo == null ? 'placeholder="No limit" disabled' : ''}></label><label>Rate %<input data-b="rate" type="number" step="0.1" min="0" max="100" value="${esc(Math.round(b.rate * 1000) / 10)}"></label></div>`).join('')}
        <p class="hint">Single filer. These are the 2026 federal brackets. Change them only if the IRS publishes new numbers.</p>
        <div class="actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Save brackets</button></div></form></details>
      <section class="panel" style="grid-column:1/-1"><h2>Month by month</h2><div class="table-wrap" style="border:0;border-radius:0"><table><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Miles</th><th class="num">Mileage deduction</th><th class="num">Net</th></tr></thead><tbody>
        ${t.monthly.map((m, idx) => `<tr><td>${monthNames[idx]}</td><td class="num">${money(m.revenue)}</td><td class="num">${money(m.expenses)}</td><td class="num">${m.miles}</td><td class="num">${money(m.mileage)}</td><td class="num">${money(r2(m.revenue - m.expenses - m.mileage))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="num">${money(i.revenue)}</td><td class="num">${money(i.expenses)}</td><td class="num">${i.miles}</td><td class="num">${money(i.mileageDeduction)}</td><td class="num">${money(r.netProfit)}</td></tr></tfoot></table></div></section>
    </div>`;
  wireYear(main);
  const taxBody = () => {
    const f = $('#tax-form').elements;
    return { salary: f.salary.value, fed_withholding: f.fed_withholding.value, std_deduction: f.std_deduction.value, ss_wage_base: f.ss_wage_base.value, qbi_enabled: f.qbi_enabled.checked, notes: c.notes };
  };
  $('#tax-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    await api('/tax/' + ui.year, { method: 'PUT', body: taxBody() });
    toast('Saved');
    route();
  }));
  $('#bracket-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const rows = $$('.bracket-row', main);
    const brackets = rows.map(r => ({ upTo: $('[data-b="upTo"]', r).value === '' ? null : Number($('[data-b="upTo"]', r).value), rate: num($('[data-b="rate"]', r).value) / 100 }));
    await api('/tax/' + ui.year, { method: 'PUT', body: { ...taxBody(), brackets } });
    toast('Brackets saved');
    route();
  }));
};

/* ---- Services ---- */
const priceCell = s => s.price == null ? esc(s.price_label || 'Quote')
  : `${s.price_label ? `<span class="muted">${esc(s.price_label)}</span> ` : ''}${money(s.price)}${s.billing === 'Hourly' ? ' / hr' : s.billing === 'Device' ? ' / device' : ''}`;
VIEWS.services = async main => {
  await reload('services', 'settings');
  const groups = [];
  state.services.forEach(s => { let g = groups.find(x => x.name === s.category); if (!g) groups.push((g = { name: s.category, items: [] })); g.items.push(s); });
  const st = state.settings;
  main.innerHTML = `
    <div class="page-head"><div><h1>Services</h1><p class="sub">Your price list. Active services show on the public homepage and in the job and invoice pickers.</p></div>
      <div class="head-actions"><a class="btn" href="/#services" target="_blank" rel="noopener">View on site</a><button class="btn primary" data-act="new-service">Add service</button></div></div>
    <div class="panel" style="margin-bottom:20px"><div class="body"><b>Travel:</b> free within ${esc(st.travel_free_minutes)} minutes one way. Beyond that, the round trip is billed at ${money(st.travel_rate)}/hr, rounded to the nearest ${esc(st.travel_round_minutes)} minutes. On-site minimum ${esc(st.onsite_minimum_hours)} hour. <a href="#/settings">Change in Settings</a></div></div>
    <div style="display:grid;gap:20px">
    ${groups.map((g, gi) => `<section><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><h2 class="section-title" style="margin:0">${esc(g.name)}</h2><button type="button" class="icon-btn" style="width:32px;height:32px;font-size:15px" data-act="grp-up" data-cat="${esc(g.name)}" aria-label="Move group up"${gi === 0 ? ' disabled' : ''}>&uarr;</button><button type="button" class="icon-btn" style="width:32px;height:32px;font-size:15px" data-act="grp-down" data-cat="${esc(g.name)}" aria-label="Move group down"${gi === groups.length - 1 ? ' disabled' : ''}>&darr;</button></div><div class="table-wrap"><table><thead><tr><th>Order</th><th>Service</th><th>Details</th><th>Billing</th><th class="num">Price</th><th></th></tr></thead><tbody>
      ${g.items.map((s, k) => `<tr data-row data-act="open-service" data-id="${s.id}" class="${s.active ? '' : 'dim'}"><td style="white-space:nowrap"><button type="button" class="icon-btn" style="width:32px;height:32px;font-size:15px" data-act="svc-up" data-id="${s.id}" aria-label="Move up"${k === 0 ? ' disabled' : ''}>&uarr;</button> <button type="button" class="icon-btn" style="width:32px;height:32px;font-size:15px" data-act="svc-down" data-id="${s.id}" aria-label="Move down"${k === g.items.length - 1 ? ' disabled' : ''}>&darr;</button></td><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.info)}</td><td>${esc(s.billing)}</td><td class="num">${priceCell(s)}</td><td>${s.active ? '' : chip('Hidden')}${s.no_travel ? chip('No mileage') : ''}</td></tr>`).join('')}
    </tbody></table></div></section>`).join('')}</div>`;
};

/* ---- Settings ---- */
VIEWS.settings = async main => {
  await reload('settings');
  const s = state.settings;
  const f = (key, label, extra = '', type = 'text') => `<label>${label}<input name="${key}" type="${type}" value="${esc(s[key])}" ${extra}></label>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Business details, public contact info, invoice defaults, and travel rules.</p></div></div>
    <form id="settings-form" style="display:grid;gap:20px;max-width:820px">
      <section class="panel"><h2>Public contact info</h2><div class="body" style="display:grid;gap:14px">
        <p class="hint">These show on the homepage contact section. Leave a number blank to hide it.</p>
        <div class="grid2">${f('business_phone', 'Phone number', 'autocomplete="off" inputmode="tel"', 'tel')}${f('business_phone_2', 'Second phone number (optional)', 'inputmode="tel"', 'tel')}</div>
        <div class="grid2">${f('business_email', 'Email address', '', 'email')}${f('service_area', 'Service area')}</div>
      </div></section>
      <section class="panel"><h2>Business</h2><div class="body" style="display:grid;gap:14px">
        <div class="grid2">${f('business_name', 'Business name')}${f('business_tagline', 'Tagline')}</div>
        <div class="grid2">${f('business_address', 'Business address (on invoices)', 'data-addr autocomplete=\"off\"')}${f('home_address', 'Starting address for mileage trips', 'data-addr autocomplete=\"off\"')}</div>
      </div></section>
      <section class="panel"><h2>Invoices</h2><div class="body" style="display:grid;gap:14px">
        <div class="grid3">${f('invoice_terms_days', 'Days until due', 'min="0"', 'number')}${f('sales_tax_rate', 'Sales tax rate %', 'min="0" step="0.01"', 'number')}${f('timezone', 'Time zone')}</div>
        <label>Payment instructions (printed on invoices)<textarea name="payment_instructions" rows="3">${esc(s.payment_instructions)}</textarea></label>
        <p class="hint">Sales tax: 0 means none is added to invoices. If Texas sales tax applies to your services, enter the local rate here after checking with the Texas Comptroller.</p>
      </div></section>
      <section class="panel"><h2>Travel</h2><div class="body" style="display:grid;gap:14px"><div class="grid4">
        ${f('travel_free_minutes', 'Free within (min, one way)', 'min="0"', 'number')}${f('travel_rate', 'Travel rate per hour', 'min="0" step="0.01"', 'number')}${f('travel_round_minutes', 'Round to nearest (min)', 'min="5"', 'number')}${f('onsite_minimum_hours', 'On-site minimum (hours)', 'min="0" step="0.5"', 'number')}
      </div><div class="grid4">${f('parts_markup', 'Parts markup % (added to equipment you buy for a job)', 'min="0" step="0.5"', 'number')}</div></div></section>
      <section class="panel"><h2>New message alerts</h2><div class="body" style="display:grid;gap:12px">
        <p class="hint">When someone uses the contact form on your site, you get an email. It is set up in Railway with RESEND_API_KEY and NOTIFY_EMAIL. You can list several addresses in NOTIFY_EMAIL, separated by commas.</p>
        <div><button type="button" class="btn" id="notify-test">Send a test alert</button></div></div></section>
      <div class="actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Save settings</button></div>
    </form>`;
  $('#notify-test').addEventListener('click', guard(async () => {
    const r = await api('/notify-test', { method: 'POST', body: {} });
    if (r.ok) toast('Test alert sent. Check your email.'); else toast(r.error || 'Could not send.', 'err');
  }));
  $('#settings-form').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const body = {};
    $$('#settings-form [name]').forEach(el => { body[el.name] = el.value; });
    state.settings = await api('/settings', { method: 'PUT', body });
    toast('Settings saved');
  }));
};

/* =====================================================================
   Dialogs for records
   ===================================================================== */
const head = (title) => `<div class="dlg-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">&times;</button></div>`;

/* ---- Customer ---- */
function openCustomer(c, { target = dlg, onSaved } = {}) {
  const isNew = !c || !c.id;
  const x = c || {};
  openDialog(target, `<form class="dlg-body" id="cust-form">${head(isNew ? 'New customer' : esc(x.name))}
    <div class="grid2"><label>Name<input name="name" required value="${esc(x.name)}" autocomplete="off"></label><label>Phone<input name="phone" type="tel" value="${esc(x.phone)}"></label></div>
    <div class="grid2"><label>Email<input name="email" type="email" value="${esc(x.email)}"></label><label>Service address<input name="address" value="${esc(x.address)}" placeholder="Start typing the address" data-addr autocomplete="off"></label></div>
    <label>Notes<textarea name="notes" rows="3" placeholder="Gate codes, equipment, preferences">${esc(x.notes)}</textarea></label>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="cust-del">Delete</button>'}<button type="button" class="btn" data-close>Cancel</button>${isNew ? '' : '<button type="button" class="btn" id="cust-job">New job</button>'}<button class="btn primary" type="submit">Save</button></div></form>`);
  const form = $('#cust-form', target);
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const saved = isNew ? await api('/customers', { method: 'POST', body }) : await api('/customers/' + x.id, { method: 'PUT', body });
    await reload('customers');
    closeDialog(target);
    toast('Customer saved');
    if (onSaved) onSaved(saved); else route();
  }));
  if (!isNew) {
    confirmDelete($('#cust-del', target), async () => { await api('/customers/' + x.id, { method: 'DELETE' }); await reload('customers', 'orders', 'invoices'); closeDialog(target); toast('Customer deleted'); route(); });
    $('#cust-job', target).addEventListener('click', () => openJob(null, { customer_id: x.id }));
  }
}

/* ---- Job ---- */
function openJob(order, prefill = {}) {
  let isNew = !order;
  const o = order ? JSON.parse(JSON.stringify(order)) : { customer_id: prefill.customer_id || '', title: prefill.title || '', status: 'Requested', service_date: todayStr(), items: [], notes: prefill.notes || '', one_way_minutes: '' };
  openDialog(dlg, `<form class="dlg-body" id="job-form">${head(isNew ? 'New job' : 'Job #' + o.id)}
    <div class="grid2"><label>What is the job?<input name="title" value="${esc(o.title)}" placeholder="Wi-Fi dead zones, new PC setup, smart lock install"></label>
      <label>Customer<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px"><select name="customer_id" id="j-customer">${customerOptions(o.customer_id)}</select><button type="button" class="btn" id="j-newcust">New</button></div></label></div>
    <div class="grid2"><label>Date<input name="service_date" type="date" value="${esc(o.service_date)}"></label><label>Status<select name="status">${opts(ORDER_STATUS, o.status)}</select></label></div>
    <div class="section-title">Line items</div><div id="j-items"></div>
    <div class="travel-row"><label>One-way drive (min)<input id="j-minutes" type="number" min="0" step="1" value="${esc(o.one_way_minutes ?? '')}"></label><button type="button" class="btn" id="j-addtravel">Add travel charge</button><span class="hint" id="j-travelhint"></span></div>
    ${mileagePanelHtml('j')}
    <div class="section-title">Parts and equipment bought for this job</div>
    <div class="receipts" id="j-parts"></div>
    <div><button type="button" class="btn" id="j-addpart">Add equipment purchase</button></div>
    <label>Notes<textarea name="notes" rows="2" placeholder="Equipment, access, follow-ups">${esc(o.notes)}</textarea></label>
    <div class="totals"><div class="grand"><span>Total</span><span id="j-total"></span></div></div>
    <div class="inline-box" id="j-paid" hidden><div class="section-title">Mark paid in full</div>
      <div class="grid2"><label>Payment method<select id="j-method">${opts(PAY_METHODS, 'Venmo')}</select></label><label>Date paid<input id="j-paiddate" type="date" value="${todayStr()}"></label></div>
      <div class="actions"><button type="button" class="btn" id="j-paidcancel">Cancel</button><button type="button" class="btn primary" id="j-paidok">Save and mark paid</button></div></div>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="j-del">Delete</button>'}<button type="button" class="btn" data-close>Close</button>
      ${o.invoice_id ? '<button type="button" class="btn" id="j-viewinv">View invoice</button>' : '<button type="button" class="btn" id="j-inv">Create invoice</button><button type="button" class="btn" id="j-paidbtn">Paid in full</button>'}
      <button class="btn primary" type="submit">Save job</button></div></form>`);
  const form = $('#job-form', dlg);
  let mil = null;
  const updateTotal = () => { $('#j-total').textContent = money(sumItems(o.items)); };
  const ed = createItemEditor($('#j-items', dlg), o.items, () => { updateTotal(); if (mil) mil.onItems(); });
  updateTotal();
  $('#j-travelhint').textContent = travelHint($('#j-minutes').value);
  $('#j-minutes').addEventListener('input', e => { $('#j-travelhint').textContent = travelHint(e.target.value); });
  $('#j-addtravel').addEventListener('click', () => {
    const m = num($('#j-minutes').value);
    if (!m) { toast('Enter the one-way drive time in minutes first.', 'err'); return; }
    ed.add(travelItem(m));
  });
  $('#j-newcust').addEventListener('click', () => openCustomer(null, { target: dlg2, onSaved: c => { const sel = $('#j-customer'); sel.innerHTML = customerOptions(c.id); sel.dispatchEvent(new Event('change')); } }));
  const collect = () => ({
    title: form.elements.title.value, customer_id: form.elements.customer_id.value || null, service_date: form.elements.service_date.value,
    status: form.elements.status.value, notes: form.elements.notes.value, one_way_minutes: $('#j-minutes').value || null, items: o.items,
    from_addr: $('#j-from').value, one_way_miles: $('#j-miles').value || null,
  });
  const save = async () => {
    const saved = isNew ? await api('/orders', { method: 'POST', body: collect() }) : await api('/orders/' + o.id, { method: 'PUT', body: collect() });
    if (isNew) { isNew = false; o.id = saved.id; }
    const trip = mil && mil.takeTrip();
    if (trip) await api('/mileage', { method: 'POST', body: { ...trip, order_id: o.id } });
    return saved;
  };
  reload('mileage', 'settings', 'services', 'customers').then(() => {
    mil = wireMileage({ p: 'j', items: o.items, ed, onTotal: updateTotal, customerEl: $('#j-customer'), dateEl: form.elements.service_date, minutesEl: $('#j-minutes'), from: o.from_addr, miles: o.one_way_miles });
  }).catch(() => {});
  const renderParts = () => {
    const list = o.id ? state.expenses.filter(x => x.order_id === o.id) : [];
    const cost = r2(list.reduce((t, x) => t + x.amount, 0));
    $('#j-parts').innerHTML = list.length
      ? list.map(x => `<div class="receipt"><span>${esc(x.vendor)}${x.description ? ': ' + esc(x.description) : ''}</span><span class="num">${money(x.amount)}</span></div>`).join('') + `<p class="hint">Your cost so far: ${money(cost)}. Edit these any time on the Expenses page.</p>`
      : '<p class="hint">Nothing added yet. Equipment you add here is saved as an expense, with its receipt, and can be billed to the customer on this job.</p>';
  };
  if (o.id) reload('expenses').then(renderParts).catch(() => {}); else renderParts();
  $('#j-addpart').addEventListener('click', guard(async () => {
    if (isNew) await save();
    await reload('expenses');
    openPart(o.id, o.customer_id || null, line => ed.add(line), async () => { await reload('expenses'); renderParts(); });
  }));
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    await save();
    await reload('orders');
    closeDialog(dlg);
    toast('Job saved');
    route();
  }));
  if (o.invoice_id) {
    $('#j-viewinv').addEventListener('click', () => openInvoice(findBy(state.invoices, o.invoice_id)));
  } else {
    $('#j-inv').addEventListener('click', guard(async () => {
      const saved = await save();
      const r = await api(`/orders/${saved.id}/invoice`, { method: 'POST', body: {} });
      await reload('orders', 'invoices');
      route();
      openInvoice(findBy(state.invoices, r.id));
    }));
    $('#j-paidbtn').addEventListener('click', () => { $('#j-paid').hidden = false; });
    $('#j-paidcancel').addEventListener('click', () => { $('#j-paid').hidden = true; });
    $('#j-paidok').addEventListener('click', guard(async () => {
      const saved = await save();
      await api(`/orders/${saved.id}/invoice`, { method: 'POST', body: { paid: true, payment_method: $('#j-method').value, paid_date: $('#j-paiddate').value } });
      await reload('orders', 'invoices');
      closeDialog(dlg);
      toast('Saved and marked paid');
      route();
    }));
  }
  if (!isNew) confirmDelete($('#j-del'), async () => { await api('/orders/' + o.id, { method: 'DELETE' }); await reload('orders', 'invoices'); closeDialog(dlg); toast('Job deleted'); route(); });
}

/* ---- Mileage charge (shared by jobs and invoices) ---- */
const distCache = new Map();
function mileagePanelHtml(p) {
  return `<div class="inline-box"><div class="section-title">Mileage</div>
    <label>Drive starts from<input id="${p}-from" placeholder="Start typing the address" data-addr autocomplete="off"></label>
    <div class="travel-row" style="grid-template-columns:150px auto auto minmax(0,1fr)"><label>One-way miles<input id="${p}-miles" type="number" min="0" step="0.1"></label><button type="button" class="btn" id="${p}-calc">Calculate</button><button type="button" class="btn" id="${p}-addmiles">Update travel charge</button><span class="hint" id="${p}-mileshint"></span></div>
    <input type="checkbox" id="${p}-round" checked hidden><input type="checkbox" id="${p}-logtrip" checked hidden>
    <p class="hint">The travel charge is added automatically for every service except remote work, using your travel rules (free within the free range, then the round trip at your travel rate). Every trip is counted round trip and logged in Mileage at the IRS rate for your tax deduction only. If you drove from somewhere else, change the starting address.</p></div>`;
}
function wireMileage(c) {
  const { p, items, ed, onTotal, customerEl, dateEl, minutesEl } = c;
  const $e = id => $('#' + p + '-' + id, dlg);
  const fromEl = $e('from'), milesEl = $e('miles'), roundEl = $e('round'), logEl = $e('logtrip'), hint = $e('mileshint');
  fromEl.value = c.from || state.settings.home_address || '';
  if (c.miles) milesEl.value = c.miles;
  let busy = false, looking = false, dismissed = false, pendingTrip = null;
  let hadLine = items.some(i => i.kind === 'mileage');
  if (hadLine) logEl.checked = false;
  const customer = () => findBy(state.customers, customerEl.value);
  const rate = () => rateOn(dateEl.value || todayStr(), state.mileage.rates);
  const say = t => { hint.textContent = t; };
  const billable = () => items.some(i => i.kind === 'service' && i.service_id && !(findBy(state.services, i.service_id) || {}).no_travel);
  const hasLine = () => items.some(i => i.kind === 'mileage');
  const fillMinutes = d => { if (minutesEl) { minutesEl.value = d.minutes; minutesEl.dispatchEvent(new Event('input')); } };

  async function lookup() {
    const cust = customer();
    if (!cust || !cust.address) throw new Error("Pick a customer with a service address to charge mileage.");
    if (!fromEl.value.trim()) throw new Error('Enter where the drive starts.');
    const key = fromEl.value.trim().toLowerCase() + '|' + cust.address.trim().toLowerCase();
    if (!distCache.has(key)) distCache.set(key, await api('/distance?from=' + encodeURIComponent(fromEl.value.trim()) + '&to=' + encodeURIComponent(cust.address)));
    return distCache.get(key);
  }
  function setLine(one, minutes = num(minutesEl && minutesEl.value)) {
    if (!minutes) { say('Enter the one-way drive minutes to price the travel.'); return; }
    const t = travelCharge(minutes, state.settings);
    const base = travelItem(minutes);
    const line = { ...base, kind: 'mileage', desc: `Travel (${one} mi, ${minutes} min each way${t.free ? ', no charge' : ', ' + t.minutes + ' min billed'})` };
    busy = true;
    const i = items.findIndex(x => x.kind === 'mileage');
    if (i >= 0) items.splice(i, 1, line); else items.push(line);
    ed.render(); onTotal();
    busy = false; hadLine = true;
    say(t.free ? 'Within the free range, no travel charge.' : `Travel charge ${money(t.amount)} (${t.minutes} min round trip)`);
    const round = roundEl.checked;
    if (logEl.checked) {
      const cust = customer();
      pendingTrip = { date: dateEl.value || todayStr(), customer_id: cust ? cust.id : null, from_addr: fromEl.value, to_addr: cust ? cust.address : '', miles: one, round_trip: round, purpose: 'Customer visit' };
    } else pendingTrip = null;
  }
  async function autoFill() {
    if (looking) return;
    looking = true;
    try {
      const d = await lookup();
      fillMinutes(d);
      milesEl.value = d.miles;
      if (billable() && (!hasLine() || c.replace)) setLine(d.miles, d.minutes);
    } catch (e) { say(e.message); } finally { looking = false; c.replace = false; }
  }
  function onItems() {
    if (busy) return;
    const has = hasLine();
    if (hadLine && !has) dismissed = true;
    hadLine = has;
    if (!billable()) {
      if (has) {
        busy = true;
        for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'mileage') items.splice(i, 1);
        ed.render(); onTotal();
        busy = false; hadLine = false; pendingTrip = null;
        say('No mileage charge for remote-only work.');
      }
      return;
    }
    if (!has && !dismissed) autoFill();
  }
  const refresh = () => { dismissed = false; if (billable()) { c.replace = true; autoFill(); } };
  customerEl.addEventListener('change', refresh);
  fromEl.addEventListener('change', refresh);
  dateEl.addEventListener('change', () => { if (hasLine() && num(milesEl.value)) setLine(num(milesEl.value)); });
  roundEl.addEventListener('change', () => { if (hasLine() && num(milesEl.value)) setLine(num(milesEl.value)); });
  $e('calc').addEventListener('click', guard(async () => {
    const btn = $e('calc'); btn.disabled = true; btn.textContent = 'Looking up...';
    try { const d = await lookup(); milesEl.value = d.miles; fillMinutes(d); toast(`${d.miles} miles, about ${d.minutes} minutes each way`); }
    finally { btn.disabled = false; btn.textContent = 'Calculate'; }
  }));
  $e('addmiles').addEventListener('click', guard(async () => {
    if (!num(milesEl.value)) { const d = await lookup(); milesEl.value = d.miles; fillMinutes(d); }
    dismissed = false;
    setLine(num(milesEl.value));
  }));
  return { onItems, takeTrip() { const t = pendingTrip; pendingTrip = null; return t; } };
}

/* ---- Equipment bought for a job ---- */
function openPart(orderId, customerId, addLine, done) {
  const markup = num(state.settings.parts_markup);
  openDialog(dlg2, `<form class="dlg-body" id="part-form">${head('Add equipment purchase')}
    <div class="grid3"><label>Date<input name="date" type="date" required value="${todayStr()}"></label><label>Vendor<input name="vendor" required placeholder="Amazon, Micro Center"></label><label>What you paid ($)<input name="amount" type="number" step="0.01" min="0" required></label></div>
    <label>What is it?<input name="description" required placeholder="Wi-Fi 7 access point"></label>
    <div class="grid2"><label>Order or receipt number<input name="reference"></label><label>Paid with<select name="payment_method">${opts(['Card', 'Cash', 'Venmo', 'Zelle', 'Check', 'Other'], 'Card')}</select></label></div>
    <label>Receipt photo or PDF<input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" multiple></label>
    <div class="inline-box"><label class="check"><input type="checkbox" name="bill" checked> Bill this to the customer on the job</label>
      <div class="grid2"><label>Markup %<input name="markup" type="number" step="0.5" min="0" value="${esc(markup)}"></label><label>Customer price<input name="price" type="number" step="0.01" min="0"></label></div>
      <p class="hint" id="p-hint"></p></div>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save equipment</button></div></form>`);
  const form = $('#part-form', dlg2);
  const el = form.elements;
  const hint = () => { $('#p-hint').textContent = el.bill.checked ? `Cost ${money(num(el.amount.value))}, you charge ${money(num(el.price.value))}, profit ${money(r2(num(el.price.value) - num(el.amount.value)))}.` : 'Saved as an expense only. The customer is not charged.'; };
  const fromMarkup = () => { el.price.value = r2(num(el.amount.value) * (1 + num(el.markup.value) / 100)).toFixed(2); hint(); };
  el.amount.addEventListener('input', fromMarkup);
  el.markup.addEventListener('input', fromMarkup);
  el.price.addEventListener('input', () => { if (num(el.amount.value)) el.markup.value = r2((num(el.price.value) / num(el.amount.value) - 1) * 100); hint(); });
  el.bill.addEventListener('change', hint);
  hint();
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const exp = await api('/expenses', { method: 'POST', body: {
      date: el.date.value, vendor: el.vendor.value, description: el.description.value, category: 'Equipment & parts',
      amount: el.amount.value, payment_method: el.payment_method.value, reference: el.reference.value, customer_id: customerId, order_id: orderId, notes: '',
    } });
    for (const file of [...el.file.files]) {
      try {
        const res = await fetch(`/api/expenses/${exp.id}/receipts`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) { toast(`${file.name}: ${err.message}`, 'err'); }
    }
    if (el.bill.checked && num(el.price.value) > 0) addLine({ desc: el.description.value, billing: 'Flat', rate: r2(num(el.price.value)), qty: 1, kind: 'custom' });
    closeDialog(dlg2);
    toast(el.bill.checked ? 'Equipment saved and added to the job. Click Save job.' : 'Equipment saved');
    await done();
  }));
}

/* ---- Invoice ---- */
function invoiceTotals(items, discount, rate) {
  const subtotal = sumItems(items);
  const disc = Math.min(Math.max(r2(discount), 0), subtotal);
  const tax = r2(((subtotal - disc) * Math.max(num(rate), 0)) / 100);
  return { subtotal, disc, tax, total: r2(subtotal - disc + tax) };
}
function openInvoice(inv, prefill = {}) {
  const isNew = !inv;
  const s = state.settings;
  const due = new Date(Date.now() + (num(s.invoice_terms_days) || 7) * 864e5).toLocaleDateString('en-CA');
  const o = inv ? JSON.parse(JSON.stringify(inv)) : { number: '', customer_id: prefill.customer_id || '', issue_date: todayStr(), due_date: due, status: 'Draft', paid_date: '', payment_method: '', items: [], discount: 0, tax_rate: num(s.sales_tax_rate), notes: '', order_id: null };
  openDialog(dlg, `<form class="dlg-body" id="inv-form">${head(isNew ? 'New invoice' : 'Invoice ' + esc(o.number))}
    <div class="grid3"><label>Customer<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px"><select name="customer_id" id="i-customer">${customerOptions(o.customer_id)}</select><button type="button" class="btn" id="i-newcust">New</button></div></label>
      <label>Issue date<input name="issue_date" type="date" value="${esc(o.issue_date)}"></label><label>Due date<input name="due_date" type="date" value="${esc(o.due_date)}"></label></div>
    <div class="grid3"><label>Status<select name="status" id="i-status">${opts(INVOICE_STATUS, o.status)}</select></label>
      <label class="i-paid">Date paid<input name="paid_date" type="date" value="${esc(o.paid_date || todayStr())}"></label>
      <label class="i-paid">Payment method<select name="payment_method"><option value="">Choose</option>${opts(PAY_METHODS, o.payment_method)}</select></label></div>
    <div class="section-title">Line items</div><div id="i-items"></div>
    <div class="travel-row"><label>One-way drive (min)<input id="i-minutes" type="number" min="0" step="1" value="${esc(o.one_way_minutes ?? '')}"></label><button type="button" class="btn" id="i-addtravel">Add travel charge</button><span class="hint" id="i-travelhint"></span></div>
    ${mileagePanelHtml('i')}
    <div class="grid2"><label>Notes (shown on the invoice)<textarea name="notes" rows="3">${esc(o.notes)}</textarea></label>
      <div style="display:grid;gap:12px"><label>Discount ($)<input name="discount" type="number" step="0.01" min="0" value="${esc(o.discount)}"></label><label>Sales tax %<input name="tax_rate" type="number" step="0.01" min="0" value="${esc(o.tax_rate)}"></label></div></div>
    <div class="totals" id="i-totals"></div>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="i-del">Delete</button>'}<button type="button" class="btn" data-close>Close</button>${isNew ? '' : '<button type="button" class="btn" id="i-print">Print or save PDF</button><button type="button" class="btn" id="i-link">Copy customer link</button><button type="button" class="btn" id="i-sms">Text link</button><button type="button" class="btn" id="i-mail">Email link</button>'}<button class="btn primary" type="submit">Save invoice</button></div></form>`);
  const form = $('#inv-form', dlg);
  const el = form.elements;
  const updateTotals = () => {
    const t = invoiceTotals(o.items, el.discount.value, el.tax_rate.value);
    $('#i-totals').innerHTML = `<div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>${t.disc ? `<div><span>Discount</span><span>- ${money(t.disc)}</span></div>` : ''}${t.tax ? `<div><span>Sales tax</span><span>${money(t.tax)}</span></div>` : ''}<div class="grand"><span>Total</span><span>${money(t.total)}</span></div>`;
  };
  let mil = null;
  const ed = createItemEditor($('#i-items', dlg), o.items, () => { updateTotals(); if (mil) mil.onItems(); });
  reload('mileage', 'services', 'customers').then(() => {
    mil = wireMileage({ p: 'i', items: o.items, ed, onTotal: updateTotals, customerEl: $('#i-customer'), dateEl: el.issue_date, minutesEl: $('#i-minutes'), from: o.from_addr, miles: o.one_way_miles });
  }).catch(() => {});
  const togglePaid = () => $$('.i-paid', form).forEach(l => { l.hidden = el.status.value !== 'Paid'; });
  el.status.addEventListener('change', togglePaid);
  togglePaid();
  updateTotals();
  el.discount.addEventListener('input', updateTotals);
  el.tax_rate.addEventListener('input', updateTotals);
  $('#i-travelhint').textContent = travelHint('');
  $('#i-minutes').addEventListener('input', e => { $('#i-travelhint').textContent = travelHint(e.target.value); });
  $('#i-addtravel').addEventListener('click', () => {
    const m = num($('#i-minutes').value);
    if (!m) { toast('Enter the one-way drive time in minutes first.', 'err'); return; }
    ed.add(travelItem(m));
  });
  $('#i-newcust').addEventListener('click', () => openCustomer(null, { target: dlg2, onSaved: c => { const sel = $('#i-customer'); sel.innerHTML = customerOptions(c.id); sel.dispatchEvent(new Event('change')); } }));
  const collect = () => ({
    customer_id: el.customer_id.value || null, issue_date: el.issue_date.value, due_date: el.due_date.value, status: el.status.value,
    paid_date: el.paid_date.value, payment_method: el.payment_method.value, notes: el.notes.value, discount: el.discount.value, tax_rate: el.tax_rate.value,
    items: o.items, order_id: o.order_id,
    from_addr: $('#i-from').value, one_way_miles: $('#i-miles').value || null, one_way_minutes: $('#i-minutes').value || null,
  });
  const save = async () => {
    const saved = isNew ? await api('/invoices', { method: 'POST', body: collect() }) : await api('/invoices/' + o.id, { method: 'PUT', body: collect() });
    const trip = mil && mil.takeTrip();
    if (trip) await api('/mileage', { method: 'POST', body: { ...trip, order_id: o.order_id || null } });
    return saved;
  };
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    await save();
    await reload('invoices', 'orders');
    closeDialog(dlg);
    toast('Invoice saved');
    route();
  }));
  if (!isNew) {
    $('#i-print').addEventListener('click', async () => {
      const w = window.open('about:blank', '_blank');
      try {
        const saved = await save();
        await reload('invoices', 'orders');
        if (w) w.location.href = '/print?id=' + saved.id; else toast('Allow pop-ups to open the print view.', 'err');
        route();
      } catch (err) { if (w) w.close(); toast(err.message, 'err'); }
    });
    const link = () => location.origin + '/i/' + o.public_token;
    const cust = () => findBy(state.customers, o.customer_id);
    const msg = () => `Hi${cust() ? ' ' + cust().name.split(' ')[0] : ''}, here is your ${o.status === 'Paid' ? 'receipt' : 'invoice'} ${o.number} from ${state.settings.business_name}: ${link()}`;
    $('#i-link').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link()); toast('Customer link copied'); }
      catch (e) { window.prompt('Copy this link', link()); }
    });
    $('#i-sms').addEventListener('click', () => { const c = cust(); location.href = 'sms:' + ((c && c.phone) || '').replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(msg()); });
    $('#i-mail').addEventListener('click', () => { const c = cust(); location.href = 'mailto:' + ((c && c.email) || '') + '?subject=' + encodeURIComponent(`${state.settings.business_name} ${o.status === 'Paid' ? 'receipt' : 'invoice'} ${o.number}`) + '&body=' + encodeURIComponent(msg()); });
    confirmDelete($('#i-del'), async () => { await api('/invoices/' + o.id, { method: 'DELETE' }); await reload('invoices', 'orders'); closeDialog(dlg); toast('Invoice deleted'); route(); });
  }
}

/* ---- Expense ---- */
function openExpense(exp) {
  const isNew = !exp;
  const x = exp ? JSON.parse(JSON.stringify(exp)) : { date: todayStr(), vendor: '', description: '', category: 'Equipment & parts', amount: '', payment_method: 'Card', reference: '', customer_id: '', notes: '', receipts: [] };
  openDialog(dlg, `<form class="dlg-body" id="exp-form">${head(isNew ? 'Add expense' : 'Expense')}
    <div class="grid3"><label>Date<input name="date" type="date" required value="${esc(x.date)}"></label><label>Vendor<input name="vendor" required value="${esc(x.vendor)}" placeholder="Amazon, Micro Center"></label><label>Amount ($)<input name="amount" type="number" step="0.01" min="0" required value="${esc(x.amount)}"></label></div>
    <label>What was it for?<input name="description" value="${esc(x.description)}" placeholder="Mesh Wi-Fi kit for a customer install"></label>
    <div class="grid3"><label>Category<select name="category">${opts(EXPENSE_CATEGORIES, x.category)}</select></label><label>Paid with<select name="payment_method">${opts(['Card', 'Cash', 'Venmo', 'Zelle', 'Check', 'Other'], x.payment_method)}</select></label><label>Order or receipt number<input name="reference" value="${esc(x.reference)}"></label></div>
    <div class="grid2"><label>For customer (optional)<select name="customer_id">${customerOptions(x.customer_id)}</select></label><label>Notes<input name="notes" value="${esc(x.notes)}"></label></div>
    <div class="section-title">Receipts</div>
    <div class="receipts" id="e-receipts"></div>
    <label>Attach photos or PDFs<input type="file" id="e-files" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" multiple></label>
    <p class="hint">Up to 8 MB each. They are uploaded when you save.</p>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="e-del">Delete</button>'}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save expense</button></div></form>`);
  const form = $('#exp-form', dlg);
  const renderReceipts = () => {
    $('#e-receipts').innerHTML = x.receipts.length ? x.receipts.map(r => `<div class="receipt"><a href="/api/receipts/${r.id}" target="_blank" rel="noopener">${esc(r.filename)}</a><span class="hint">${Math.max(1, Math.round(r.size / 1024))} KB</span><button type="button" class="icon-btn" data-rmreceipt="${r.id}" aria-label="Remove receipt">&times;</button></div>`).join('') : '<p class="hint">No receipts attached yet.</p>';
  };
  renderReceipts();
  $('#e-receipts').addEventListener('click', guard(async e => {
    const b = e.target.closest('[data-rmreceipt]');
    if (!b) return;
    await api('/receipts/' + b.dataset.rmreceipt, { method: 'DELETE' });
    x.receipts = x.receipts.filter(r => r.id !== Number(b.dataset.rmreceipt));
    renderReceipts();
  }));
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    delete body[''];
    const saved = isNew ? await api('/expenses', { method: 'POST', body }) : await api('/expenses/' + x.id, { method: 'PUT', body });
    const files = [...$('#e-files').files];
    let failed = 0;
    for (const file of files) {
      try {
        const res = await fetch(`/api/expenses/${saved.id}/receipts`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) { failed++; toast(`${file.name}: ${err.message}`, 'err'); }
    }
    await reload('expenses');
    closeDialog(dlg);
    if (!failed) toast(files.length ? 'Expense and receipts saved' : 'Expense saved');
    route();
  }));
  if (!isNew) confirmDelete($('#e-del'), async () => { await api('/expenses/' + x.id, { method: 'DELETE' }); await reload('expenses'); closeDialog(dlg); toast('Expense deleted'); route(); });
}

/* ---- Mileage trip ---- */
function openTrip(trip) {
  const isNew = !trip;
  const x = trip ? { ...trip } : { date: todayStr(), customer_id: '', from_addr: state.settings.home_address || '', to_addr: '', miles: '', round_trip: true, purpose: 'Customer visit' };
  openDialog(dlg, `<form class="dlg-body" id="trip-form">${head(isNew ? 'Log trip' : 'Trip')}
    <div class="grid2"><label>Date<input name="date" type="date" required value="${esc(x.date)}"></label><label>Customer<select name="customer_id" id="t-customer">${customerOptions(x.customer_id)}</select></label></div>
    <div class="grid2"><label>From<input name="from_addr" value="${esc(x.from_addr)}" placeholder="Starting address" data-addr autocomplete="off"></label><label>To<input name="to_addr" id="t-to" value="${esc(x.to_addr)}" placeholder="Destination address" data-addr autocomplete="off"></label></div>
    <div class="grid3"><label>Miles (one way)<input name="miles" type="number" step="0.1" min="0" required value="${esc(x.miles)}"></label><label>Purpose<input name="purpose" value="${esc(x.purpose)}"></label><label class="check" style="align-self:end;min-height:44px"><input type="checkbox" name="round_trip"${x.round_trip ? ' checked' : ''}> Round trip (count both ways)</label></div>
    <p class="hint" id="t-preview"></p>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="t-del">Delete</button>'}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save trip</button></div></form>`);
  const form = $('#trip-form', dlg);
  const el = form.elements;
  const preview = () => {
    const rate = rateOn(el.date.value, state.mileage.rates);
    const miles = num(el.miles.value) * (el.round_trip.checked ? 2 : 1);
    $('#t-preview').textContent = `${miles.toFixed(1)} miles at ${rate.toFixed(3)} per mile = ${money(miles * rate)} deduction`;
  };
  preview();
  ['date', 'miles', 'round_trip'].forEach(n => el[n].addEventListener('input', preview));
  $('#t-customer').addEventListener('change', e => {
    const c = findBy(state.customers, e.target.value);
    if (c && c.address && !el.to_addr.value) el.to_addr.value = c.address;
  });
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const body = { date: el.date.value, customer_id: el.customer_id.value || null, from_addr: el.from_addr.value, to_addr: el.to_addr.value, miles: el.miles.value, round_trip: el.round_trip.checked, purpose: el.purpose.value };
    if (isNew) await api('/mileage', { method: 'POST', body }); else await api('/mileage/' + x.id, { method: 'PUT', body });
    await reload('mileage');
    closeDialog(dlg);
    toast('Trip saved');
    route();
  }));
  if (!isNew) confirmDelete($('#t-del'), async () => { await api('/mileage/' + x.id, { method: 'DELETE' }); await reload('mileage'); closeDialog(dlg); toast('Trip deleted'); route(); });
}

/* ---- Service ---- */
function openService(svc) {
  const isNew = !svc;
  const x = svc || { category: 'Hourly Service', name: '', info: '', billing: 'Hourly', price: '', price_label: '', active: true };
  const cats = [...new Set(state.services.map(s => s.category))];
  openDialog(dlg, `<form class="dlg-body" id="svc-form">${head(isNew ? 'Add service' : 'Edit service')}
    <div class="grid2"><label>Name<input name="name" required value="${esc(x.name)}"></label><label>Category<input name="category" list="cats" required value="${esc(x.category)}"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label></div>
    <label>Details shown to customers<input name="info" value="${esc(x.info)}"></label>
    <div class="grid3"><label>Billing<select name="billing">${opts(BILLING, x.billing)}</select></label><label>Price ($)<input name="price" type="number" step="0.01" min="0" value="${x.price == null ? '' : esc(x.price)}" placeholder="Leave blank for quote"></label><label>Price label<input name="price_label" list="price-labels" value="${esc(x.price_label)}" placeholder="Optional, such as Cost + 10%" maxlength="40"><datalist id="price-labels"><option value="Starting at"><option value="At cost"><option value="Cost + 10%"><option value="Build fee"></datalist></label></div>
    <label class="check"><input type="checkbox" name="active"${x.active ? ' checked' : ''}> Show on the public site and in pickers</label>
    <label class="check"><input type="checkbox" name="no_travel"${x.no_travel ? ' checked' : ''}> No mileage charge (remote work)</label>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger spacer" id="s-del">Delete</button>'}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
  const form = $('#svc-form', dlg);
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const f = form.elements;
    const body = { name: f.name.value, category: f.category.value, info: f.info.value, billing: f.billing.value, price: f.price.value, price_label: f.price_label.value, active: f.active.checked, no_travel: f.no_travel.checked };
    if (isNew) await api('/services', { method: 'POST', body }); else await api('/services/' + x.id, { method: 'PUT', body });
    await reload('services');
    closeDialog(dlg);
    toast('Service saved');
    route();
  }));
  if (!isNew) confirmDelete($('#s-del'), async () => { await api('/services/' + x.id, { method: 'DELETE' }); await reload('services'); closeDialog(dlg); toast('Service deleted'); route(); });
}

/* ---- Inquiry ---- */
function openInquiry(q) {
  openDialog(dlg, `<div class="dlg-body" id="inq">${head(esc(q.name))}
    <div class="grid2"><div><div class="section-title">Received</div><p>${fmtStamp(q.created_at)} ${chip(q.status)}</p></div><div><div class="section-title">Needs</div><p>${esc(q.service) || 'Not specified'}</p></div></div>
    <div class="grid3"><div><div class="section-title">Phone</div><p>${q.phone ? `<a href="tel:${esc(q.phone.replace(/[^\d+]/g, ''))}">${esc(q.phone)}</a>` : 'Not given'}</p></div>
      <div><div class="section-title">Email</div><p>${q.email ? `<a href="mailto:${esc(q.email)}">${esc(q.email)}</a>` : 'Not given'}</p></div>
      <div><div class="section-title">Prefers</div><p>${esc(q.preferred) || 'Any'}</p></div></div>
    <div><div class="section-title">Message</div><p style="white-space:pre-wrap;margin-top:6px">${esc(q.message)}</p></div>
    <div class="actions"><button class="btn danger spacer" id="q-del">Delete</button>
      <button class="btn" id="q-cust">Add as customer</button>
      ${q.status !== 'Done' ? '<button class="btn primary" id="q-done">Mark done</button>' : '<button class="btn" id="q-new">Mark new</button>'}</div></div>`);
  const setStatus = status => guard(async () => { await api('/inquiries/' + q.id, { method: 'PUT', body: { status } }); await reload('inquiries'); closeDialog(dlg); route(); });
  if (q.status === 'New') api('/inquiries/' + q.id, { method: 'PUT', body: { status: 'Read' } }).then(() => reload('inquiries')).then(updateBadge).catch(() => {});
  if ($('#q-done')) $('#q-done').addEventListener('click', setStatus('Done'));
  if ($('#q-new')) $('#q-new').addEventListener('click', setStatus('New'));
  $('#q-cust').addEventListener('click', () => openCustomer({ name: q.name, phone: q.phone, email: q.email, notes: q.message }, { target: dlg2, onSaved: () => { toast('Customer added'); } }));
  confirmDelete($('#q-del'), async () => { await api('/inquiries/' + q.id, { method: 'DELETE' }); await reload('inquiries'); closeDialog(dlg); toast('Message deleted'); route(); });
}

/* =====================================================================
   Actions, routing, login
   ===================================================================== */
const saveServiceOrder = guard(async ids => {
  state.services = await api('/services-order', { method: 'PUT', body: { ids } });
  route();
});
function serviceGroups() {
  const groups = [];
  state.services.forEach(s => { let g = groups.find(x => x.name === s.category); if (!g) groups.push((g = { name: s.category, items: [] })); g.items.push(s); });
  return groups;
}
function moveService(id, dir) {
  const groups = serviceGroups();
  const g = groups.find(x => x.items.some(s => s.id === id));
  const i = g.items.findIndex(s => s.id === id);
  const j = i + dir;
  if (j < 0 || j >= g.items.length) return;
  [g.items[i], g.items[j]] = [g.items[j], g.items[i]];
  saveServiceOrder(groups.flatMap(x => x.items.map(s => s.id)));
}
function moveGroup(name, dir) {
  const groups = serviceGroups();
  const i = groups.findIndex(g => g.name === name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= groups.length) return;
  [groups[i], groups[j]] = [groups[j], groups[i]];
  saveServiceOrder(groups.flatMap(x => x.items.map(s => s.id)));
}

const ACTIONS = {
  'open-job': t => openJob(findBy(state.orders, t.dataset.id)),
  'new-job': () => openJob(null),
  'open-invoice': t => openInvoice(findBy(state.invoices, t.dataset.id)),
  'new-invoice': () => openInvoice(null),
  'open-customer': t => openCustomer(findBy(state.customers, t.dataset.id)),
  'new-customer': () => openCustomer(null),
  'open-expense': t => openExpense(findBy(state.expenses, t.dataset.id)),
  'new-expense': () => openExpense(null),
  'open-trip': t => openTrip(findBy(state.mileage.trips, t.dataset.id)),
  'new-trip': () => openTrip(null),
  'open-service': t => openService(findBy(state.services, t.dataset.id)),
  'new-service': () => openService(null),
  'svc-up': t => moveService(Number(t.dataset.id), -1),
  'svc-down': t => moveService(Number(t.dataset.id), 1),
  'grp-up': t => moveGroup(t.dataset.cat, -1),
  'grp-down': t => moveGroup(t.dataset.cat, 1),
  'open-inquiry': t => openInquiry(findBy(state.inquiries, t.dataset.id)),
  'add-rate': () => { $('#rates').insertAdjacentHTML('beforeend', rateRow(null)); },
  'rm-rate': t => t.closest('.rate-row').remove(),
  'save-rates': guard(async () => {
    const rates = $$('.rate-row').map(r => ({ effective_from: $('[data-r="date"]', r).value, rate: num($('[data-r="rate"]', r).value) }));
    state.mileage.rates = await api('/mileage-rates', { method: 'PUT', body: { rates } });
    toast('Rates saved');
    route();
  }),
  logout: guard(async () => { await api('/logout', { method: 'POST' }); showLogin(); }),
  'csv-jobs': () => downloadCsv('jobs.csv', ['Date', 'Customer', 'Job', 'Status', 'Total', 'Notes'], state.orders.map(o => [o.service_date, o.customer_name, o.title, o.status, o.total, o.notes])),
  'csv-invoices': () => downloadCsv('invoices.csv', ['Number', 'Customer', 'Issued', 'Due', 'Status', 'Paid date', 'Payment method', 'Subtotal', 'Discount', 'Tax', 'Total'], state.invoices.map(i => [i.number, i.customer_name, i.issue_date, i.due_date, i.status, i.paid_date, i.payment_method, i.subtotal, i.discount, i.tax, i.total])),
  'csv-customers': () => downloadCsv('customers.csv', ['Name', 'Phone', 'Email', 'Address', 'Notes'], state.customers.map(c => [c.name, c.phone, c.email, c.address, c.notes])),
  'csv-expenses': () => downloadCsv(`expenses-${ui.year}.csv`, ['Date', 'Vendor', 'Description', 'Category', 'Amount', 'Paid with', 'Reference', 'Receipts'], state.expenses.filter(e => (e.date || '').startsWith(String(ui.year))).map(e => [e.date, e.vendor, e.description, e.category, e.amount, e.payment_method, e.reference, e.receipts.length])),
  'csv-mileage': () => downloadCsv(`mileage-${ui.year}.csv`, ['Date', 'Customer', 'From', 'To', 'Miles', 'Round trip', 'Rate', 'Deduction', 'Purpose'], state.mileage.trips.filter(t => (t.date || '').startsWith(String(ui.year))).map(t => [t.date, t.customer_name, t.from_addr, t.to_addr, t.total_miles, t.round_trip ? 'yes' : 'no', t.rate, t.deduction, t.purpose])),
};

document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { const d = close.closest('dialog'); if (d) d.close(); return; }
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = ACTIONS[t.dataset.act];
  if (fn) { e.preventDefault(); fn(t, e); }
});

function updateBadge() {
  const n = state.inquiries.filter(q => q.status === 'New').length;
  const link = $('#nav a[data-view="inbox"]');
  if (!link) return;
  const badge = $('.badge', link);
  if (badge) badge.remove();
  if (n) link.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`);
}

function renderShell() {
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">
      <a class="brand" href="#/dashboard"><span class="mark" aria-hidden="true">PSS</span><span class="brand-name">${esc(state.settings.business_name || 'Page Smart Solutions')}</span></a>
      <nav id="nav" aria-label="Admin">${NAV.map(([k, label]) => `<a href="#/${k}" data-view="${k}">${label}</a>`).join('')}</nav>
      <div class="side-foot"><a href="/" target="_blank" rel="noopener">View public site</a><button class="btn small" data-act="logout">Sign out</button></div>
    </aside><main id="main"></main></div>`;
}

async function route() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard';
  ui.view = VIEWS[name] ? name : 'dashboard';
  if (!$('#main')) renderShell();
  $$('#nav a').forEach(a => { if (a.dataset.view === ui.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  updateBadge();
  try {
    await VIEWS[ui.view]($('#main'));
  } catch (e) {
    if (e.message !== 'auth') $('#main').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
  document.title = (NAV.find(n => n[0] === ui.view) || [0, 'Admin'])[1] + ' | Page Smart Solutions';
}
window.addEventListener('hashchange', () => { if (state.signedIn) route(); });

function showLogin(message = '') {
  state.signedIn = false;
  [dlg, dlg2].forEach(closeDialog);
  $('#app').innerHTML = `<div class="login"><form id="login-form">
    <div class="brand"><span class="mark" aria-hidden="true">PSS</span><span class="brand-name">Admin</span></div>
    <h1>Sign in</h1>
    <label>Password<input type="password" name="password" required autocomplete="current-password" autofocus></label>
    <p class="err" id="login-err" role="alert">${esc(message)}</p>
    <button class="btn primary" type="submit">Sign in</button></form></div>`;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { password: e.target.elements.password.value } });
      await start();
    } catch (err) { $('#login-err').textContent = err.message; }
  });
}

async function start() {
  await reload();
  state.signedIn = true;
  renderShell();
  route();
}

(async () => {
  try {
    await api('/me');
    await start();
  } catch (e) {
    if (e.message !== 'auth') showLogin(e.message);
  }
})();

})();
