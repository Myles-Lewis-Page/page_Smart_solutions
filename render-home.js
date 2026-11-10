'use strict';
// Server-rendered public homepage: services and rates, contact numbers, contact form.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (Number(n) % 1 ? '$' + Number(n).toFixed(2) : '$' + Number(n));
const telHref = p => 'tel:' + String(p).replace(/[^\d+]/g, '');

function price(s) {
  const p = s.price;
  if (p == null) return { lead: '', amount: s.price_label || 'Quote', unit: '' };
  const unit = s.billing === 'Hourly' ? '/ hr' : s.billing === 'Device' ? '/ device' : '';
  return { lead: s.price_label || '', amount: money(p), unit };
}

function group(services) {
  const order = [];
  const map = new Map();
  for (const s of services) {
    if (!map.has(s.category)) { map.set(s.category, []); order.push(s.category); }
    map.get(s.category).push(s);
  }
  return order.map(name => ({ name, items: map.get(name) }));
}

const DIAGRAM = `
<svg class="diagram" viewBox="0 0 520 400" role="img" aria-label="A home network: one router connected to a laptop, a smart lock, a thermostat, smart lights, and a mesh node">
  <g class="links">
    <path d="M260 200 L110 90"/><path d="M260 200 L420 80"/><path d="M260 200 L450 250"/>
    <path d="M260 200 L100 300"/><path d="M260 200 L300 355"/>
  </g>
  <g class="pulse"><circle cx="260" cy="200" r="34"/><circle cx="260" cy="200" r="34"/></g>
  <g class="node hub"><rect x="226" y="176" width="68" height="48" rx="6"/><text x="260" y="205" text-anchor="middle">ROUTER</text></g>
  <g class="node"><rect x="62" y="62" width="96" height="40" rx="6"/><text x="110" y="87" text-anchor="middle">LAPTOP</text></g>
  <g class="node"><rect x="372" y="52" width="96" height="40" rx="6"/><text x="420" y="77" text-anchor="middle">SMART LOCK</text></g>
  <g class="node"><rect x="398" y="230" width="104" height="40" rx="6"/><text x="450" y="255" text-anchor="middle">THERMOSTAT</text></g>
  <g class="node"><rect x="40" y="280" width="120" height="40" rx="6"/><text x="100" y="305" text-anchor="middle">SMART LIGHTS</text></g>
  <g class="node"><rect x="248" y="335" width="104" height="40" rx="6"/><text x="300" y="360" text-anchor="middle">MESH NODE</text></g>
</svg>`;

