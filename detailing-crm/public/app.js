'use strict';
/* Detailing CRM — single-page frontend (no build step, no dependencies). */

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', canceled: 'Canceled', no_show: 'No-show' };
const state = { me: null, services: [], techs: [], currency: 'GBP', cal: { view: 'month', date: new Date(), tech: '' } };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { state.me = null; renderLogin(); throw Object.assign(new Error('Please log in'), { silent: true }); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 2500);
}
const fail = (e) => { if (!e.silent) toast(e.message, true); };

const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency || 'GBP' }).format(Number(n) || 0);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (iso) => iso ? `${new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(iso)}` : '';
const statusBadge = (s) => `<span class="badge st-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const vehicleLabel = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ') + (v.plate ? ` (${v.plate})` : '');
const isAdmin = () => state.me?.role === 'admin';
const pad = (n) => String(n).padStart(2, '0');
// value for <input type="datetime-local"> in the browser's local time
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; return addDays(x, -dow); }; // Monday

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

// ---------- modal ----------
function modal(title, html, { wide = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="${wide ? 'max-width:900px' : ''}">
    <div class="modal-head"><h2 style="margin:0">${esc(title)}</h2><button class="x" aria-label="Close">&times;</button></div>
    <div class="modal-body">${html}</div></div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  $('.x', bg).onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  return { el: bg, close };
}
const confirmBox = (msg) => window.confirm(msg);

function lightbox(src) {
  const m = modal('Photo', `<img src="${esc(src)}" style="width:100%;border-radius:8px" alt="">`, { wide: true });
  return m;
}

// ---------- image resize before upload (keeps uploads small on mobile data) ----------
function resizeImage(file, max = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image file'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image (HEIC? try JPEG/PNG)')); };
    img.src = url;
  });
}

// ---------- shell & routing ----------
const NAV_ADMIN = [
  ['dashboard', 'Dashboard', '📊'], ['calendar', 'Calendar', '📅'], ['customers', 'Customers', '👥'],
  ['invoices', 'Invoices', '🧾'], ['inventory', 'Inventory', '📦'], ['team', 'Team & Services', '🛠️'],
  ['messages', 'Messages', '✉️'], ['settings', 'Settings', '⚙️'],
];
const NAV_EMP = [['jobs', 'My Jobs', '🧽'], ['calendar', 'Calendar', '📅'], ['account', 'Account', '👤']];

function renderShell() {
  const nav = isAdmin() ? NAV_ADMIN : NAV_EMP;
  const links = nav.map(([k, label, icon]) => `<a href="#/${k}" data-k="${k}"><span>${icon}</span>${esc(label)}</a>`).join('');
  $('#root').innerHTML = `<div class="app">
    <aside class="sidebar"><div class="brand">🚗 ${esc(state.me.business_name || 'Detailing CRM')}</div>
      <nav class="nav">${links}</nav>
      <div class="me"><div><strong>${esc(state.me.name)}</strong></div><div class="muted">${esc(state.me.role)}</div>
        <a href="#/account">Account</a> · <a href="#" id="logout">Log out</a></div></aside>
    <main id="main"></main>
    <nav class="mobile-nav">${nav.map(([k, label, icon]) => `<a href="#/${k}" data-k="${k}">${icon}<br>${esc(label.split(' ')[0])}</a>`).join('')}</nav>
  </div>`;
  $('#logout').onclick = async (e) => { e.preventDefault(); await api('POST', '/api/logout').catch(() => {}); state.me = null; renderLogin(); };
}

const routes = {};
async function router() {
  if (!state.me) return;
  const parts = (location.hash.replace(/^#\/?/, '') || (isAdmin() ? 'dashboard' : 'jobs')).split('/');
  const [name, id] = parts;
  $$('.nav a, .mobile-nav a').forEach((a) => a.classList.toggle('active', a.dataset.k === name));
  const main = $('#main');
  const fn = routes[name];
  if (!fn) { main.innerHTML = '<div class="empty">Page not found</div>'; return; }
  main.innerHTML = '<div class="empty">Loading…</div>';
  try { await fn(main, id); } catch (e) { fail(e); main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

async function loadLookups() {
  [state.services, state.techs] = await Promise.all([api('GET', '/api/services'), api('GET', '/api/technicians')]);
}

function renderLogin() {
  $('#root').innerHTML = `<div class="login"><div class="card">
    <h1 style="margin-bottom:1rem">🚗 Detailing CRM</h1>
    <form id="login" class="grid">
      <div><label for="le">Email</label><input id="le" name="email" type="email" autocomplete="username" required></div>
      <div><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary" type="submit">Log in</button>
    </form></div></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', formData(e.target)); await boot(); } catch (err) { fail(err); }
  };
}

async function boot() {
  try { state.me = await api('GET', '/api/me'); } catch { return; }
  await loadLookups();
  if (isAdmin()) { const s = await api('GET', '/api/settings'); state.currency = s.currency || 'GBP'; }
  renderShell();
  router();
}

