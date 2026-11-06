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
