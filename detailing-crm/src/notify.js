'use strict';
// SMS (Twilio) + Email (SendGrid) via their REST APIs. When credentials are not
// configured, messages are logged with status "simulated" so the app is fully
// usable in development without accounts.
const { getSettings } = require('./db');

function cfg() {
  return {
    twilioSid: process.env.TWILIO_ACCOUNT_SID,
    twilioToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFrom: process.env.TWILIO_FROM_NUMBER,
    sendgridKey: process.env.SENDGRID_API_KEY,
    sendgridFrom: process.env.SENDGRID_FROM_EMAIL,
  };
}

async function sendSms(to, body) {
  const c = cfg();
  if (!c.twilioSid || !c.twilioToken || !c.twilioFrom) return { status: 'simulated' };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.twilioSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${c.twilioSid}:${c.twilioToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: c.twilioFrom, Body: body }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { status: 'sent' };
}

async function sendEmail(to, subject, text) {
  const c = cfg();
  if (!c.sendgridKey || !c.sendgridFrom) return { status: 'simulated' };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.sendgridKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: c.sendgridFrom },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { status: 'sent' };
}

function render(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

function fmtWhen(iso) {
  const tz = process.env.TZ_DISPLAY || process.env.TZ || 'Europe/London';
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
  });
}

async function deliver(db, { appointmentId = null, type, sms, email, subject, body }) {
  const log = db.prepare(`INSERT INTO notifications(appointment_id, channel, type, recipient, body, status, error)
    VALUES (?,?,?,?,?,?,?)`);
  const results = [];
  const jobs = [];
  if (sms) jobs.push(['sms', sms, () => sendSms(sms, body)]);
  if (email) jobs.push(['email', email, () => sendEmail(email, subject, body)]);
  for (const [channel, to, fn] of jobs) {
    try {
      const r = await fn();
      log.run(appointmentId, channel, type, to, body, r.status, null);
      results.push({ channel, status: r.status });
    } catch (e) {
      log.run(appointmentId, channel, type, to, body, 'failed', String(e.message || e));
      results.push({ channel, status: 'failed', error: e.message });
    }
  }
  return results;
}

function loadAppt(db, id) {
  return db.prepare(`SELECT a.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
      c.sms_opt_in, c.email_opt_in, s.name AS service_name
    FROM appointments a JOIN customers c ON c.id = a.customer_id
    LEFT JOIN services s ON s.id = a.service_id WHERE a.id = ?`).get(id);
}

const FLAG = { confirmation: 'confirmation_sent', reminder: 'reminder_sent', followup: 'followup_sent' };
const SUBJECT = { confirmation: 'Booking confirmed', reminder: 'Appointment reminder', followup: 'Thanks for your visit!' };

async function sendAppointmentMessage(db, apptId, type) {
  const a = loadAppt(db, apptId);
  if (!a) return [];
  const s = getSettings(db);
  // Mark first so a slow provider + the next scheduler tick can't double-send.
  db.prepare(`UPDATE appointments SET ${FLAG[type]} = 1 WHERE id = ?`).run(apptId);
  const body = render(s[`tpl_${type}`], {
    name: (a.customer_name || '').split(' ')[0],
    service: a.service_name || 'appointment',
    business: s.business_name,
    phone: s.business_phone,
    when: fmtWhen(a.start_at),
    review_link: s.review_link,
    discount: s.followup_discount,
  });
  return deliver(db, {
    appointmentId: apptId, type, body,
    subject: `${SUBJECT[type]} — ${s.business_name}`,
    sms: a.sms_opt_in && a.customer_phone ? a.customer_phone : null,
    email: a.email_opt_in && a.customer_email ? a.customer_email : null,
  });
}

async function checkLowStock(db) {
  const items = db.prepare('SELECT * FROM inventory WHERE quantity <= low_threshold AND low_alert_sent = 0').all();
  // Re-arm alerts for items that were restocked.
  db.prepare('UPDATE inventory SET low_alert_sent = 0 WHERE quantity > low_threshold AND low_alert_sent = 1').run();
  if (!items.length) return;
  const s = getSettings(db);
  const mark = db.prepare('UPDATE inventory SET low_alert_sent = 1 WHERE id = ?');
  for (const i of items) mark.run(i.id);
  const body = 'Low stock alert:\n' + items.map(i => `- ${i.name}: ${i.quantity} ${i.unit} left (alert at ${i.low_threshold})`).join('\n');
  const admins = db.prepare("SELECT email, phone FROM users WHERE role = 'admin' AND active = 1").all();
  const targets = s.business_email ? [{ email: s.business_email, phone: s.business_phone }] : admins;
  for (const t of targets) {
    await deliver(db, { type: 'low_stock', subject: `Low stock — ${s.business_name}`, body, email: t.email || null, sms: t.phone || null });
  }
}

// One scheduler pass: due reminders, due follow-ups, low stock.
async function runScheduler(db, now = Date.now()) {
  const s = getSettings(db);
  const remH = Number(s.reminder_hours) || 24;
  const fuH = Number(s.followup_hours) || 2;
  const nowIso = new Date(now).toISOString();
  const remCut = new Date(now + remH * 3600e3).toISOString();
  const fuCut = new Date(now - fuH * 3600e3).toISOString();

  const due = db.prepare(`SELECT id FROM appointments WHERE reminder_sent = 0
    AND status IN ('pending','confirmed') AND start_at > ? AND start_at <= ?`).all(nowIso, remCut);
  for (const r of due) await sendAppointmentMessage(db, r.id, 'reminder');

  const fus = db.prepare(`SELECT id FROM appointments WHERE followup_sent = 0
    AND status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ?`).all(fuCut);
  for (const r of fus) await sendAppointmentMessage(db, r.id, 'followup');

  await checkLowStock(db);
  return { reminders: due.length, followups: fus.length };
}

function startScheduler(db, intervalMs = 60000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runScheduler(db); } catch (e) { console.error('[scheduler]', e); }
    finally { running = false; }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  setTimeout(tick, 2000).unref();
  return t;
}

module.exports = { sendAppointmentMessage, runScheduler, startScheduler, checkLowStock, deliver, render };