// ---------- dashboard / reports ----------
function barChart(rows, key, fmt) {
  const W = 600, H = 220, padL = 44, padB = 24, padT = 8;
  const max = Math.max(1, ...rows.map((r) => r[key]));
  // 4 gridline steps of a 1/2/5×10^k size so tick labels are always round numbers
  const raw = max / 4; const p10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw);
  const nice = Math.max(step * 4, 4);
  const bw = (W - padL) / rows.length;
  const y = (v) => H - padB - ((H - padB - padT) * v) / nice;
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = (nice * i) / 4;
    svg += `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v, true))}</text>`;
  }
  rows.forEach((r, i) => {
    const x = padL + i * bw + bw * 0.18, w = bw * 0.64, h = Math.max(0, y(0) - y(r[key]));
    const label = new Date(r.month + '-01T12:00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    // rounded top (4px), square at baseline
    const rr = Math.min(4, w / 2, h);
    const d = h > 0 ? `M${x},${y(0)} V${y(r[key]) + rr} Q${x},${y(r[key])} ${x + rr},${y(r[key])} H${x + w - rr} Q${x + w},${y(r[key])} ${x + w},${y(r[key]) + rr} V${y(0)} Z` : '';
    // hit target spans the whole column so small bars are easy to hover/tap
    svg += `<g data-tip="${esc(label)}: ${esc(fmt(r[key]))}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padB - padT}" fill="transparent"/>${d ? `<path class="bar" d="${d}"/>` : ''}</g>`;
    if (rows.length <= 12 || i % 2 === 0) svg += `<text x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${svg}</svg></div>`;
}
function wireTips(root) {
  let tip;
  $$('[data-tip]', root).forEach((g) => {
    g.addEventListener('pointerenter', () => { tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = g.dataset.tip; document.body.appendChild(tip); });
    g.addEventListener('pointermove', (e) => { if (tip) { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px'; } });
    g.addEventListener('pointerleave', () => { tip?.remove(); tip = null; });
  });
}

routes.dashboard = async (main) => {
  const r = await api('GET', '/api/reports?months=12');
  state.currency = r.currency || state.currency;
  const cur = r.monthly[r.monthly.length - 1];
  const prev = r.monthly[r.monthly.length - 2] || { revenue: 0 };
  const delta = prev.revenue ? Math.round(((cur.revenue - prev.revenue) / prev.revenue) * 100) : null;
  const statusLine = Object.keys(STATUS_LABEL).map((s) => {
    const n = r.statusCounts.find((x) => x.status === s)?.n || 0;
    return `<span style="--c:var(--st-${s})">${STATUS_LABEL[s]} ${n}</span>`;
  }).join('');
  main.innerHTML = `
    <div class="topbar"><h1>Dashboard</h1><button class="btn primary" id="newAppt">+ New booking</button></div>
    ${r.lowStock.length ? `<div class="alert">⚠️ Low stock: ${r.lowStock.map((i) => `<strong>${esc(i.name)}</strong> (${esc(i.quantity)} ${esc(i.unit)})`).join(', ')} — <a href="#/inventory">manage inventory</a></div>` : ''}
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Revenue this month</div><div class="value">${money(cur.revenue)}</div>
        <div class="small muted">${delta === null ? 'No revenue last month' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs last month`}</div></div>
      <div class="card kpi"><div class="label">Bookings this month</div><div class="value">${cur.bookings}</div><div class="small muted">${cur.completed} completed</div></div>
      <div class="card kpi"><div class="label">Upcoming jobs</div><div class="value">${r.upcoming}</div><div class="small muted">pending + confirmed</div></div>
      <div class="card kpi"><div class="label">Customer retention</div><div class="value">${Math.round(r.retention.rate * 100)}%</div>
        <div class="small muted">${r.retention.returning} of ${r.retention.total} customers returned</div></div>
      <div class="card kpi"><div class="label">Unpaid invoices</div><div class="value">${money(r.outstanding.total)}</div><div class="small muted">${r.outstanding.n} invoices</div></div>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <div class="card"><h2>Monthly revenue</h2>${barChart(r.monthly, 'revenue', (v, axis) => axis ? (v >= 1000 ? (v / 1000) + 'k' : String(Math.round(v))) : money(v))}</div>
      <div class="card"><h2>Monthly bookings</h2>${barChart(r.monthly, 'bookings', (v, axis) => axis ? String(Math.round(v)) : `${v} bookings`)}</div>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <div class="card"><h2>Today's jobs</h2><div class="legend" style="margin-bottom:.5rem">${statusLine} <span class="muted">(this month)</span></div>
        ${r.today.length ? r.today.map(apptListItem).join('') : '<div class="empty">No jobs today</div>'}</div>
      <div class="card"><h2>Top customers</h2>${r.topCustomers.length ? `<table><tr><th>Customer</th><th class="right">Visits</th><th class="right">Revenue</th></tr>
        ${r.topCustomers.map((c) => `<tr class="clickable" data-href="#/customers/${c.id}"><td>${esc(c.name)}</td><td class="right">${c.visits}</td><td class="right">${money(c.revenue)}</td></tr>`).join('')}</table>` : '<div class="empty">No completed jobs yet</div>'}
        <h2 style="margin-top:1.25rem">Most popular services</h2>${r.topServices.length ? `<table><tr><th>Service</th><th class="right">Bookings</th><th class="right">Revenue</th></tr>
        ${r.topServices.map((s) => `<tr><td>${esc(s.name)}</td><td class="right">${s.bookings}</td><td class="right">${money(s.revenue)}</td></tr>`).join('')}</table>` : '<div class="empty">No bookings yet</div>'}
      </div>
    </div>`;
  wireTips(main);
  wireApptItems(main);
  $$('tr[data-href]', main).forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
  $('#newAppt').onclick = () => apptForm({});
};

// ---------- appointments: list items, details, form ----------
function apptListItem(a) {
  return `<div class="list-item bd-${esc(a.status)}" data-appt="${a.id}">
    <div style="display:flex;justify-content:space-between;gap:.5rem"><strong>${esc(fmtTime(a.start_at))} · ${esc(a.customer_name)}</strong>${statusBadge(a.status)}</div>
    <div class="small muted">${esc(a.service_name || 'Custom job')}${a.plate || a.make ? ' · ' + esc(vehicleLabel(a)) : ''}${a.technician_name ? ' · 👤 ' + esc(a.technician_name) : ' · <em>unassigned</em>'}</div>
  </div>`;
}
function wireApptItems(root, onChange) {
  $$('[data-appt]', root).forEach((el) => (el.onclick = (e) => { e.stopPropagation(); apptDetail(+el.dataset.appt, onChange); }));
}

async function apptDetail(id, onChange = router) {
  let a;
  try { a = await api('GET', `/api/appointments/${id}`); } catch (e) { return fail(e); }
  const admin = isAdmin();
  const photosHtml = (kind) => {
    const list = a.photos.filter((p) => p.kind === kind);
    return `<div class="photos">${list.map((p) => `<div class="photo"><img src="/api/photos/${p.id}" alt="${kind}" loading="lazy" data-full="/api/photos/${p.id}">
      ${admin ? `<button class="btn sm danger del" data-delphoto="${p.id}" title="Delete">✕</button>` : ''}</div>`).join('') || '<span class="muted small">None yet</span>'}</div>
      <label class="btn sm" style="margin-top:.4rem;display:inline-flex;color:var(--text)">📷 Add ${kind} photo<input type="file" accept="image/*" capture="environment" multiple data-upload="${kind}" class="hidden"></label>`;
  };
  const m = modal(`${a.customer_name} — ${a.service_name || 'Job'}`, `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.75rem">${statusBadge(a.status)}
      ${a.series_id ? '<span class="badge light">🔁 ' + esc(a.recurrence) + '</span>' : ''}
      ${a.invoice_number ? `<span class="badge light">🧾 ${esc(a.invoice_number)} · ${esc(a.invoice_status)}</span>` : ''}</div>
    <table>
      <tr><th>When</th><td>${esc(fmtDateTime(a.start_at))} – ${esc(fmtTime(a.end_at))}</td></tr>
      <tr><th>Customer</th><td>${esc(a.customer_name)}<br><span class="small">${a.customer_phone ? `<a href="tel:${esc(a.customer_phone)}">${esc(a.customer_phone)}</a>` : ''} ${a.customer_email ? `· <a href="mailto:${esc(a.customer_email)}">${esc(a.customer_email)}</a>` : ''}</span>
        ${a.customer_address ? `<br><a class="small" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(a.customer_address)}">📍 ${esc(a.customer_address)}</a>` : ''}</td></tr>
      <tr><th>Vehicle</th><td>${a.make || a.plate ? esc(vehicleLabel(a)) + (a.vehicle_color ? ', ' + esc(a.vehicle_color) : '') : '—'}</td></tr>
      <tr><th>Technician</th><td>${esc(a.technician_name || 'Unassigned')}</td></tr>
      <tr><th>Price</th><td>${money(a.price)}</td></tr>
      ${a.notes ? `<tr><th>Job notes</th><td style="white-space:pre-wrap">${esc(a.notes)}</td></tr>` : ''}
      ${a.customer_notes ? `<tr><th>Customer notes</th><td style="white-space:pre-wrap">${esc(a.customer_notes)}</td></tr>` : ''}
    </table>
    <h3>Before photos</h3>${photosHtml('before')}
    <h3>After photos</h3>${photosHtml('after')}
    ${admin ? `<h3>Messages</h3>
      <div class="btn-group"><button class="btn sm" data-notify="confirmation">Resend confirmation</button>
      <button class="btn sm" data-notify="reminder">Send reminder</button><button class="btn sm" data-notify="followup">Send follow-up</button></div>
      <div class="small muted" style="margin-top:.4rem">${(a.notifications || []).slice(0, 6).map((n) => `${esc(fmtDateTime(n.created_at))} · ${esc(n.type)} via ${esc(n.channel)} → ${esc(n.status)}${n.error ? ' (' + esc(n.error) + ')' : ''}`).join('<br>') || 'No messages sent yet'}</div>` : ''}
    <div class="modal-foot">
      ${admin ? `<button class="btn danger" id="del">Delete</button><button class="btn" id="edit">Edit</button>
        <select id="st" style="width:auto">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}</select>`
      : (a.status !== 'completed' ? '<button class="btn primary" id="complete">✓ Mark job completed</button>' : '<button class="btn" id="reopen">Reopen job</button>')}
      ${admin && a.invoice_id ? `<a class="btn" href="#/invoices/${a.invoice_id}">View invoice</a>` : ''}
    </div>`);
  const reload = () => { m.close(); onChange(); apptDetail(id, onChange); };
  const setStatus = async (status) => {
    try { await api('PUT', `/api/appointments/${id}`, { status }); toast(`Marked ${STATUS_LABEL[status]}`); reload(); } catch (e) { fail(e); }
  };
  $$('img[data-full]', m.el).forEach((img) => (img.onclick = () => lightbox(img.dataset.full)));
  $$('[data-upload]', m.el).forEach((inp) => (inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    toast(`Uploading ${files.length} photo(s)…`);
    try {
      for (const f of files) await api('POST', `/api/appointments/${id}/photos`, { kind: inp.dataset.upload, data: await resizeImage(f) });
      toast('Photos uploaded'); reload();
    } catch (e) { fail(e); }
  }));
  $$('[data-delphoto]', m.el).forEach((b) => (b.onclick = async () => {
    if (!confirmBox('Delete this photo?')) return;
    try { await api('DELETE', `/api/photos/${b.dataset.delphoto}`); reload(); } catch (e) { fail(e); }
  }));
  $$('[data-notify]', m.el).forEach((b) => (b.onclick = async () => {
    try {
      const r = await api('POST', `/api/appointments/${id}/notify`, { type: b.dataset.notify });
      toast(r.results.length ? r.results.map((x) => `${x.channel}: ${x.status}`).join(', ') : 'Customer has no phone/email (or opted out)');
      reload();
    } catch (e) { fail(e); }
  }));
  if (admin) {
    $('#st', m.el).onchange = (e) => setStatus(e.target.value);
    $('#edit', m.el).onclick = () => { m.close(); apptForm(a, onChange); };
    $('#del', m.el).onclick = async () => {
      let scope = '';
      if (a.series_id) {
        const all = confirmBox('This is a recurring booking.\nOK = delete this AND all future occurrences\nCancel = choose to delete only this one');
        if (all) scope = '?scope=future';
        else if (!confirmBox('Delete only this occurrence?')) return;
      } else if (!confirmBox('Delete this booking? This cannot be undone.')) return;
      try { const r = await api('DELETE', `/api/appointments/${id}${scope}`); toast(`Deleted ${r.deleted} booking(s)`); m.close(); onChange(); } catch (e) { fail(e); }
    };
  } else {
    const c = $('#complete', m.el); if (c) c.onclick = () => setStatus('completed');
    const ro = $('#reopen', m.el); if (ro) ro.onclick = () => setStatus('confirmed');
  }
}

async function apptForm(a = {}, onSaved = router, preset = {}) {
  const customers = await api('GET', '/api/customers').catch((e) => { fail(e); return null; });
  if (!customers) return;
  if (!customers.length) { toast('Add a customer first', true); location.hash = '#/customers'; return; }
  const editing = !!a.id;
  const start = a.start_at ? new Date(a.start_at) : (preset.date || (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })());
  const dur = a.id ? Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000) : '';
  const custId = a.customer_id || preset.customer_id || '';
  const m = modal(editing ? 'Edit booking' : 'New booking', `
    <form class="form" id="af">
      <div class="full"><label>Customer *</label><select name="customer_id" required><option value="">Select customer…</option>
        ${customers.map((c) => `<option value="${c.id}" ${c.id == custId ? 'selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('')}</select></div>
      <div><label>Vehicle</label><select name="vehicle_id"><option value="">—</option></select></div>
      <div><label>Service</label><select name="service_id"><option value="">Custom</option>
        ${state.services.filter((s) => s.active || s.id === a.service_id).map((s) => `<option value="${s.id}" data-price="${s.price}" data-dur="${s.duration_min}" ${s.id === a.service_id ? 'selected' : ''}>${esc(s.name)} · ${money(s.price)}</option>`).join('')}</select></div>
      <div><label>Start *</label><input type="datetime-local" name="start_at" required value="${toLocalInput(start)}"></div>
      <div><label>Duration (min)</label><input type="number" name="duration_min" min="5" step="5" value="${dur}" placeholder="from service"></div>
      <div><label>Price</label><input type="number" name="price" min="0" step="0.01" value="${a.id ? a.price : ''}" placeholder="from service"></div>
      <div><label>Technician</label><select name="technician_id"><option value="">Unassigned</option>
        ${state.techs.map((t) => `<option value="${t.id}" ${t.id === a.technician_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
      <div><label>Status</label><select name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === (a.status || 'confirmed') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      ${editing ? '' : `<div><label>Repeat</label><select name="recurrence"><option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Monthly</option></select></div>
      <div class="occ hidden"><label>Number of visits</label><input type="number" name="occurrences" min="2" max="52" value="8"></div>`}
      <div class="full"><label>Job notes / special requests</label><textarea name="notes">${esc(a.notes || '')}</textarea></div>
      ${editing ? '' : '<div class="full"><label class="check"><input type="checkbox" name="send_confirmation" checked> Send booking confirmation (SMS/email) now</label></div>'}
    </form>
    <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">${editing ? 'Save changes' : 'Create booking'}</button></div>`);
  const f = $('#af', m.el);
  const loadVehicles = async () => {
    const sel = f.vehicle_id; const cid = f.customer_id.value;
    sel.innerHTML = '<option value="">—</option>';
    if (!cid) return;
    const c = await api('GET', `/api/customers/${cid}`).catch(fail);
    if (!c) return;
    sel.innerHTML += c.vehicles.map((v) => `<option value="${v.id}" ${v.id === a.vehicle_id ? 'selected' : ''}>${esc(vehicleLabel(v))}</option>`).join('');
    if (!a.vehicle_id && c.vehicles.length === 1) sel.value = c.vehicles[0].id;
  };
  f.customer_id.onchange = loadVehicles; loadVehicles();
  if (f.recurrence) f.recurrence.onchange = () => $('.occ', f).classList.toggle('hidden', f.recurrence.value === 'none');
  $('#cancel', m.el).onclick = m.close;
  const save = async (force = false) => {
    if (!f.reportValidity()) return;
    const d = formData(f);
    const body = { ...d, start_at: new Date(d.start_at).toISOString(), force };
    if (body.duration_min === '') delete body.duration_min;
    if (body.price === '') delete body.price;
    $('#save', m.el).disabled = true;
    try {
      if (editing) await api('PUT', `/api/appointments/${a.id}`, body);
      else { const r = await api('POST', '/api/appointments', body); toast(r.ids.length > 1 ? `Created ${r.ids.length} recurring bookings` : 'Booking created'); }
      if (editing) toast('Booking updated');
      m.close(); onSaved();
    } catch (e) {
      $('#save', m.el).disabled = false;
      if (e.status === 409 && confirmBox(e.message.replace(/ Save again.*/, '') + '\n\nBook anyway?')) return save(true);
      if (e.status !== 409) fail(e);
    }
  };
  $('#save', m.el).onclick = () => save(false);
}

// ---------- calendar ----------
routes.calendar = async (main) => {
  const c = state.cal;
  const d = c.date;
  let from, to, title;
  if (c.view === 'month') {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    from = startOfWeek(first); to = addDays(from, 42);
    title = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } else if (c.view === 'week') {
    from = startOfWeek(d); to = addDays(from, 7);
    title = `${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(to, -1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } else {
    from = startOfDay(d); to = addDays(from, 1);
    title = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (c.tech && isAdmin()) q.set('technician_id', c.tech);
  const appts = await api('GET', `/api/appointments?${q}`);
  const onDay = (day) => appts.filter((a) => sameDay(new Date(a.start_at), day));
  const today = new Date();
  const evColor = (a) => `var(--st-${a.status})`;

  let body = '';
  if (c.view === 'month') {
    body = '<div class="month">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<div class="dow">${x}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const day = addDays(from, i); const list = onDay(day);
      body += `<div class="day ${day.getMonth() !== d.getMonth() ? 'other' : ''} ${sameDay(day, today) ? 'today' : ''}" data-day="${day.toISOString()}">
        <span class="num">${day.getDate()}</span>
        ${list.slice(0, 3).map((a) => `<span class="ev" data-appt="${a.id}" style="background:${evColor(a)}" title="${esc(fmtTime(a.start_at) + ' ' + a.customer_name)}">${esc(fmtTime(a.start_at))} ${esc(a.customer_name)}</span>`).join('')}
        ${list.length > 3 ? `<span class="more">+${list.length - 3} more</span>` : ''}</div>`;
    }
    body += '</div>';
  } else if (c.view === 'week') {
    body = '<div class="week">';
    for (let i = 0; i < 7; i++) {
      const day = addDays(from, i);
      body += `<div class="col ${sameDay(day, today) ? 'today' : ''}"><h4><a href="#" data-goday="${day.toISOString()}">${esc(day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}</a></h4>
        ${onDay(day).map(apptListItem).join('') || '<div class="small muted">—</div>'}</div>`;
    }
    body += '</div>';
  } else {
    const list = onDay(d);
    const startH = Math.min(7, ...list.map((a) => new Date(a.start_at).getHours()));
    const endH = Math.max(20, ...list.map((a) => { const e = new Date(a.end_at); return sameDay(e, d) ? e.getHours() + 1 : 24; }));
    const hourPx = 56;
    body = `<div class="dayview">${Array.from({ length: endH - startH }, (_, i) => `<div class="hour" data-hour="${startH + i}">${pad(startH + i)}:00</div>`).join('')}`;
    // simple overlap handling: split column among overlapping jobs
    const lanes = [];
    list.forEach((a) => {
      const s = new Date(a.start_at).getTime();
      let lane = lanes.findIndex((end) => end <= s);
      if (lane === -1) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = new Date(a.end_at).getTime();
      a._lane = lane;
    });
    const nl = Math.max(1, lanes.length);
    list.forEach((a) => {
      const s = new Date(a.start_at); const e = new Date(a.end_at);
      const top = ((s.getHours() + s.getMinutes() / 60) - startH) * hourPx;
      const endHours = sameDay(e, d) ? e.getHours() + e.getMinutes() / 60 : 24;
      const h = Math.max(24, (endHours - (s.getHours() + s.getMinutes() / 60)) * hourPx - 2);
      body += `<div class="block" data-appt="${a.id}" style="top:${top}px;height:${h}px;background:${evColor(a)};left:calc(56px + (100% - 64px) * ${a._lane / nl});right:auto;width:calc((100% - 64px) / ${nl})">
        <strong>${esc(fmtTime(a.start_at))}–${esc(fmtTime(a.end_at))}</strong> ${esc(a.customer_name)}<br>${esc(a.service_name || '')} ${a.technician_name ? '· ' + esc(a.technician_name) : ''}</div>`;
    });
    body += '</div>';
  }

  const legend = Object.keys(STATUS_LABEL).map((s) => `<span style="--c:var(--st-${s})">${STATUS_LABEL[s]}</span>`).join('');
  main.innerHTML = `
    <div class="topbar"><h1>Calendar</h1>${isAdmin() ? '<button class="btn primary" id="newAppt">+ New booking</button>' : ''}</div>
    <div class="cal-head">
      <div class="btn-group"><button class="btn sm" id="prev" aria-label="Previous">‹</button><button class="btn sm" id="today">Today</button><button class="btn sm" id="next" aria-label="Next">›</button></div>
      <div class="cal-title">${esc(title)}</div>
      <div class="btn-group">${['month', 'week', 'day'].map((v) => `<button class="btn sm ${c.view === v ? 'primary' : ''}" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      ${isAdmin() ? `<select id="tech" style="width:auto"><option value="">All technicians</option>${state.techs.map((t) => `<option value="${t.id}" ${String(t.id) === c.tech ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
      <div class="legend">${legend}</div>
    </div>${body}`;

  const rerender = () => routes.calendar(main).catch(fail);
  const shift = (n) => {
    const x = new Date(c.date);
    if (c.view === 'month') { x.setDate(1); x.setMonth(x.getMonth() + n); } else x.setDate(x.getDate() + (c.view === 'week' ? 7 : 1) * n);
    c.date = x; rerender();
  };
  $('#prev').onclick = () => shift(-1); $('#next').onclick = () => shift(1);
  $('#today').onclick = () => { c.date = new Date(); rerender(); };
  $$('[data-view]').forEach((b) => (b.onclick = () => { c.view = b.dataset.view; rerender(); }));
  if ($('#tech')) $('#tech').onchange = (e) => { c.tech = e.target.value; rerender(); };
  if ($('#newAppt')) $('#newAppt').onclick = () => apptForm({}, rerender);
  wireApptItems(main, rerender);
  $$('[data-day]').forEach((el) => (el.onclick = () => { c.date = new Date(el.dataset.day); c.view = 'day'; rerender(); }));
  $$('[data-goday]').forEach((el) => (el.onclick = (e) => { e.preventDefault(); c.date = new Date(el.dataset.goday); c.view = 'day'; rerender(); }));
  if (isAdmin()) $$('[data-hour]').forEach((el) => (el.onclick = () => {
    const x = new Date(c.date); x.setHours(+el.dataset.hour, 0, 0, 0); apptForm({}, rerender, { date: x });
  }));
};

// ---------- employee: my jobs ----------
routes.jobs = async (main) => {
  const from = startOfDay(new Date());
  const list = await api('GET', `/api/appointments?from=${addDays(from, -7).toISOString()}&to=${addDays(from, 30).toISOString()}`);
  const active = list.filter((a) => ['pending', 'confirmed'].includes(a.status));
  const done = list.filter((a) => a.status === 'completed').reverse().slice(0, 15);
  const groups = {};
  active.forEach((a) => { const k = startOfDay(new Date(a.start_at)).toISOString(); (groups[k] ||= []).push(a); });
  main.innerHTML = `<div class="topbar"><h1>My jobs</h1></div>
    <div class="card"><h2>Upcoming & open</h2>${Object.keys(groups).length ? Object.entries(groups).map(([k, arr]) =>
      `<h3>${sameDay(new Date(k), new Date()) ? 'Today' : esc(new Date(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }))}</h3>${arr.map(apptListItem).join('')}`).join('') : '<div class="empty">No upcoming jobs assigned to you 🎉</div>'}</div>
    <div class="card" style="margin-top:1rem"><h2>Recently completed</h2>${done.map(apptListItem).join('') || '<div class="empty">Nothing yet</div>'}</div>`;
  wireApptItems(main, () => routes.jobs(main).catch(fail));
};

// ---------- customers ----------
function customerForm(c = {}, onSaved) {
  const editing = !!c.id;
  const m = modal(editing ? 'Edit customer' : 'New customer', `
    <form class="form" id="cf">
      <div><label>Name *</label><input name="name" required value="${esc(c.name || '')}"></div>
      <div><label>Phone (E.164 for SMS, e.g. +447700900123)</label><input name="phone" type="tel" value="${esc(c.phone || '')}"></div>
      <div><label>Email</label><input name="email" type="email" value="${esc(c.email || '')}"></div>
      <div><label>Address</label><input name="address" value="${esc(c.address || '')}"></div>
      <div class="full"><label>Notes / special requests</label><textarea name="notes">${esc(c.notes || '')}</textarea></div>
      <div><label class="check"><input type="checkbox" name="sms_opt_in" ${c.sms_opt_in === 0 ? '' : 'checked'}> SMS messages</label></div>
      <div><label class="check"><input type="checkbox" name="email_opt_in" ${c.email_opt_in === 0 ? '' : 'checked'}> Email messages</label></div>
      ${editing ? '' : `<div class="full"><h3 style="margin:0">Vehicle (optional)</h3></div>
        <div><label>Make</label><input name="v_make"></div><div><label>Model</label><input name="v_model"></div>
        <div><label>Year</label><input name="v_year" type="number" min="1900" max="2100"></div><div><label>Licence plate</label><input name="v_plate"></div>
        <div><label>VIN</label><input name="v_vin" maxlength="17"></div><div><label>Colour</label><input name="v_color"></div>`}
    </form>
    <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
  const f = $('#cf', m.el);
  $('#cancel', m.el).onclick = m.close;
  $('#save', m.el).onclick = async () => {
    if (!f.reportValidity()) return;
    const d = formData(f);
    const vehicle = { make: d.v_make, model: d.v_model, year: d.v_year, plate: d.v_plate, vin: d.v_vin, color: d.v_color };
    Object.keys(d).filter((k) => k.startsWith('v_')).forEach((k) => delete d[k]);
    if (!editing && Object.values(vehicle).some((v) => v && String(v).trim())) d.vehicles = [vehicle];
    try {
      const saved = editing ? await api('PUT', `/api/customers/${c.id}`, d) : await api('POST', '/api/customers', d);
      toast('Customer saved'); m.close(); onSaved(saved);
    } catch (e) { fail(e); }
  };
}

function vehicleForm(customerId, v = {}, onSaved) {
  const m = modal(v.id ? 'Edit vehicle' : 'Add vehicle', `<form class="form" id="vf">
      <div><label>Make</label><input name="make" value="${esc(v.make || '')}"></div><div><label>Model</label><input name="model" value="${esc(v.model || '')}"></div>
      <div><label>Year</label><input name="year" type="number" min="1900" max="2100" value="${esc(v.year || '')}"></div>
      <div><label>Licence plate</label><input name="plate" value="${esc(v.plate || '')}"></div>
      <div><label>VIN</label><input name="vin" maxlength="17" value="${esc(v.vin || '')}"></div><div><label>Colour</label><input name="color" value="${esc(v.color || '')}"></div>
      <div class="full"><label>Notes</label><input name="notes" value="${esc(v.notes || '')}"></div></form>
    <div class="modal-foot">${v.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
  $('#cancel', m.el).onclick = m.close;
  if (v.id) $('#del', m.el).onclick = async () => {
    if (!confirmBox('Delete this vehicle?')) return;
    try { await api('DELETE', `/api/vehicles/${v.id}`); m.close(); onSaved(); } catch (e) { fail(e); }
  };
  $('#save', m.el).onclick = async () => {
    const d = formData($('#vf', m.el));
    try { v.id ? await api('PUT', `/api/vehicles/${v.id}`, d) : await api('POST', `/api/customers/${customerId}/vehicles`, d); m.close(); onSaved(); } catch (e) { fail(e); }
  };
}

routes.customers = async (main, id) => {
  if (id) return customerDetail(main, +id);
  main.innerHTML = `<div class="topbar"><h1>Customers</h1><button class="btn primary" id="add">+ New customer</button></div>
    <div class="card"><input id="q" type="search" placeholder="Search name, phone, email, plate, VIN, make…" autocomplete="off" style="margin-bottom:.75rem">
    <div class="table-wrap" id="list"></div></div>`;
  const draw = async () => {
    const q = $('#q')?.value || '';
    const rows = await api('GET', `/api/customers?q=${encodeURIComponent(q)}`);
    if ($('#q')?.value !== q && $('#q')) return; // a newer search is in flight
    $('#list').innerHTML = rows.length ? `<table><tr><th>Name</th><th>Contact</th><th>Vehicles</th><th class="right">Visits</th><th class="right">Lifetime</th><th>Last visit</th></tr>
      ${rows.map((c) => `<tr class="clickable" data-id="${c.id}"><td><strong>${esc(c.name)}</strong></td><td class="small">${esc(c.phone || '')}<br>${esc(c.email || '')}</td>
        <td class="small">${esc(c.vehicles || '—')}</td><td class="right">${c.visits}</td><td class="right">${money(c.lifetime_value)}</td><td class="small nowrap">${esc(fmtDate(c.last_visit) || '—')}</td></tr>`).join('')}</table>`
      : `<div class="empty">${q ? 'No matches' : 'No customers yet — add your first one.'}</div>`;
    $$('tr[data-id]', main).forEach((tr) => (tr.onclick = () => (location.hash = `#/customers/${tr.dataset.id}`)));
  };
  let t;
  $('#q').oninput = () => { clearTimeout(t); t = setTimeout(() => draw().catch(fail), 200); };
  $('#add').onclick = () => customerForm({}, (c) => (location.hash = `#/customers/${c.id}`));
  await draw();
};

async function customerDetail(main, id) {
  const c = await api('GET', `/api/customers/${id}`);
  const spent = c.appointments.filter((a) => a.status === 'completed').reduce((s, a) => s + a.price, 0);
  const reload = () => customerDetail(main, id).catch(fail);
  main.innerHTML = `<div class="topbar"><div><a href="#/customers" class="small">← Customers</a><h1>${esc(c.name)}</h1></div>
      <div class="btn-group"><button class="btn primary" id="book">+ Book</button><button class="btn" id="edit">Edit</button><button class="btn danger" id="del">Delete</button></div></div>
    <div class="grid two">
      <div class="card"><h2>Profile</h2><table>
        <tr><th>Phone</th><td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'} ${c.sms_opt_in ? '' : '<span class="badge light">SMS off</span>'}</td></tr>
        <tr><th>Email</th><td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'} ${c.email_opt_in ? '' : '<span class="badge light">Email off</span>'}</td></tr>
        <tr><th>Address</th><td>${esc(c.address || '—')}</td></tr>
        <tr><th>Customer since</th><td>${esc(fmtDate(c.created_at))}</td></tr>
        <tr><th>Lifetime value</th><td>${money(spent)} · ${c.appointments.filter((a) => a.status === 'completed').length} visits</td></tr>
        <tr><th>Notes</th><td style="white-space:pre-wrap">${esc(c.notes || '—')}</td></tr></table></div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Vehicles</h2><button class="btn sm" id="addV">+ Add vehicle</button></div>
        ${c.vehicles.map((v) => `<div class="list-item" data-v="${v.id}"><strong>${esc(vehicleLabel(v) || 'Vehicle')}</strong>
          <div class="small muted">${[v.color, v.vin ? 'VIN ' + v.vin : '', v.notes].filter(Boolean).map(esc).join(' · ')}</div></div>`).join('') || '<div class="empty">No vehicles</div>'}</div>
    </div>
    <div class="card" style="margin-top:1rem"><h2>Service history</h2><div class="table-wrap">${c.appointments.length ? `<table><tr><th>Date</th><th>Service</th><th>Vehicle</th><th>Technician</th><th>Status</th><th class="right">Price</th></tr>
      ${c.appointments.map((a) => `<tr class="clickable" data-appt="${a.id}"><td class="nowrap">${esc(fmtDateTime(a.start_at))}</td><td>${esc(a.service_name || 'Custom')}</td><td class="small">${esc(vehicleLabel(a) || '—')}</td>
        <td>${esc(a.technician_name || '—')}</td><td>${statusBadge(a.status)}</td><td class="right">${money(a.price)}</td></tr>`).join('')}</table>` : '<div class="empty">No bookings yet</div>'}</div></div>
    <div class="grid two" style="margin-top:1rem">
      <div class="card"><h2>Invoices</h2>${c.invoices.length ? `<table>${c.invoices.map((i) => `<tr class="clickable" data-inv="${i.id}"><td>${esc(i.number)}</td><td>${esc(fmtDate(i.issued_at))}</td><td><span class="badge light">${esc(i.status)}</span></td><td class="right">${money(i.amount)}</td></tr>`).join('')}</table>` : '<div class="empty">No invoices</div>'}</div>
      <div class="card"><h2>Photos</h2><div class="photos">${c.photos.map((p) => `<div class="photo"><img src="/api/photos/${p.id}" loading="lazy" alt="${esc(p.kind)}" data-full="/api/photos/${p.id}"><span class="badge ${p.kind === 'after' ? 'st-completed' : 'st-pending'} tag">${esc(p.kind)}</span></div>`).join('') || '<span class="muted">No photos yet</span>'}</div></div>
    </div>`;
  $('#edit').onclick = () => customerForm(c, reload);
  $('#book').onclick = () => apptForm({}, reload, { customer_id: c.id });
  $('#del').onclick = async () => {
    if (!confirmBox(`Delete ${c.name}, their vehicles, bookings, invoices and photos? This cannot be undone.`)) return;
    try { await api('DELETE', `/api/customers/${id}`); toast('Customer deleted'); location.hash = '#/customers'; } catch (e) { fail(e); }
  };
  $('#addV').onclick = () => vehicleForm(id, {}, reload);
  $$('[data-v]', main).forEach((el) => (el.onclick = () => vehicleForm(id, c.vehicles.find((v) => v.id === +el.dataset.v), reload)));
  $$('[data-inv]', main).forEach((el) => (el.onclick = () => (location.hash = `#/invoices/${el.dataset.inv}`)));
  $$('img[data-full]', main).forEach((img) => (img.onclick = () => lightbox(img.dataset.full)));
  wireApptItems(main, reload);
}

// ---------- invoices ----------
routes.invoices = async (main, id) => {
  if (id) return invoiceDetail(main, +id);
  const rows = await api('GET', '/api/invoices');
  main.innerHTML = `<div class="topbar"><h1>Invoices</h1><div class="small muted">Invoices are created automatically when a job is marked completed.</div></div>
    <div class="card table-wrap">${rows.length ? `<table><tr><th>Number</th><th>Customer</th><th>Service</th><th>Date</th><th>Status</th><th class="right">Amount</th></tr>
      ${rows.map((i) => `<tr class="clickable" data-id="${i.id}"><td>${esc(i.number)}</td><td>${esc(i.customer_name)}</td><td>${esc(i.service_name || '—')}</td>
        <td class="nowrap">${esc(fmtDate(i.issued_at))}</td><td><span class="badge ${i.status === 'paid' ? 'st-completed' : i.status === 'void' ? 'st-canceled' : 'st-pending'}">${esc(i.status)}</span></td><td class="right">${money(i.amount)}</td></tr>`).join('')}</table>`
      : '<div class="empty">No invoices yet</div>'}</div>`;
  $$('tr[data-id]', main).forEach((tr) => (tr.onclick = () => (location.hash = `#/invoices/${tr.dataset.id}`)));
};

async function invoiceDetail(main, id) {
  const i = await api('GET', `/api/invoices/${id}`);
  const b = i.business;
  main.innerHTML = `<div class="topbar"><a href="#/invoices" class="small">← Invoices</a>
      <div class="btn-group">${i.status !== 'paid' ? '<button class="btn primary" id="paid">Mark paid</button>' : '<button class="btn" id="unpaid">Mark unpaid</button>'}
      <button class="btn" onclick="window.print()">🖨️ Print / PDF</button></div></div>
    <div class="card invoice">
      <div class="head"><div><h1>${esc(b.business_name)}</h1><div class="small muted">${esc(b.business_phone || '')} ${esc(b.business_email || '')}</div></div>
        <div class="right"><h2 style="margin:0">INVOICE ${esc(i.number)}</h2><div class="small">Issued ${esc(fmtDate(i.issued_at))}</div>
        <span class="badge ${i.status === 'paid' ? 'st-completed' : i.status === 'void' ? 'st-canceled' : 'st-pending'}">${esc(i.status.toUpperCase())}</span>${i.paid_at ? `<div class="small">Paid ${esc(fmtDate(i.paid_at))}</div>` : ''}</div></div>
      <h3>Bill to</h3><div>${esc(i.customer_name)}<br><span class="small muted">${esc(i.customer_address || '')} ${esc(i.customer_phone || '')} ${esc(i.customer_email || '')}</span></div>
      <table style="margin-top:1rem"><tr><th>Description</th><th>Date</th><th class="right">Amount</th></tr>
        <tr><td>${esc(i.service_name || 'Detailing service')}${i.make || i.plate ? `<br><span class="small muted">${esc(vehicleLabel(i))}${i.vin ? ' · VIN ' + esc(i.vin) : ''}</span>` : ''}
          ${i.technician_name ? `<br><span class="small muted">Technician: ${esc(i.technician_name)}</span>` : ''}</td><td>${esc(fmtDate(i.start_at))}</td><td class="right">${money(i.amount)}</td></tr>
        <tr><th colspan="2" class="right">Total</th><th class="right">${money(i.amount)}</th></tr></table>
      ${i.photos.length ? `<h3>Before & after</h3><div class="photos">${i.photos.map((p) => `<div class="photo"><img src="/api/photos/${p.id}" alt="${esc(p.kind)}" data-full="/api/photos/${p.id}"><span class="badge ${p.kind === 'after' ? 'st-completed' : 'st-pending'} tag">${esc(p.kind)}</span></div>`).join('')}</div>` : ''}
      <p class="small muted" style="margin-top:1.5rem">Thank you for your business!</p></div>`;
  const set = async (status) => { try { await api('PUT', `/api/invoices/${id}`, { status }); invoiceDetail(main, id); } catch (e) { fail(e); } };
  if ($('#paid')) $('#paid').onclick = () => set('paid');
  if ($('#unpaid')) $('#unpaid').onclick = () => set('unpaid');
  $$('img[data-full]', main).forEach((img) => (img.onclick = () => lightbox(img.dataset.full)));
}

// ---------- inventory ----------
routes.inventory = async (main) => {
  const items = await api('GET', '/api/inventory');
  const reload = () => routes.inventory(main).catch(fail);
  main.innerHTML = `<div class="topbar"><h1>Inventory</h1><button class="btn primary" id="add">+ Add item</button></div>
    ${items.some((i) => i.is_low) ? `<div class="alert">⚠️ ${items.filter((i) => i.is_low).length} item(s) at or below their low-stock level. Admins are notified automatically.</div>` : ''}
    <div class="card table-wrap">${items.length ? `<table><tr><th>Item</th><th>SKU</th><th class="right">In stock</th><th class="right">Alert at</th><th class="right">Unit cost</th><th>Adjust</th></tr>
      ${items.map((i) => `<tr><td><a href="#" data-edit="${i.id}"><strong>${esc(i.name)}</strong></a> ${i.is_low ? '<span class="badge st-no_show">LOW</span>' : ''}</td><td class="small">${esc(i.sku || '')}</td>
        <td class="right nowrap"><strong>${esc(i.quantity)}</strong> ${esc(i.unit)}</td><td class="right">${esc(i.low_threshold)}</td><td class="right">${money(i.cost)}</td>
        <td class="nowrap"><div class="btn-group"><button class="btn sm" data-adj="${i.id}" data-d="-1">−1</button><button class="btn sm" data-adj="${i.id}" data-d="1">+1</button><button class="btn sm" data-restock="${i.id}">Restock…</button></div></td></tr>`).join('')}</table>`
      : '<div class="empty">No inventory items yet</div>'}</div>`;
  const form = (it = {}) => {
    const m = modal(it.id ? 'Edit item' : 'New item', `<form class="form" id="if">
      <div class="full"><label>Name *</label><input name="name" required value="${esc(it.name || '')}"></div>
      <div><label>SKU</label><input name="sku" value="${esc(it.sku || '')}"></div><div><label>Unit</label><input name="unit" value="${esc(it.unit || 'units')}" placeholder="bottles, litres, towels"></div>
      <div><label>Quantity</label><input name="quantity" type="number" step="any" min="0" value="${esc(it.quantity ?? 0)}"></div>
      <div><label>Low-stock alert at</label><input name="low_threshold" type="number" step="any" min="0" value="${esc(it.low_threshold ?? 2)}"></div>
      <div><label>Unit cost</label><input name="cost" type="number" step="0.01" min="0" value="${esc(it.cost ?? 0)}"></div></form>
      <div class="modal-foot">${it.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
    $('#cancel', m.el).onclick = m.close;
    if (it.id) $('#del', m.el).onclick = async () => { if (confirmBox('Delete item?')) { try { await api('DELETE', `/api/inventory/${it.id}`); m.close(); reload(); } catch (e) { fail(e); } } };
    $('#save', m.el).onclick = async () => {
      const f = $('#if', m.el); if (!f.reportValidity()) return;
      try { it.id ? await api('PUT', `/api/inventory/${it.id}`, formData(f)) : await api('POST', '/api/inventory', formData(f)); m.close(); reload(); } catch (e) { fail(e); }
    };
  };
  $('#add').onclick = () => form();
  $$('[data-edit]', main).forEach((a) => (a.onclick = (e) => { e.preventDefault(); form(items.find((i) => i.id === +a.dataset.edit)); }));
  const adjust = async (id, delta) => { try { await api('POST', `/api/inventory/${id}/adjust`, { delta }); reload(); } catch (e) { fail(e); } };
  $$('[data-adj]', main).forEach((b) => (b.onclick = () => adjust(b.dataset.adj, +b.dataset.d)));
  $$('[data-restock]', main).forEach((b) => (b.onclick = () => {
    const n = Number(prompt('How many units to add?', '10'));
    if (Number.isFinite(n) && n > 0) adjust(b.dataset.restock, n);
  }));
};

// ---------- team & services ----------
routes.team = async (main) => {
  const [users] = await Promise.all([api('GET', '/api/users'), loadLookups()]);
  const reload = () => routes.team(main).catch(fail);
  main.innerHTML = `<div class="topbar"><h1>Team & services</h1></div>
    <div class="grid two">
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Team members</h2><button class="btn sm primary" id="addU">+ Add</button></div>
        <table>${users.map((u) => `<tr class="clickable" data-u="${u.id}"><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(u.color)}"></span> <strong>${esc(u.name)}</strong><br><span class="small muted">${esc(u.email)}</span></td>
          <td><span class="badge light">${esc(u.role)}</span> ${u.active ? '' : '<span class="badge st-canceled">inactive</span>'}</td></tr>`).join('')}</table>
        <p class="small muted">Admins have full access. Employees see only their assigned jobs, can upload photos and mark jobs completed.</p></div>
      <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Services & prices</h2><button class="btn sm primary" id="addS">+ Add</button></div>
        ${state.services.length ? `<table><tr><th>Service</th><th class="right">Duration</th><th class="right">Price</th></tr>${state.services.map((s) => `<tr class="clickable" data-s="${s.id}"><td>${esc(s.name)} ${s.active ? '' : '<span class="badge st-canceled">hidden</span>'}</td><td class="right">${s.duration_min} min</td><td class="right">${money(s.price)}</td></tr>`).join('')}</table>` : '<div class="empty">Add your services, e.g. “Full valet”</div>'}</div>
    </div>`;
  const userForm = (u = {}) => {
    const m = modal(u.id ? 'Edit team member' : 'New team member', `<form class="form" id="uf">
      <div><label>Name *</label><input name="name" required value="${esc(u.name || '')}"></div><div><label>Email *</label><input name="email" type="email" required value="${esc(u.email || '')}"></div>
      <div><label>Phone</label><input name="phone" value="${esc(u.phone || '')}"></div>
      <div><label>Role</label><select name="role"><option value="employee">Employee</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
      <div><label>Calendar colour</label><input name="color" type="color" value="${esc(u.color || '#3b82f6')}"></div>
      <div><label>${u.id ? 'New password (leave blank to keep)' : 'Password * (min 8)'}</label><input name="password" type="password" minlength="8" ${u.id ? '' : 'required'} autocomplete="new-password"></div>
      ${u.id ? `<div class="full"><label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active (can log in & be assigned)</label></div>` : ''}</form>
      <div class="modal-foot">${u.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
    $('#cancel', m.el).onclick = m.close;
    if (u.id) $('#del', m.el).onclick = async () => { if (confirmBox(`Delete ${u.name}? Their jobs become unassigned.`)) { try { await api('DELETE', `/api/users/${u.id}`); m.close(); reload(); } catch (e) { fail(e); } } };
    $('#save', m.el).onclick = async () => {
      const f = $('#uf', m.el); if (!f.reportValidity()) return;
      const d = formData(f); if (!d.password) delete d.password;
      try { u.id ? await api('PUT', `/api/users/${u.id}`, d) : await api('POST', '/api/users', d); m.close(); reload(); } catch (e) { fail(e); }
    };
  };
  const serviceForm = (s = {}) => {
    const m = modal(s.id ? 'Edit service' : 'New service', `<form class="form" id="sf">
      <div class="full"><label>Name *</label><input name="name" required value="${esc(s.name || '')}"></div>
      <div><label>Price</label><input name="price" type="number" step="0.01" min="0" value="${esc(s.price ?? '')}"></div>
      <div><label>Duration (minutes)</label><input name="duration_min" type="number" min="5" step="5" value="${esc(s.duration_min ?? 60)}"></div>
      <div class="full"><label class="check"><input type="checkbox" name="active" ${s.active === 0 ? '' : 'checked'}> Available for booking</label></div></form>
      <div class="modal-foot">${s.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div>`);
    $('#cancel', m.el).onclick = m.close;
    if (s.id) $('#del', m.el).onclick = async () => { if (confirmBox('Delete service? Past bookings keep their price.')) { try { await api('DELETE', `/api/services/${s.id}`); m.close(); reload(); } catch (e) { fail(e); } } };
    $('#save', m.el).onclick = async () => {
      const f = $('#sf', m.el); if (!f.reportValidity()) return;
      try { s.id ? await api('PUT', `/api/services/${s.id}`, formData(f)) : await api('POST', '/api/services', formData(f)); m.close(); reload(); } catch (e) { fail(e); }
    };
  };
  $('#addU').onclick = () => userForm();
  $('#addS').onclick = () => serviceForm();
  $$('[data-u]', main).forEach((tr) => (tr.onclick = () => userForm(users.find((u) => u.id === +tr.dataset.u))));
  $$('[data-s]', main).forEach((tr) => (tr.onclick = () => serviceForm(state.services.find((s) => s.id === +tr.dataset.s))));
};

// ---------- messages log ----------
routes.messages = async (main) => {
  const rows = await api('GET', '/api/notifications');
  main.innerHTML = `<div class="topbar"><h1>Messages</h1><button class="btn" id="run">Run reminder check now</button></div>
    <div class="card table-wrap">${rows.length ? `<table><tr><th>When</th><th>Type</th><th>Channel</th><th>To</th><th>Status</th><th>Message</th></tr>
      ${rows.map((n) => `<tr><td class="nowrap small">${esc(fmtDateTime(n.created_at))}</td><td>${esc(n.type)}</td><td>${esc(n.channel)}</td><td class="small">${esc(n.customer_name || '')}<br>${esc(n.recipient)}</td>
        <td><span class="badge ${n.status === 'sent' ? 'st-completed' : n.status === 'failed' ? 'st-no_show' : 'st-canceled'}">${esc(n.status)}</span>${n.error ? `<div class="small muted">${esc(n.error)}</div>` : ''}</td>
        <td class="small" style="white-space:pre-wrap;max-width:360px">${esc(n.body)}</td></tr>`).join('')}</table>` : '<div class="empty">No messages yet</div>'}</div>`;
  $('#run').onclick = async () => {
    try { const r = await api('POST', '/api/notifications/run'); toast(`Sent ${r.reminders} reminder(s), ${r.followups} follow-up(s)`); routes.messages(main); } catch (e) { fail(e); }
  };
};

// ---------- settings ----------
routes.settings = async (main) => {
  const s = await api('GET', '/api/settings');
  const field = (k, label, type = 'text', extra = '') => `<div><label>${label}</label><input name="${k}" type="${type}" value="${esc(s[k])}" ${extra}></div>`;
  const area = (k, label) => `<div class="full"><label>${label}</label><textarea name="${k}">${esc(s[k])}</textarea></div>`;
  main.innerHTML = `<div class="topbar"><h1>Settings</h1></div>
    <div class="card"><form class="form" id="sf">
      ${field('business_name', 'Business name')}${field('business_phone', 'Business phone')}${field('business_email', 'Business email (receives low-stock alerts)', 'email')}
      <div><label>Currency</label><select name="currency">${['GBP', 'EUR', 'USD', 'AUD', 'CAD', 'NZD'].map((c) => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      ${field('reminder_hours', 'Send reminder (hours before job)', 'number', 'min="1" max="168"')}${field('followup_hours', 'Send follow-up (hours after completion)', 'number', 'min="0" max="720"')}
      ${field('review_link', 'Review link (Google, etc.)', 'url')}${field('followup_discount', 'Follow-up offer')}
      ${area('tpl_confirmation', 'Confirmation message')}${area('tpl_reminder', 'Reminder message')}${area('tpl_followup', 'Follow-up message')}
      <div class="full small muted">Placeholders: {name} {service} {business} {phone} {when} {review_link} {discount}</div>
    </form><div class="modal-foot"><button class="btn primary" id="save">Save settings</button></div></div>
    <div class="card" style="margin-top:1rem"><h2>Messaging providers</h2>
      <p>Twilio SMS: ${s.providers.twilio ? '✅ connected' : '⚠️ not configured — messages are <em>simulated</em> (logged only)'}<br>
      SendGrid email: ${s.providers.sendgrid ? '✅ connected' : '⚠️ not configured — messages are <em>simulated</em> (logged only)'}</p>
      <p class="small muted">Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, SENDGRID_API_KEY and SENDGRID_FROM_EMAIL in the server environment (.env) and restart.</p></div>`;
  $('#save').onclick = async () => {
    try {
      const saved = await api('PUT', '/api/settings', formData($('#sf')));
      state.currency = saved.currency; state.me.business_name = saved.business_name; toast('Settings saved');
      renderShell(); router();
    } catch (e) { fail(e); }
  };
};

// ---------- account ----------
routes.account = async (main) => {
  main.innerHTML = `<div class="topbar"><h1>Account</h1></div><div class="card" style="max-width:480px">
    <p><strong>${esc(state.me.name)}</strong><br><span class="muted">${esc(state.me.email)} · ${esc(state.me.role)}</span></p>
    <h3>Change password</h3><form class="grid" id="pf">
      <div><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
      <div><label>New password (min 8)</label><input type="password" name="next" minlength="8" required autocomplete="new-password"></div>
      <button class="btn primary">Update password</button></form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/me/password', formData(e.target)); toast('Password updated'); e.target.reset(); } catch (err) { fail(err); }
  };
};

// ---------- start ----------
(async () => {
  try { state.me = await api('GET', '/api/me'); } catch { return; /* 401 already rendered login */ }
  await loadLookups();
  if (isAdmin()) { const s = await api('GET', '/api/settings'); state.currency = s.currency || 'GBP'; }
  renderShell();
  router();
})();
