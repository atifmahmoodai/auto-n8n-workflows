'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, tx, getSettings, DEFAULT_SETTINGS } = require('./db');
const auth = require('./auth');
const notify = require('./notify');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 15 * 1024 * 1024; // photos come in as base64 JSON
const STATUSES = ['pending', 'confirmed', 'completed', 'canceled', 'no_show'];
const RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly'];
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

// ---------- small helpers ----------
const str = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
function isoOrThrow(v, field) {
  const d = new Date(v);
  if (!v || isNaN(d)) throw bad(`Invalid ${field}`);
  return d.toISOString();
}

function addInterval(date, recurrence, n) {
  // Uses local time (APP_TIMEZONE) so "every Tuesday 10:00" survives DST changes.
  const d = new Date(date);
  if (recurrence === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (recurrence === 'biweekly') d.setDate(d.getDate() + 14 * n);
  else if (recurrence === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last)); // 31st -> 30th/28th instead of rolling over
  }
  return d;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// ---------- router ----------
function createRouter() {
  const routes = [];
  const add = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  };
  const match = (method, pathname) => {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  };
  return { add, match };
}

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'crm.db'),
  uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
  secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const db = open(dbFile);
  fs.mkdirSync(uploadDir, { recursive: true });
  const r = createRouter();
  const ADMIN = { role: 'admin' };
  const ANY = {};
  const PUBLIC = { public: true };
  const fireAndForget = (p) => p.catch((e) => console.error('[notify]', e));

  // ---------- auth ----------
  const loginAttempts = new Map(); // naive brute-force throttle per email
  r.add('POST', '/api/login', PUBLIC, async ({ body, res }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const a = loginAttempts.get(email) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!u || !auth.verifyPassword(body.password || '', u.password_hash)) {
      a.n += 1; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
      loginAttempts.set(email, a);
      throw new HttpError(401, 'Invalid email or password');
    }
    loginAttempts.delete(email);
    const token = auth.createSession(db, u.id);
    const cookie = `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${auth.SESSION_TTL_MS / 1000}${secureCookies ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookie);
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  });

  r.add('POST', '/api/logout', ANY, ({ token, res }) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return { ok: true };
  });

  r.add('GET', '/api/me', ANY, ({ user }) => ({ ...user, business_name: getSettings(db).business_name }));

  r.add('POST', '/api/me/password', ANY, ({ user, body }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!auth.verifyPassword(body.current || '', row.password_hash)) throw bad('Current password is incorrect');
    if (String(body.next || '').length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.next), user.id);
    return { ok: true };
  });

  // ---------- users / team ----------
  const userCols = 'id, name, email, phone, role, color, active, created_at';
  r.add('GET', '/api/users', ADMIN, () => db.prepare(`SELECT ${userCols} FROM users ORDER BY name`).all());
  r.add('GET', '/api/technicians', ANY, () =>
    db.prepare('SELECT id, name, color, role FROM users WHERE active = 1 ORDER BY name').all());

  function userFields(b) {
    const role = b.role === 'admin' ? 'admin' : 'employee';
    const name = str(b.name, 100); const email = str(b.email, 200);
    if (!name || !email || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Name and a valid email are required');
    const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#3b82f6';
    return { name, email: email.toLowerCase(), phone: str(b.phone, 40), role, color };
  }
  r.add('POST', '/api/users', ADMIN, ({ body }) => {
    const f = userFields(body);
    if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters');
    try {
      const info = db.prepare('INSERT INTO users(name,email,phone,role,color,password_hash) VALUES (?,?,?,?,?,?)')
        .run(f.name, f.email, f.phone, f.role, f.color, auth.hashPassword(body.password));
      return db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(info.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A user with that email already exists');
      throw e;
    }
  });
  r.add('PUT', '/api/users/:id', ADMIN, ({ params, body, user }) => {
    const id = int(params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'User not found');
    const f = userFields({ ...existing, ...body });
    const active = body.active === undefined ? existing.active : bool(body.active);
    if (id === user.id && (f.role !== 'admin' || !active)) throw bad('You cannot demote or deactivate yourself');
    try {
      db.prepare('UPDATE users SET name=?, email=?, phone=?, role=?, color=?, active=? WHERE id=?')
        .run(f.name, f.email, f.phone, f.role, f.color, active, id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A user with that email already exists');
      throw e;
    }
    if (body.password) {
      if (String(body.password).length < 8) throw bad('Password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), id);
    }
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id);
  });
  r.add('DELETE', '/api/users/:id', ADMIN, ({ params, user }) => {
    const id = int(params.id);
    if (id === user.id) throw bad('You cannot delete yourself');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---------- customers & vehicles ----------
  function customerFields(b) {
    const name = str(b.name, 150);
    if (!name) throw bad('Customer name is required');
    return [name, str(b.email, 200), str(b.phone, 40), str(b.address, 300), str(b.notes, 4000),
      b.sms_opt_in === undefined ? 1 : bool(b.sms_opt_in), b.email_opt_in === undefined ? 1 : bool(b.email_opt_in)];
  }
  function vehicleFields(b) {
    const year = int(b.year);
    return [str(b.make, 60), str(b.model, 60), year && year > 1900 && year < 2200 ? year : null,
      str(b.plate, 20)?.toUpperCase() ?? null, str(b.vin, 40)?.toUpperCase() ?? null, str(b.color, 40), str(b.notes, 1000)];
  }

  r.add('GET', '/api/customers', ADMIN, ({ query }) => {
    const q = String(query.get('q') || '').trim();
    const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    return db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS visits,
        (SELECT COALESCE(SUM(price),0) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS lifetime_value,
        (SELECT MAX(start_at) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS last_visit,
        (SELECT GROUP_CONCAT(TRIM(COALESCE(v.make,'') || ' ' || COALESCE(v.model,'') || ' ' || COALESCE(v.plate,'')), ', ')
           FROM vehicles v WHERE v.customer_id = c.id) AS vehicles
      FROM customers c
      WHERE ? = '' OR c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND
             (v.plate LIKE ? ESCAPE '\\' OR v.vin LIKE ? ESCAPE '\\' OR v.make LIKE ? ESCAPE '\\' OR v.model LIKE ? ESCAPE '\\'))
      ORDER BY c.name COLLATE NOCASE LIMIT 500`).all(q, like, like, like, like, like, like, like);
  });

  r.add('POST', '/api/customers', ADMIN, ({ body }) => tx(db, () => {
    const info = db.prepare('INSERT INTO customers(name,email,phone,address,notes,sms_opt_in,email_opt_in) VALUES (?,?,?,?,?,?,?)')
      .run(...customerFields(body));
    const cid = info.lastInsertRowid;
    for (const v of Array.isArray(body.vehicles) ? body.vehicles : []) {
      db.prepare('INSERT INTO vehicles(customer_id,make,model,year,plate,vin,color,notes) VALUES (?,?,?,?,?,?,?,?)')
        .run(cid, ...vehicleFields(v));
    }
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
  }));

  r.add('GET', '/api/customers/:id', ADMIN, ({ params }) => {
    const id = int(params.id);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Customer not found');
    c.vehicles = db.prepare('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id').all(id);
    c.appointments = db.prepare(`SELECT a.*, s.name AS service_name, u.name AS technician_name,
        v.make, v.model, v.plate FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id LEFT JOIN users u ON u.id = a.technician_id
      LEFT JOIN vehicles v ON v.id = a.vehicle_id WHERE a.customer_id = ? ORDER BY a.start_at DESC`).all(id);
    c.invoices = db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_at DESC').all(id);
    c.photos = db.prepare('SELECT id, appointment_id, kind, created_at FROM photos WHERE customer_id = ? ORDER BY created_at DESC').all(id);
    return c;
  });

  r.add('PUT', '/api/customers/:id', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Customer not found');
    db.prepare('UPDATE customers SET name=?, email=?, phone=?, address=?, notes=?, sms_opt_in=?, email_opt_in=? WHERE id=?')
      .run(...customerFields({ ...existing, ...body }), id);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  });

  r.add('DELETE', '/api/customers/:id', ADMIN, ({ params }) => {
    const id = int(params.id);
    const files = db.prepare('SELECT filename FROM photos WHERE customer_id = ?').all(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    for (const f of files) fs.rm(path.join(uploadDir, f.filename), { force: true }, () => {});
    return { ok: true };
  });

  r.add('POST', '/api/customers/:id/vehicles', ADMIN, ({ params, body }) => {
    const cid = int(params.id);
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid)) throw new HttpError(404, 'Customer not found');
    const info = db.prepare('INSERT INTO vehicles(customer_id,make,model,year,plate,vin,color,notes) VALUES (?,?,?,?,?,?,?,?)')
      .run(cid, ...vehicleFields(body));
    return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid);
  });
  r.add('PUT', '/api/vehicles/:id', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
    if (!v) throw new HttpError(404, 'Vehicle not found');
    db.prepare('UPDATE vehicles SET make=?, model=?, year=?, plate=?, vin=?, color=?, notes=? WHERE id=?')
      .run(...vehicleFields({ ...v, ...body }), id);
    return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  });
  r.add('DELETE', '/api/vehicles/:id', ADMIN, ({ params }) => {
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(int(params.id));
    return { ok: true };
  });

  // ---------- services (price list) ----------
  r.add('GET', '/api/services', ANY, () => db.prepare('SELECT * FROM services ORDER BY active DESC, name').all());
  const serviceFields = (b) => {
    const name = str(b.name, 100);
    if (!name) throw bad('Service name is required');
    return [name, Math.max(0, num(b.price)), Math.max(5, int(b.duration_min) || 60), b.active === undefined ? 1 : bool(b.active)];
  };
  r.add('POST', '/api/services', ADMIN, ({ body }) => {
    const info = db.prepare('INSERT INTO services(name, price, duration_min, active) VALUES (?,?,?,?)').run(...serviceFields(body));
    return db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid);
  });
  r.add('PUT', '/api/services/:id', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const s = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Service not found');
    db.prepare('UPDATE services SET name=?, price=?, duration_min=?, active=? WHERE id=?').run(...serviceFields({ ...s, ...body }), id);
    return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  });
  r.add('DELETE', '/api/services/:id', ADMIN, ({ params }) => {
    db.prepare('DELETE FROM services WHERE id = ?').run(int(params.id));
    return { ok: true };
  });

  // ---------- appointments ----------
  const apptSelect = `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
      c.address AS customer_address, c.notes AS customer_notes,
      s.name AS service_name, u.name AS technician_name, u.color AS technician_color,
      v.make, v.model, v.year, v.plate, v.color AS vehicle_color, i.id AS invoice_id, i.number AS invoice_number,
      i.status AS invoice_status,
      (SELECT COUNT(*) FROM photos p WHERE p.appointment_id = a.id) AS photo_count
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN services s ON s.id = a.service_id
    LEFT JOIN users u ON u.id = a.technician_id
    LEFT JOIN vehicles v ON v.id = a.vehicle_id
    LEFT JOIN invoices i ON i.appointment_id = a.id`;

  function getApptFor(user, id) {
    const a = db.prepare(`${apptSelect} WHERE a.id = ?`).get(id);
    if (!a) throw new HttpError(404, 'Appointment not found');
    // Employees only see jobs assigned to them (customer notes stay visible: they hold special requests).
    if (user.role !== 'admin' && a.technician_id !== user.id) throw new HttpError(403, 'Not your job');
    return a;
  }

  r.add('GET', '/api/appointments', ANY, ({ query, user }) => {
    const where = []; const args = [];
    if (query.get('from')) { where.push('a.end_at >= ?'); args.push(isoOrThrow(query.get('from'), 'from')); }
    if (query.get('to')) { where.push('a.start_at < ?'); args.push(isoOrThrow(query.get('to'), 'to')); }
    if (user.role !== 'admin') { where.push('a.technician_id = ?'); args.push(user.id); }
    else if (query.get('technician_id')) { where.push('a.technician_id = ?'); args.push(int(query.get('technician_id'))); }
    if (query.get('status')) { where.push('a.status = ?'); args.push(query.get('status')); }
    const sql = `${apptSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.start_at LIMIT 2000`;
    return db.prepare(sql).all(...args);
  });

  r.add('GET', '/api/appointments/:id', ANY, ({ params, user }) => {
    const a = getApptFor(user, int(params.id));
    a.photos = db.prepare('SELECT id, kind, created_at FROM photos WHERE appointment_id = ? ORDER BY created_at').all(a.id);
    if (user.role === 'admin') {
      a.notifications = db.prepare('SELECT * FROM notifications WHERE appointment_id = ? ORDER BY id DESC').all(a.id);
    }
    return a;
  });

  function validateApptRefs(customerId, vehicleId, serviceId, technicianId) {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw bad('Customer not found');
    if (vehicleId && !db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND customer_id = ?').get(vehicleId, customerId))
      throw bad('Vehicle does not belong to this customer');
    if (serviceId && !db.prepare('SELECT 1 FROM services WHERE id = ?').get(serviceId)) throw bad('Service not found');
    if (technicianId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(technicianId)) throw bad('Technician not found');
  }

  function findConflict(technicianId, startIso, endIso, excludeId = 0) {
    if (!technicianId) return null;
    return db.prepare(`SELECT a.id, a.start_at, c.name AS customer_name FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.technician_id = ? AND a.id != ? AND a.status IN ('pending','confirmed')
        AND a.start_at < ? AND a.end_at > ? LIMIT 1`).get(technicianId, excludeId, endIso, startIso);
  }

  function syncInvoice(apptId) {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
    const inv = db.prepare('SELECT * FROM invoices WHERE appointment_id = ?').get(apptId);
    if (a.status === 'completed') {
      if (!inv) {
        const year = new Date().getFullYear();
        const seq = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?").get(`INV-${year}-%`).n + 1;
        let number = `INV-${year}-${String(seq).padStart(4, '0')}`;
        while (db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number)) number += 'a';
        db.prepare('INSERT INTO invoices(number, appointment_id, customer_id, amount) VALUES (?,?,?,?)')
          .run(number, a.id, a.customer_id, a.price);
      } else if (inv.status === 'void') {
        db.prepare("UPDATE invoices SET status='unpaid', amount=? WHERE id=?").run(a.price, inv.id);
      } else if (inv.status === 'unpaid') {
        db.prepare('UPDATE invoices SET amount=? WHERE id=?').run(a.price, inv.id);
      }
    } else if (inv && inv.status === 'unpaid') {
      db.prepare("UPDATE invoices SET status='void' WHERE id=?").run(inv.id);
    }
  }

  r.add('POST', '/api/appointments', ADMIN, async ({ body }) => {
    const customerId = int(body.customer_id);
    const vehicleId = int(body.vehicle_id) || null;
    const serviceId = int(body.service_id) || null;
    const technicianId = int(body.technician_id) || null;
    validateApptRefs(customerId, vehicleId, serviceId, technicianId);
    const service = serviceId ? db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId) : null;
    const start = new Date(isoOrThrow(body.start_at, 'start time'));
    const durationMin = int(body.duration_min) || service?.duration_min || 60;
    if (durationMin < 5 || durationMin > 24 * 60) throw bad('Duration must be between 5 minutes and 24 hours');
    const price = body.price === undefined || body.price === '' ? (service?.price || 0) : Math.max(0, num(body.price));
    const status = STATUSES.includes(body.status) ? body.status : 'pending';
    const recurrence = RECURRENCES.includes(body.recurrence) ? body.recurrence : 'none';
    const count = recurrence === 'none' ? 1 : Math.min(52, Math.max(2, int(body.occurrences) || 8));
    const seriesId = recurrence === 'none' ? null : crypto.randomUUID();

    const occurrences = [];
    for (let n = 0; n < count; n++) {
      const s = addInterval(start, recurrence, n);
      occurrences.push([s.toISOString(), new Date(s.getTime() + durationMin * 60000).toISOString()]);
    }
    if (!body.force) {
      for (const [s, e] of occurrences) {
        const c = findConflict(technicianId, s, e);
        if (c) throw new HttpError(409, `Technician is already booked with ${c.customer_name} at ${c.start_at}. Save again to book anyway.`);
      }
    }
    const ids = tx(db, () => occurrences.map(([s, e]) => db.prepare(`INSERT INTO appointments
        (customer_id, vehicle_id, service_id, technician_id, start_at, end_at, status, price, notes, series_id, recurrence)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(customerId, vehicleId, serviceId, technicianId, s, e, status, price,
        str(body.notes, 4000), seriesId, recurrence).lastInsertRowid));
    // Booking confirmation goes out immediately for the first occurrence only.
    if (body.send_confirmation !== false && status !== 'canceled') {
      fireAndForget(notify.sendAppointmentMessage(db, ids[0], 'confirmation'));
    }
    return { ids, appointment: db.prepare(`${apptSelect} WHERE a.id = ?`).get(ids[0]) };
  });

  r.add('PUT', '/api/appointments/:id', ANY, ({ params, body, user }) => {
    const id = int(params.id);
    const a = getApptFor(user, id);
    if (user.role !== 'admin') {
      // Employees may only move their own job to completed (or back to confirmed if marked by mistake).
      const allowed = ['completed', 'confirmed'];
      const keys = Object.keys(body).filter((k) => k !== 'status');
      if (keys.length || !allowed.includes(body.status)) throw new HttpError(403, 'Employees can only mark jobs as completed');
    }
    const next = {
      customer_id: body.customer_id !== undefined ? int(body.customer_id) : a.customer_id,
      vehicle_id: body.vehicle_id !== undefined ? int(body.vehicle_id) || null : a.vehicle_id,
      service_id: body.service_id !== undefined ? int(body.service_id) || null : a.service_id,
      technician_id: body.technician_id !== undefined ? int(body.technician_id) || null : a.technician_id,
      status: body.status !== undefined ? body.status : a.status,
      price: body.price !== undefined && body.price !== '' ? Math.max(0, num(body.price)) : a.price,
      notes: body.notes !== undefined ? str(body.notes, 4000) : a.notes,
    };
    if (!STATUSES.includes(next.status)) throw bad('Invalid status');
    validateApptRefs(next.customer_id, next.vehicle_id, next.service_id, next.technician_id);
    let startIso = a.start_at; let endIso = a.end_at;
    if (body.start_at !== undefined || body.duration_min !== undefined) {
      const dur = int(body.duration_min) || Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000);
      if (dur < 5 || dur > 24 * 60) throw bad('Duration must be between 5 minutes and 24 hours');
      startIso = body.start_at !== undefined ? isoOrThrow(body.start_at, 'start time') : a.start_at;
      endIso = new Date(new Date(startIso).getTime() + dur * 60000).toISOString();
    }
    const moved = startIso !== a.start_at;
    if (!body.force && ['pending', 'confirmed'].includes(next.status) && (moved || next.technician_id !== a.technician_id)) {
      const c = findConflict(next.technician_id, startIso, endIso, id);
      if (c) throw new HttpError(409, `Technician is already booked with ${c.customer_name} at ${c.start_at}. Save again to book anyway.`);
    }
    const completedAt = next.status === 'completed' ? (a.completed_at || new Date().toISOString()) : null;
    tx(db, () => {
      db.prepare(`UPDATE appointments SET customer_id=?, vehicle_id=?, service_id=?, technician_id=?, start_at=?, end_at=?,
          status=?, price=?, notes=?, completed_at=?, reminder_sent = CASE WHEN ? THEN 0 ELSE reminder_sent END WHERE id=?`)
        .run(next.customer_id, next.vehicle_id, next.service_id, next.technician_id, startIso, endIso,
          next.status, next.price, next.notes, completedAt, moved ? 1 : 0, id);
      syncInvoice(id);
    });
    return getApptFor(user, id);
  });

  r.add('DELETE', '/api/appointments/:id', ADMIN, ({ params, query }) => {
    const id = int(params.id);
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!a) throw new HttpError(404, 'Appointment not found');
    // scope=future deletes this and all later occurrences of a recurring series
    const rows = query.get('scope') === 'future' && a.series_id
      ? db.prepare('SELECT id FROM appointments WHERE series_id = ? AND start_at >= ?').all(a.series_id, a.start_at)
      : [{ id }];
    const files = [];
    tx(db, () => {
      for (const row of rows) {
        files.push(...db.prepare('SELECT filename FROM photos WHERE appointment_id = ?').all(row.id));
        db.prepare("UPDATE invoices SET status='void' WHERE appointment_id = ? AND status = 'unpaid'").run(row.id);
        db.prepare('DELETE FROM appointments WHERE id = ?').run(row.id);
      }
    });
    for (const f of files) fs.rm(path.join(uploadDir, f.filename), { force: true }, () => {});
    return { deleted: rows.length };
  });

  r.add('POST', '/api/appointments/:id/notify', ADMIN, async ({ params, body }) => {
    const id = int(params.id);
    if (!['confirmation', 'reminder', 'followup'].includes(body.type)) throw bad('Invalid message type');
    if (!db.prepare('SELECT 1 FROM appointments WHERE id = ?').get(id)) throw new HttpError(404, 'Appointment not found');
    return { results: await notify.sendAppointmentMessage(db, id, body.type) };
  });

  // ---------- photos ----------
  r.add('POST', '/api/appointments/:id/photos', ANY, ({ params, body, user }) => {
    const a = getApptFor(user, int(params.id));
    if (!['before', 'after'].includes(body.kind)) throw bad('kind must be "before" or "after"');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ''));
    if (!m) throw bad('Photo must be a JPEG, PNG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 100) throw bad('Image is empty');
    if (buf.length > 10 * 1024 * 1024) throw new HttpError(413, 'Image too large (max 10MB)');
    const filename = `${a.id}-${crypto.randomBytes(8).toString('hex')}.${IMAGE_TYPES[m[1]]}`;
    fs.writeFileSync(path.join(uploadDir, filename), buf);
    const info = db.prepare('INSERT INTO photos(appointment_id, customer_id, kind, filename, mime, uploaded_by) VALUES (?,?,?,?,?,?)')
      .run(a.id, a.customer_id, body.kind, filename, m[1], user.id);
    return db.prepare('SELECT id, kind, created_at FROM photos WHERE id = ?').get(info.lastInsertRowid);
  });

  r.add('GET', '/api/photos/:id', ANY, ({ params, user, res }) => {
    const p = db.prepare('SELECT p.*, a.technician_id FROM photos p JOIN appointments a ON a.id = p.appointment_id WHERE p.id = ?')
      .get(int(params.id));
    if (!p) throw new HttpError(404, 'Photo not found');
    if (user.role !== 'admin' && p.technician_id !== user.id) throw new HttpError(403, 'Forbidden');
    const file = path.join(uploadDir, path.basename(p.filename));
    if (!fs.existsSync(file)) throw new HttpError(404, 'Photo file missing');
    res.writeHead(200, { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
    return undefined; // response already handled
  });

  r.add('DELETE', '/api/photos/:id', ADMIN, ({ params }) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(int(params.id));
    if (!p) throw new HttpError(404, 'Photo not found');
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    fs.rm(path.join(uploadDir, path.basename(p.filename)), { force: true }, () => {});
    return { ok: true };
  });

  // ---------- invoices ----------
  r.add('GET', '/api/invoices', ADMIN, ({ query }) => {
    const st = query.get('status');
    return db.prepare(`SELECT i.*, c.name AS customer_name, a.start_at, s.name AS service_name FROM invoices i
      JOIN customers c ON c.id = i.customer_id LEFT JOIN appointments a ON a.id = i.appointment_id
      LEFT JOIN services s ON s.id = a.service_id ${st ? 'WHERE i.status = ?' : ''} ORDER BY i.issued_at DESC LIMIT 1000`)
      .all(...(st ? [st] : []));
  });
  r.add('GET', '/api/invoices/:id', ADMIN, ({ params }) => {
    const i = db.prepare(`SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
        c.address AS customer_address, a.start_at, a.notes AS job_notes, s.name AS service_name, u.name AS technician_name,
        v.make, v.model, v.year, v.plate, v.vin
      FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN appointments a ON a.id = i.appointment_id
      LEFT JOIN services s ON s.id = a.service_id LEFT JOIN users u ON u.id = a.technician_id
      LEFT JOIN vehicles v ON v.id = a.vehicle_id WHERE i.id = ?`).get(int(params.id));
    if (!i) throw new HttpError(404, 'Invoice not found');
    i.photos = i.appointment_id ? db.prepare('SELECT id, kind FROM photos WHERE appointment_id = ? ORDER BY kind DESC, id').all(i.appointment_id) : [];
    i.business = getSettings(db);
    return i;
  });
  r.add('PUT', '/api/invoices/:id', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const status = body.status ?? inv.status;
    if (!['unpaid', 'paid', 'void'].includes(status)) throw bad('Invalid invoice status');
    const amount = body.amount !== undefined ? Math.max(0, num(body.amount)) : inv.amount;
    const paidAt = status === 'paid' ? (inv.paid_at || new Date().toISOString()) : null;
    db.prepare('UPDATE invoices SET status=?, amount=?, paid_at=? WHERE id=?').run(status, amount, paidAt, id);
    return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  });

  // ---------- inventory ----------
  const invFields = (b) => {
    const name = str(b.name, 120);
    if (!name) throw bad('Item name is required');
    return [name, str(b.sku, 60), str(b.unit, 30) || 'units', Math.max(0, num(b.quantity)), Math.max(0, num(b.low_threshold)), Math.max(0, num(b.cost))];
  };
  const afterStockChange = () => fireAndForget(notify.checkLowStock(db));
  r.add('GET', '/api/inventory', ADMIN, () =>
    db.prepare('SELECT *, (quantity <= low_threshold) AS is_low FROM inventory ORDER BY is_low DESC, name').all());
  r.add('POST', '/api/inventory', ADMIN, ({ body }) => {
    const info = db.prepare('INSERT INTO inventory(name, sku, unit, quantity, low_threshold, cost) VALUES (?,?,?,?,?,?)').run(...invFields(body));
    afterStockChange();
    return db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid);
  });
  r.add('PUT', '/api/inventory/:id', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const it = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
    if (!it) throw new HttpError(404, 'Item not found');
    db.prepare('UPDATE inventory SET name=?, sku=?, unit=?, quantity=?, low_threshold=?, cost=? WHERE id=?').run(...invFields({ ...it, ...body }), id);
    afterStockChange();
    return db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  });
  r.add('POST', '/api/inventory/:id/adjust', ADMIN, ({ params, body }) => {
    const id = int(params.id);
    const delta = num(body.delta, NaN);
    if (!Number.isFinite(delta) || delta === 0) throw bad('delta must be a non-zero number');
    const info = db.prepare('UPDATE inventory SET quantity = MAX(0, quantity + ?) WHERE id = ?').run(delta, id);
    if (!info.changes) throw new HttpError(404, 'Item not found');
    afterStockChange();
    return db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  });
  r.add('DELETE', '/api/inventory/:id', ADMIN, ({ params }) => {
    db.prepare('DELETE FROM inventory WHERE id = ?').run(int(params.id));
    return { ok: true };
  });

  // ---------- reports / dashboard ----------
  r.add('GET', '/api/reports', ADMIN, ({ query }) => {
    const months = Math.min(36, Math.max(1, int(query.get('months')) || 12));
    const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0); since.setMonth(since.getMonth() - (months - 1));
    const sinceIso = since.toISOString();
    const monthly = db.prepare(`SELECT substr(start_at,1,7) AS month,
        SUM(CASE WHEN status='completed' THEN price ELSE 0 END) AS revenue,
        SUM(CASE WHEN status != 'canceled' THEN 1 ELSE 0 END) AS bookings,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        COUNT(DISTINCT CASE WHEN status='completed' THEN customer_id END) AS customers
      FROM appointments WHERE start_at >= ? GROUP BY month ORDER BY month`).all(sinceIso);
    // Fill empty months so the chart has a continuous axis.
    const byMonth = Object.fromEntries(monthly.map((m) => [m.month, m]));
    const series = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(since); d.setMonth(since.getMonth() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      series.push(byMonth[key] || { month: key, revenue: 0, bookings: 0, completed: 0, customers: 0 });
    }
    const ret = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS returning_n FROM
      (SELECT customer_id, COUNT(*) AS n FROM appointments WHERE status='completed' GROUP BY customer_id)`).get();
    const topCustomers = db.prepare(`SELECT c.id, c.name, COUNT(*) AS visits, SUM(a.price) AS revenue
      FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.status='completed'
      GROUP BY c.id ORDER BY revenue DESC, visits DESC LIMIT 10`).all();
    const topServices = db.prepare(`SELECT COALESCE(s.name, 'Custom') AS name, COUNT(*) AS bookings,
        SUM(CASE WHEN a.status='completed' THEN a.price ELSE 0 END) AS revenue
      FROM appointments a LEFT JOIN services s ON s.id = a.service_id WHERE a.status != 'canceled'
      GROUP BY a.service_id ORDER BY bookings DESC LIMIT 10`).all();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const today = db.prepare(`${apptSelect} WHERE a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at`)
      .all(dayStart.toISOString(), dayEnd.toISOString());
    const thisMonth = series[series.length - 1];
    const statusCounts = db.prepare(`SELECT status, COUNT(*) AS n FROM appointments WHERE substr(start_at,1,7) = ? GROUP BY status`)
      .all(thisMonth.month);
    const outstanding = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM invoices WHERE status='unpaid'").get();
    const lowStock = db.prepare('SELECT * FROM inventory WHERE quantity <= low_threshold ORDER BY name').all();
    const upcoming = db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE start_at >= ? AND status IN ('pending','confirmed')")
      .get(new Date().toISOString()).n;
    return {
      monthly: series,
      retention: { total: ret.total || 0, returning: ret.returning_n || 0, rate: ret.total ? (ret.returning_n || 0) / ret.total : 0 },
      topCustomers, topServices, today, statusCounts, outstanding, lowStock, upcoming,
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
      currency: getSettings(db).currency,
    };
  });

  // ---------- settings & notification log ----------
  r.add('GET', '/api/settings', ADMIN, () => ({
    ...getSettings(db),
    providers: {
      twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
      sendgrid: !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL),
    },
  }));
  r.add('PUT', '/api/settings', ADMIN, ({ body }) => {
    const up = db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (body[k] !== undefined) up.run(k, String(body[k]).slice(0, 2000));
    return getSettings(db);
  });
  r.add('GET', '/api/notifications', ADMIN, () => db.prepare(`SELECT n.*, c.name AS customer_name FROM notifications n
    LEFT JOIN appointments a ON a.id = n.appointment_id LEFT JOIN customers c ON c.id = a.customer_id
    ORDER BY n.id DESC LIMIT 300`).all());
  r.add('POST', '/api/notifications/run', ADMIN, () => notify.runScheduler(db));

  // ---------- HTTP plumbing ----------
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
      fs.createReadStream(file).pipe(res);
    });
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, pathname);
    }
    try {
      const m = r.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const { route, params } = m;
      const token = auth.parseCookies(req.headers.cookie).sid;
      const user = auth.userFromToken(db, token);
      if (!route.opts.public) {
        if (!user) throw new HttpError(401, 'Please log in');
        if (route.opts.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
        // CSRF defence: state-changing calls must come from our own JS (custom header can't be sent cross-site without CORS).
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Missing CSRF header');
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON object expected');
      const out = await route.handler({ req, res, params, query: url.searchParams, body, user, token });
      if (!res.headersSent) send(res, 200, out);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'Internal server error' : e.message });
    }
  };

  return { db, handler, uploadDir };
}

if (require.main === module) {
  process.env.TZ = process.env.APP_TIMEZONE || process.env.TZ || 'Europe/London';
  const app = createApp();
  notify.startScheduler(app.db);
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app.handler).listen(port, () => console.log(`Detailing CRM running on http://localhost:${port}`));
}

module.exports = { createApp, addInterval };
