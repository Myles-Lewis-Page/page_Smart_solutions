'use strict';
// Runs the whole API against an in-memory database. Usage: npm test
process.env.LOCAL_DB_DIR = 'memory://';
process.env.ADMIN_PASSWORD = 'test-pass';
delete process.env.DATABASE_URL;

const assert = require('assert');
const { start } = require('../server');
const { computeTax, DEFAULT_BRACKETS_2026 } = require('../tax');

let base, cookie = '';
async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ok  ' + name); };

(async () => {
  const server = await start(0);
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    // public
    let r = await call('GET', '/healthz'); ok('healthz', r.status === 200);
    r = await call('GET', '/'); ok('homepage renders services', r.status === 200 && r.data.includes('Services and rates') && r.data.includes('Network troubleshooting'));
    ok('homepage has contact form', r.data.includes('id="contact-form"'));
    r = await call('GET', '/api/customers'); ok('api requires login', r.status === 401);
    r = await call('POST', '/api/login', { password: 'nope' }); ok('bad password rejected', r.status === 401);
    r = await call('POST', '/api/login', { password: 'test-pass' });
    ok('login ok', r.status === 200);
    cookie = r.headers.get('set-cookie').split(';')[0];

    // contact form
    let pub = await fetch(base + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pat', email: 'pat@example.com', message: 'Wi-Fi is slow', ts: Date.now() - 10000 }) });
    ok('contact form accepted', pub.status === 200);
    pub = await fetch(base + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bot', email: 'b@example.com', message: 'spam spam', website: 'x' }) });
    ok('honeypot accepted silently', pub.status === 200);
    r = await call('GET', '/api/inquiries'); ok('inquiry stored once', r.data.length === 1 && r.data[0].name === 'Pat');

    // services + settings
    r = await call('GET', '/api/services'); ok('services seeded', r.data.length >= 28);
    const netTs = r.data.find(s => s.name === 'Network troubleshooting');
    ok('network troubleshooting is $75', netTs.price === 75);
    r = await call('GET', '/api/settings'); ok('settings defaults', r.data.travel_free_minutes === '15');

    // customer, job, invoice
    r = await call('POST', '/api/customers', { name: 'Test Customer', phone: '555-0100', address: '1 Main St, Georgetown, TX' });
    const cust = r.data; ok('customer created', cust.id > 0);
    r = await call('POST', '/api/orders', {
      customer_id: cust.id, title: 'Wi-Fi fix', status: 'Completed', service_date: '2026-07-06',
      items: [
        { desc: 'Network troubleshooting', billing: 'Hourly', rate: 75, qty: 2, kind: 'service', service_id: netTs.id },
        { desc: 'Travel (20 min each way)', billing: 'Hourly', rate: 50, qty: 0.5, kind: 'travel' },
      ],
    });
    const order = r.data; ok('job total is 175', order.total === 175);
    r = await call('POST', `/api/orders/${order.id}/invoice`, { paid: true, payment_method: 'Venmo', paid_date: '2026-07-07' });
    const invId = r.data.id; ok('invoice created paid', invId > 0);
    r = await call('GET', `/api/invoices/${invId}`);
    ok('invoice number format', /^PSS-\d{4}-0001$/.test(r.data.number));
    ok('invoice paid with total 175', r.data.status === 'Paid' && r.data.total === 175 && r.data.paid_date === '2026-07-07');
    ok('invoice includes customer', r.data.customer && r.data.customer.name === 'Test Customer');
    r = await call('POST', `/api/orders/${order.id}/invoice`, {}); ok('second invoice request returns existing', r.data.existing === true);
    r = await call('GET', '/api/orders'); ok('job marked Invoiced', r.data[0].status === 'Invoiced' && r.data[0].invoice_id === invId);

    // expenses + receipt
    r = await call('POST', '/api/expenses', { date: '2026-07-05', vendor: 'Amazon', description: 'Parts', category: 'Equipment & parts', amount: 50.25, reference: 'Order 112-0000000-0000000' });
    const exp = r.data; ok('expense created', exp.id > 0);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    r = await call('POST', `/api/expenses/${exp.id}/receipts`, png, { 'Content-Type': 'image/png', 'X-Filename': 'amazon%20receipt.png' });
    ok('receipt uploaded', r.status === 200 && r.data.size === png.length);
    const rid = r.data.id;
    const file = await fetch(base + '/api/receipts/' + rid, { headers: { Cookie: cookie } });
    const bytes = Buffer.from(await file.arrayBuffer());
    ok('receipt downloads identical bytes', file.status === 200 && bytes.equals(png));
    r = await call('POST', `/api/expenses/${exp.id}/receipts`, Buffer.from('<script>x</script>'), { 'Content-Type': 'text/html' });
    ok('non-image receipt rejected', r.status === 400);
    r = await call('GET', '/api/expenses'); ok('expense lists its receipt', r.data[0].receipts.length === 1);

    // mileage with date based rates
    r = await call('POST', '/api/mileage', { date: '2026-06-30', miles: 10, round_trip: true, purpose: 'Customer visit' });
    ok('June trip uses 72.5 cents', r.data.rate === 0.725 && r.data.total_miles === 20 && r.data.deduction === 14.5);
    r = await call('POST', '/api/mileage', { date: '2026-07-06', miles: 10, round_trip: true, purpose: 'Customer visit' });
    ok('July trip uses 76 cents', r.data.rate === 0.76 && r.data.deduction === 15.2);

    // tax
    r = await call('PUT', '/api/tax/2026', { salary: 55000, fed_withholding: 4000, std_deduction: 16100, ss_wage_base: 184500, qbi_enabled: false });
    const t = r.data;
    ok('revenue counts paid invoice', t.inputs.revenue === 175);
    ok('expenses counted', t.inputs.expenses === 50.25);
    ok('mileage deduction summed', t.inputs.mileageDeduction === 29.7);
    ok('net profit', t.result.netProfit === 95.05);
    ok('no SE tax under $400 of SE earnings', t.result.seApplies === false && t.result.seTax === 0);
    ok('side income taxed at 12%', Math.abs(t.result.sideIncomeTax - 11.41) < 0.02);
    r = await call('GET', '/api/dashboard'); ok('dashboard works', r.status === 200 && r.data.paidYtd === 175);

    // deleting an invoice reopens the job
    r = await call('DELETE', `/api/invoices/${invId}`); ok('invoice deleted', r.status === 200);
    r = await call('GET', '/api/orders'); ok('job back to Completed', r.data[0].status === 'Completed');

    // pure tax checks
    const big = computeTax({ revenue: 10000, expenses: 0, mileageDeduction: 0, salary: 55000, withholding: 0, stdDeduction: 16100, ssWageBase: 184500, brackets: DEFAULT_BRACKETS_2026, qbiEnabled: false });
    ok('SE tax on $10,000 profit is $1,412.96', Math.abs(big.seTax - 1412.96) < 0.01);
    ok('half of SE tax is deducted', Math.abs(big.halfSe - 706.48) < 0.01);

    console.log('\nAll checks passed.');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
