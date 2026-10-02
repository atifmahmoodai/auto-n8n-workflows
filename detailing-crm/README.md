# Detailing CRM — Car Detailing Booking & CRM Web App

A mobile-friendly booking and CRM web app for solo car detailers and small multi-technician teams.
It has **no npm dependencies**. It runs on Node.js 22.5+ using the built-in `node:sqlite`, `fetch` and `crypto` modules.

## Quick start
```bash
cd detailing-crm
cp .env.example .env                     # optional: admin login, Twilio, SendGrid
npm run seed                             # optional: demo customers, jobs, inventory
node --env-file=.env src/server.js       # or: npm start   → http://localhost:3000
```
Default login on first run is `admin@example.com` / `admin123`. You can override it with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Change the password after you log in.
The demo technician login is `tech@example.com` / `tech1234`.

## Features
| Area | What's included |
|---|---|
| **CRM** | Add, edit and delete customers and vehicles (make, model, year, plate, VIN, colour). Each customer has service history, invoices, photos, notes and special requests, plus SMS/email opt-in. Instant search covers name, phone, email, plate, VIN and make. |
| **Calendar** | Month, week and day views with colour-coded statuses (Pending, Confirmed, Completed, Canceled, No-show) and a filter by technician. Recurring bookings can repeat weekly, every 2 weeks or monthly, and you can delete one visit or all future visits. The app warns you before double-booking a technician. |
| **Notifications** | A booking confirmation goes out as soon as you book. A reminder goes out N hours before the job and a follow-up N hours after it is completed (review link and discount). Message templates are editable. Messages go through **Twilio** (SMS) and **SendGrid** (email). Without API keys, messages are *simulated* and logged, so you can test safely. A full message log is included. |
| **Jobs** | Assign jobs to technicians. Employees see only their own jobs and can mark them complete. |
| **Inventory** | Track stock levels and unit costs, with quick +/− and restock buttons. When an item drops to its low-stock level, admins get an SMS/email alert and a banner shows on the dashboard. The alert sends once and re-arms after you restock. |
| **Photos** | Before and after photos are taken from the phone camera and resized in the browser before upload. They show on the job, the customer profile and the printable invoice. Only logged-in users can open them, and employees can only open photos for their own jobs. |
| **Invoices** | An invoice is created automatically when a job is completed. You can mark it paid or unpaid, and print it or save it as PDF with the photos. |
| **Roles** | **Admin** has full access. **Employee** can see assigned jobs, upload photos and mark jobs complete. |
| **Dashboard** | Shows monthly revenue and bookings (12-month charts), customer retention, top customers, most popular services, today's jobs, unpaid invoices and low stock. |

## Architecture
- `src/server.js` contains the HTTP server, router, permission checks and every REST endpoint (`/api/...`).
- `src/db.js` sets up the SQLite schema and settings and creates the first admin.
- `src/notify.js` handles Twilio/SendGrid over REST and runs a scheduler every 60 seconds for reminders, follow-ups and low-stock checks.
- `public/` holds the single-page frontend (vanilla JS, no build step). It uses a light or dark theme to match the device.
- Data lives in `data/crm.db` and uploaded photos in `data/uploads/`. **Back up the `data/` folder.**

## Security
- Passwords are hashed with scrypt.
- Sessions use HttpOnly SameSite cookies and get the Secure flag when `NODE_ENV=production`.
- Write requests are protected against CSRF with a custom header.
- All SQL is parameterised and all output is HTML-escaped.
- Login attempts are throttled, path traversal is guarded and photo uploads are type-checked.
- Run it behind HTTPS (for example Caddy or nginx) in production.

## Tests
`npm test` runs an end-to-end API test of the full workflow: auth, CRM, booking, conflicts, recurrence, reminders and follow-ups, employee permissions, photos, invoices, inventory alerts and reports.

## Known limitations / next steps
- One business per install (not multi-tenant).
- Recurring bookings are created up front as N visits (max 52), not as an endless series.
- Monthly report buckets use UTC months, so a job just after midnight on the 1st of the month (in BST) can land in the previous month.
- There is no online customer self-booking page or card payments (Stripe) yet.
- Twilio expects phone numbers in E.164 format (`+447700900123`).
