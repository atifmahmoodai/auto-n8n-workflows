'use strict';
// Loads demo data: services, a technician, customers, past + upcoming jobs, inventory.
process.env.TZ = process.env.APP_TIMEZONE || 'Europe/London';
const path = require('node:path');
const { open } = require('../src/db');
const { hashPassword } = require('../src/auth');
const db = open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'crm.db'));

if (db.prepare('SELECT COUNT(*) n FROM customers').get().n) { console.log('Database already has customers — skipping seed.'); process.exit(0); }

const svc = [['Mini valet', 35, 60], ['Full valet', 90, 180], ['Machine polish', 250, 360], ['Ceramic coating', 600, 480], ['Interior deep clean', 120, 180]]
  .map(s => db.prepare('INSERT INTO services(name,price,duration_min) VALUES (?,?,?)').run(...s).lastInsertRowid);
const tech = db.prepare("INSERT OR IGNORE INTO users(name,email,role,password_hash,color) VALUES ('Sam Tech','tech@example.com','employee',?, '#16a34a')")
  .run(hashPassword('tech1234')).lastInsertRowid || db.prepare("SELECT id FROM users WHERE email='tech@example.com'").get().id;
const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get().id;

const people = [['Olivia Brown', '+447700900001', 'Audi', 'A3', 2019, 'AB19 CDE'], ['Jack Wilson', '+447700900002', 'BMW', '3 Series', 2021, 'BM21 XYZ'],
  ['Amelia Taylor', '+447700900003', 'Tesla', 'Model 3', 2022, 'EV22 TES'], ['Harry Evans', '+447700900004', 'Ford', 'Focus', 2017, 'FO17 CUS'],
  ['Isla Thomas', '+447700900005', 'Range Rover', 'Evoque', 2020, 'RR20 EVO'], ['George Roberts', '+447700900006', 'VW', 'Golf GTI', 2018, 'GT18 VWG']];
const ins = db.prepare(`INSERT INTO appointments(customer_id,vehicle_id,service_id,technician_id,start_at,end_at,status,price,completed_at,confirmation_sent,reminder_sent,followup_sent)
  VALUES (?,?,?,?,?,?,?,?,?,1,1,1)`);
let n = 0;
for (const [name, phone, make, model, year, plate] of people) {
  const cid = db.prepare('INSERT INTO customers(name,phone,email) VALUES (?,?,?)').run(name, phone, name.toLowerCase().replace(' ', '.') + '@example.com').lastInsertRowid;
  const vid = db.prepare('INSERT INTO vehicles(customer_id,make,model,year,plate) VALUES (?,?,?,?,?)').run(cid, make, model, year, plate).lastInsertRowid;
  for (let k = 0; k < 2 + (n % 4); k++) {
    const d = new Date(); d.setDate(d.getDate() - (k * 37 + n * 9) + (k === 0 ? 3 + n : 0)); d.setHours(9 + (n + k) % 7, 0, 0, 0);
    const s = svc[(n + k) % svc.length]; const sv = db.prepare('SELECT * FROM services WHERE id=?').get(s);
    const past = d < new Date();
    const status = past ? (k === 3 ? 'no_show' : 'completed') : (k % 2 ? 'pending' : 'confirmed');
    const end = new Date(d.getTime() + sv.duration_min * 60000);
    const id = ins.run(cid, vid, s, (n + k) % 2 ? tech : admin, d.toISOString(), end.toISOString(), status, sv.price, status === 'completed' ? end.toISOString() : null).lastInsertRowid;
    if (status === 'completed') db.prepare(`INSERT INTO invoices(number,appointment_id,customer_id,amount,status,issued_at,paid_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`INV-DEMO-${String(id).padStart(4, '0')}`, id, cid, sv.price, 'paid', end.toISOString(), end.toISOString());
  }
  n++;
}
for (const it of [['Snow foam', 'litres', 12, 5, 8.5], ['Car shampoo', 'litres', 3, 4, 6], ['Carnauba wax', 'tubs', 6, 2, 18], ['Microfibre towels', 'towels', 40, 15, 1.2], ['Tyre shine', 'bottles', 1, 2, 7]])
  db.prepare('INSERT INTO inventory(name,unit,quantity,low_threshold,cost) VALUES (?,?,?,?,?)').run(...it);
console.log('Seeded demo data. Technician login: tech@example.com / tech1234');
