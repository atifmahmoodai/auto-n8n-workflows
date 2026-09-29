# Tally: receipt scanner for iOS & Android

Snap a photo of any receipt (groceries, pharmacy, fuel, dining). Tally reads every line item and price,
shows them to you right away for a quick review, then saves the receipt on the phone and adds it to a
Google Sheet in the user's own Google Drive.

```
mobile/   Expo (React Native) app for iPhone and Android, TypeScript, Expo Router
server/   Small Node API that reads receipt photos with Claude (keeps the API key off the phone)
```

## How it works

1. **Sign in with Google** (native Google Sign-In). The app asks only for the `drive.file` scope, so it can
   create and edit *its own* spreadsheet and never sees the user's other Drive files.
2. **Scan**: the camera or photo library gives an image, which is resized on the device (≤ 2000 px, JPEG) and
   sent to `POST /v1/receipts/parse` with the user's Google ID token.
3. **Server** verifies the token, rate-limits per user, and asks Claude (vision + structured JSON output)
   for merchant, date, currency, items (name, qty, unit price, line total, category), tax and total.
4. **Review** shows every item and price immediately. Tap an item to fix it; a warning appears if the items
   don't add up to the printed total.
5. **Save** writes to a local SQLite database first (works offline), then syncs to Google Sheets:
   - A spreadsheet named **Tally Receipts** is created on first sync, with two tabs:
     `Receipts` (one row per receipt) and `Items` (one row per item).
   - Both rows are written in one atomic `batchUpdate`, and the receipt ID is checked first, so retries
     never create duplicates.
   - Failed syncs (offline, expired token) are retried when the app returns to the foreground, on
     pull-to-refresh, or from Settings → Sync now.

## Setup

### 1. Google Cloud (one-time)

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project and **enable the Google Sheets API**.
2. Configure the **OAuth consent screen** (External). Add the scope
   `https://www.googleapis.com/auth/drive.file`. It is a non-sensitive scope, so no security assessment is needed.
3. Create **OAuth client IDs**:
   - **Web application**: used as `webClientId` (this is the audience of the ID tokens the server checks).
   - **iOS**: bundle ID = `IOS_BUNDLE_ID`.
   - **Android**: package = `ANDROID_PACKAGE`, plus the **SHA-1** of your signing key
     (`eas credentials` shows it; add both the upload key and the Play App Signing key).

### 2. Server

```bash
cd server
cp .env.example .env    # fill in ANTHROPIC_API_KEY and GOOGLE_CLIENT_IDS
npm install
npm run dev             # http://localhost:8787
npm test
```

Deploy anywhere that runs Node 20+ or Docker (Fly.io, Railway, Render, Cloud Run):

```bash
docker build -t tally-server ./server
docker run -p 8787:8787 --env-file server/.env tally-server
```

It must be served over **HTTPS** in production. The rate limiter is in-memory; if you run more than one
instance, move it to Redis.

### 3. Mobile app

```bash
cd mobile
cp .env.example .env    # API URL + Google client IDs + bundle IDs
npm install
```

Google Sign-In and the camera use native code, so the app runs in a **development build**, not Expo Go:

```bash
npx eas-cli@latest build --profile development --platform ios      # or android
npx expo start --dev-client
```

(With Xcode / Android Studio installed you can use `npx expo run:ios` / `npx expo run:android` instead.)

Checks:

```bash
npm run typecheck && npm run lint && npm test
```

### 4. Release to the App Store and Google Play

1. Store the `EXPO_PUBLIC_*`, `IOS_BUNDLE_ID` and `ANDROID_PACKAGE` values as EAS environment variables
   for the `production` environment (`eas env:create`), or keep them in `.env` for local builds.
2. `npx eas-cli@latest build --profile production --platform all`
3. `npx eas-cli@latest submit --platform ios` / `--platform android`
4. Replace the placeholder icon and splash images in `mobile/assets/` with your brand.
5. Publish a privacy policy. Receipt photos are sent to your server and to Anthropic for processing; the
   server does not store them.

## Project layout

```
mobile/src/
  app/                  screens (Expo Router)
    _layout.tsx         auth gate, background sync
    sign-in.tsx         onboarding + Google sign-in
    index.tsx           dashboard: month total, recent receipts, Scan button
    scan.tsx            camera with frame guide, flash, library import
    review.tsx          extracted items & prices, edit, save
    receipt/[id].tsx    receipt detail, photo, retry sync, delete
    settings.tsx        account, spreadsheet link, sync status, sign out
  components/           UI kit, item editor sheet, item rows
  lib/
    auth.tsx            Google Sign-In, token refresh-and-retry
    api.ts              receipt parsing API client
    db.ts               SQLite schema, migrations and queries
    sheets.ts           Google Sheets create/append (atomic, idempotent)
    sync.ts             sync queue
    receipts.ts         draft → receipt logic, totals validation
server/src/
  app.ts                routes, auth middleware, validation, rate limiting
  extract.ts            Claude call + structured output
  schema.ts             request/response schemas
  auth.ts               Google ID token verification
```