function renderHome(s, services) {
  const groups = group(services);
  const phones = [s.business_phone, s.business_phone_2].filter(Boolean);
  const freeMin = Number(s.travel_free_minutes) || 0;
  const rate = Number(s.travel_rate) || 0;
  const round = Number(s.travel_round_minutes) || 30;
  const minHrs = Number(s.onsite_minimum_hours) || 0;
  const name = esc(s.business_name);
  const area = esc(s.service_area);

  const phoneLinks = phones.map(p => `<a class="btn" href="${esc(telHref(p))}">${esc(p)}</a>`).join('');
  const phoneBlock = phones.length
    ? `<div class="reach">
         <h3>Call or text</h3>
         <ul class="numbers">${phones.map(p => `<li><a href="${esc(telHref(p))}">${esc(p)}</a></li>`).join('')}</ul>
       </div>`
    : '';
  const emailBlock = s.business_email
    ? `<div class="reach"><h3>Email</h3><p><a href="mailto:${esc(s.business_email)}">${esc(s.business_email)}</a></p></div>`
    : '';

  const serviceOptions = groups.filter(g => g.name !== 'Fees & Policies')
    .map(g => `<option>${esc(g.name)}</option>`).join('');

  const groupsHtml = groups.map(g => `
    <section class="rate-group" aria-labelledby="g-${esc(g.name.replace(/\W+/g, '-'))}">
      <h3 id="g-${esc(g.name.replace(/\W+/g, '-'))}">${esc(g.name)}</h3>
      <ul class="rates">
        ${g.items.map(it => {
          const p = price(it);
          return `<li>
            <div class="r-name"><span>${esc(it.name)}</span>${it.info ? `<small>${esc(it.info)}</small>` : ''}</div>
            <span class="leader" aria-hidden="true"></span>
            <div class="r-price">${p.lead ? `<em>${esc(p.lead)}</em> ` : ''}<b>${esc(p.amount)}</b>${p.unit ? ` <i>${esc(p.unit)}</i>` : ''}</div>
          </li>`;
        }).join('')}
      </ul>
    </section>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} | ${esc(s.business_tagline)}</title>
<meta name="description" content="${esc(s.business_tagline)} in ${area}. Troubleshooting, Wi-Fi and networking, custom PC builds, and smart home setup. See rates and send a message.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/home.css">
</head>
<body class="home">
<a class="skip" href="#services">Skip to services</a>
<header class="top">
  <div class="wrap bar">
    <a class="brand" href="/" aria-label="${name} home"><span class="mark" aria-hidden="true">PSS</span><span class="brand-name">${name}</span></a>
    <nav aria-label="Main">
      <a href="#services">Services</a>
      <a href="#travel">Travel</a>
      <a class="btn small" href="/admin" rel="nofollow" data-admin>Admin login</a>
      <a class="btn small primary" href="#contact">Contact me</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">${esc(s.business_tagline)} &middot; ${area}</p>
        <h1>Tech help that comes to your door.</h1>
        <p class="lede">Slow Wi-Fi, a PC that will not behave, a custom build, or a house full of smart devices that need to work together. One person, fair rates, and a clear price before I start.</p>
        <div class="cta">
          <a class="btn primary" href="#contact">Contact me</a>
          ${phoneLinks}
        </div>
        <p class="free-note"><span class="dot" aria-hidden="true"></span>${freeMin ? `Travel is free within ${freeMin} minutes of my home base.` : 'Travel is billed from when I leave.'}</p>
      </div>
      <div class="hero-art">${DIAGRAM}</div>
    </div>
  </section>

  <section id="services" class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>Services and rates</h2>
        <p>Flat prices where the job is predictable, hourly where it is not. Parts and hardware are billed at cost.</p>
      </div>
      <div class="rate-grid">${groupsHtml}</div>
    </div>
  </section>

  <section id="travel" class="section alt">
    <div class="wrap travel">
      <div>
        <h2>How travel is billed</h2>
        <p>Drive time is shown on the invoice as its own line, so there are no surprises.</p>
      </div>
      <ol class="travel-rules">
        <li><b>Within ${freeMin} minutes</b> of my home base: no travel charge.</li>
        <li><b>Farther out:</b> round trip is billed at ${money(rate)} per hour, rounded to the nearest ${round} minutes, with a ${round} minute minimum.</li>
        ${minHrs ? `<li><b>On-site visits</b> have a ${minHrs} hour minimum, then ${round} minute increments.</li>` : ''}
        <li><b>Remote support</b> has no travel charge.</li>
      </ol>
    </div>
  </section>

  <section id="contact" class="section">
    <div class="wrap contact">
      <div class="contact-info">
        <h2>Contact me</h2>
        <p>Tell me what is going on and I will reply with next steps and a price range. Most messages get an answer the same day.</p>
        ${phoneBlock}
        ${emailBlock}
        <div class="reach"><h3>Service area</h3><p>${area}</p></div>
      </div>
      <form id="contact-form" class="form" novalidate>
        <div class="row">
          <label>Name<input name="name" required maxlength="100" autocomplete="name"></label>
          <label>Phone<input name="phone" type="tel" maxlength="40" autocomplete="tel"></label>
        </div>
        <label>Email<input name="email" type="email" maxlength="200" autocomplete="email"></label>
        <div class="row">
          <label>What do you need help with?
            <select name="service"><option value="">Choose one</option>${serviceOptions}<option>Not sure yet</option></select>
          </label>
          <label>Best way to reach you
            <select name="preferred"><option>Text</option><option>Call</option><option>Email</option></select>
          </label>
        </div>
        <label>Message<textarea name="message" rows="5" required maxlength="3000" placeholder="What is happening, which devices are involved, and when works for you."></textarea></label>
        <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <input type="hidden" name="ts" value="">
        <button class="btn primary" type="submit">Send message</button>
        <p class="form-note" id="form-note" role="status" aria-live="polite"></p>
      </form>
    </div>
  </section>
</main>

<footer class="foot">
  <div class="wrap foot-bar">
    <span>&copy; ${new Date().getFullYear()} ${name}</span>
    <span>${area} &middot; <a href="/admin" rel="nofollow" data-admin>Admin login</a></span>
  </div>
</footer>
<dialog id="admin-dialog" class="admin-dlg" aria-labelledby="admin-dlg-title">
  <form id="admin-login" method="dialog">
    <div class="admin-dlg-head"><h2 id="admin-dlg-title">Admin sign in</h2><button type="button" class="admin-dlg-x" data-admin-close aria-label="Close">&times;</button></div>
    <label>Username<input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <p class="admin-dlg-err" id="admin-err" role="alert"></p>
    <div class="admin-dlg-actions"><button type="button" class="btn" data-admin-close>Cancel</button><button type="submit" class="btn primary">Sign in</button></div>
  </form>
</dialog>
<script src="/contact.js" defer></script>
</body>
</html>`;
}

module.exports = { renderHome };
