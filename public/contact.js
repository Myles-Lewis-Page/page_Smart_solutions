// Admin sign in popup. Signing in keeps you on the site; the button then says Admin and opens the admin pages.
(function () {
  'use strict';
  var links = document.querySelectorAll('[data-admin]');
  var dlg = document.getElementById('admin-dialog');
  var form = document.getElementById('admin-login');
  if (!links.length || !dlg || !form || typeof dlg.showModal !== 'function') return;
  var err = document.getElementById('admin-err');
  var signedIn = false;
  function store(v) { try { if (v === undefined) return localStorage.getItem('pss_user') || ''; localStorage.setItem('pss_user', v); } catch (e) { return ''; } return ''; }
  function label() { for (var i = 0; i < links.length; i++) links[i].textContent = signedIn ? 'Admin' : 'Admin login'; }
  fetch('/api/session', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) { signedIn = !!d.signedIn; label(); })
    .catch(function () {});
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (e) {
      if (signedIn) return; // already signed in: the link goes straight to /admin
      e.preventDefault();
      err.textContent = '';
      form.elements.username.value = store();
      dlg.showModal();
      (form.elements.username.value ? form.elements.password : form.elements.username).focus();
    });
  }
  Array.prototype.forEach.call(dlg.querySelectorAll('[data-admin-close]'), function (b) { b.addEventListener('click', function () { dlg.close(); }); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    err.textContent = '';
    fetch('/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.d.error || 'Could not sign in.');
        store(form.elements.username.value.trim().toLowerCase());
        form.elements.password.value = '';
        signedIn = true;
        label();
        dlg.close();
      })
      .catch(function (x) { err.textContent = x.message || 'Could not sign in.'; })
      .then(function () { btn.disabled = false; });
  });
})();

(function () {
  'use strict';
  var form = document.getElementById('contact-form');
  if (!form) return;
  var note = document.getElementById('form-note');
  var button = form.querySelector('button[type="submit"]');
  form.elements.ts.value = String(Date.now());

  function say(text, kind) {
    note.textContent = text;
    note.className = 'form-note' + (kind ? ' ' + kind : '');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = form.elements;
    if (!f.name.value.trim()) { say('Please enter your name.', 'err'); f.name.focus(); return; }
    if (!f.email.value.trim() && !f.phone.value.trim()) { say('Please add an email or phone number so I can reply.', 'err'); f.email.focus(); return; }
    if (f.message.value.trim().length < 5) { say('Please add a short message.', 'err'); f.message.focus(); return; }

    button.disabled = true;
    say('Sending...');
    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: f.name.value, email: f.email.value, phone: f.phone.value,
        service: f.service.value, preferred: f.preferred.value, message: f.message.value,
        website: f.website.value, ts: f.ts.value
      })
    })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.d.error || 'Could not send your message.');
        form.reset();
        form.elements.ts.value = String(Date.now());
        say('Thanks. Your message is in and I will reply soon.', 'ok');
      })
      .catch(function (err) { say(err.message || 'Could not send your message. Please try again.', 'err'); })
      .then(function () { button.disabled = false; });
  });
})();
