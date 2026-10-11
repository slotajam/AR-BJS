# Freon TankTracker

Freon TankTracker is a mobile-first web app for refrigerant cylinders. It registers new cylinders, prints unique QR labels and records custody events (dispatch, receipt, return and so on) with evidence. It is built for checking where cylinders sent to upcountry customers were last recorded.

**How an event is recorded, on one phone screen:**
**Bottom half:** the server confirms a fresh, accurate location inside the site. **Top half:** the live QR scanner unlocks. **Finish:** a 4-digit SMS code is sent to a registered phone, and the event is saved only when that code is entered.

> **What it does and does not prove.** The app records the **scanning phone's reported location at events**. It is not live tracking. A QR scan, a location fix, a scan photo and an SMS code together are **not conclusive proof** that the cylinder was present:
> - browser location can be spoofed;
> - a QR can be photographed or copied, and the automated tests show that a QR on a screen still decodes;
> - an SMS code proves only that someone had the registered phone at that moment.
>
> A driver and a customer working together can defeat every in-app check. For that, the controls are **weighing, random independent audits and customer statements**, which are built in. They make misuse more likely to be caught. They do not prevent it.

## Quick start

```bash
cd freon-tanktracker
npm install
npm run seed      # admin / supervisor / operator1 / operator2 + 4 sample sites (prints passwords)
npm start         # http://localhost:3000
```

1. Log in as **admin**. Under **Users**, enter each person's mobile number. Under **Sites**, check the geofences (centre and radius) and enter each customer site's contact mobile.
2. Each user opens **My phone**, taps **Send code** and enters the code. A customer contact is verified by the admin on **Sites** while talking to the customer. Nobody can record events until their number is verified.
3. In development the SMS provider is `console`. Codes are **not sent**: they appear in the server log and in a red "DEVELOPMENT SMS" box in the app. Configure a real provider before real use (see SMS below).

Camera and location need **HTTPS**, except on `localhost`. For a pilot on a local network, use `npm run cert -- <LAN-IP>`. For production, use a TLS reverse proxy and set `PUBLIC_BASE_URL=https://your-domain`. **Set it before you print labels**, because the QR encodes that address.

| Env var | Purpose |
|---|---|
| `PORT` | listen port (default 3000) |
| `DATA_DIR` | database, reference photos and scan photos (default `./data`) |
| `PUBLIC_BASE_URL` | base URL encoded in QR labels and statement links |
| `TLS_CERT` / `TLS_KEY` | serve HTTPS directly |
| `TILE_URL` | map tiles (default OpenStreetMap; empty = no tiles, circles still drawn) |
| `NODE_ENV=production` | refuses the development SMS provider |
| `SMS_PROVIDER` | `console` (dev default), `twilio`, `thaibulksms`, or `none` (production default: events are refused, never faked) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | Twilio |
| `THAIBULKSMS_API_KEY`, `THAIBULKSMS_API_SECRET`, `THAIBULKSMS_SENDER` | ThaiBulkSMS |
| `CODE_SECRET` | optional HMAC secret for codes. Otherwise one is generated in `DATA_DIR/code-secret.key` |

## Tests

```bash
npm test          # 19 API acceptance tests on a fresh database
npm run test:e2e  # Chromium: fake camera playing a picture of the QR, fake GPS, dev SMS; screenshots in test-output/
```

What the tests cover:
- **Registration and labels:** duplicate-serial rejection; opaque QR label; opening the QR URL is read-only.
- **Phone rules:** a user without a verified phone is refused; phone verification works; changing the number clears verification.
- **Location gate:** scanning before the location is confirmed is refused. In the browser, the scanner does **not** decode while locked.
- **Location problems:** stale, inaccurate and outside-site fixes are not confirmed. The exception path is never marked location-verified. The location confirmation expires and the scanner locks again.
- **SMS code:** the event is written only after the code. Wrong code ×5 cancels it. An expired code leaves the cylinder unchanged. Resend cooldown and limit are enforced.
- **Live capture:** gallery images and manual QR entry are refused; the scan photo is required (and can be switched off).
- **Copied QR:** a QR photo on another screen decodes, gets flagged, is rejected, and the approved location stays unchanged.
- **Custody:** dispatch needs a weight; receipt needs its own inspection; the customer's code goes to the customer's phone, and a fallback is flagged.
- **Weighing signals:** below tare, returned unused, weight gain, self-weighed return.
- **Audits:** concurrent submissions; risk-weighted audits with an independent auditor; audits hidden from operators; "not found" flags the chain of records.
- **Customer statements:** single-use link that expires; a dispute needs comments.
- **Other rules:** driver/customer pair concentration; append-only audit history; SMS provider rules; NFC never simulated.

## How it works

**Inspection page (split screen)**
1. **Location (bottom half).** Live `watchPosition` (high accuracy, `maximumAge: 0`), with a fresh poll every 10 s. It shows a map with an accuracy circle, the fix age and the geofence. The nearest site is pre-selected.
   - **Confirm location** sends the fix to the server. The server checks age (≤ 30 s), accuracy (≤ 50 m) and that the fix is **inside** the site geofence.
   - The server keeps the confirmation for 2 minutes (setting). If the fix becomes old, inaccurate or outside the site, or the 2 minutes pass, the scanner locks again straight away.
   - Coordinates cannot be typed, and the pin cannot be moved.
   - If the location cannot be confirmed, the user can retry, or continue as a **supervisor exception**. The event is then "Exception pending" and never location-verified.
2. **QR scan (top half).** Live camera only. The decoder does not run while locked, and the server refuses `/scan` without a valid location confirmation. There is no file picker and no typed code. At the moment of decoding, **one still photo** is taken from the live frame for the supervisor (setting, ON by default).
3. **Details:** event type, bay, destination, condition, comments and checklist.
   - Dispatch, return and warehouse receipt at a warehouse require the **gross weight** (setting).
   - Audits require an audit outcome.
4. **SMS code.** The server stores a *pending* submission and sends a 4-digit code: valid 5 minutes, 5 tries, 2 resends with a 60 s wait. Codes are stored only as an HMAC.
   - **Customer received** sends the code to the customer site's verified contact phone (setting, ON). The customer reads it to the driver, which gives a second, independent confirmation.
   - The correct code writes the event (append-only) and applies it atomically, with a concurrency check. Expired or cancelled codes change nothing and are logged.

**Review signals** (prompts for review, not proof):
- outside or near the edge of the geofence; implausible travel; repeated scans; unexpected custody; clock skew;
- phone moved between location confirmation and scan;
- wrong code attempts; code confirmed slowly; customer code entered within 10 s;
- receipt without the customer's code; phone number changed recently;
- weight below tare, returned unused, weight gain, self-weighed return;
- driver/customer pair concentration;
- audit mismatch or not found.

Any signal sends the event to the supervisor queue. The supervisor sees the scan photo, location, timings, who confirmed the code, weights and signals.

**Anti-collusion controls**
- **Weighing:** the weight is compared with the last dispatch weight and the registered tare.
- **Random audits:** picked weekly, or on demand from **Audit tasks**.
  - Cylinders with signals, long stays at a customer or weight problems are picked more often.
  - Each audit is assigned to a supervisor or admin who did **not** move the cylinder last and has no events at its site in the last 90 days. The server enforces this.
  - Operators cannot see audits.
  - An auditor records found OK or mismatch (through the normal location, scan and code flow), not found, or customer refused.
  - **Not found** opens a missing case and flags every event since the last good audit.
- **Customer statements:** monthly (setting), or on demand from **Customer statements**. Each verified customer contact gets an SMS link listing the cylinders recorded at the site, to confirm or dispute. Disputes and unanswered statements appear on the dashboard.
- **Dashboard:** risk summary per driver and per site, weight signals, statement follow-ups, codes awaiting or unconfirmed, and open audits.
- **Process advice (not code):**
  - rotate drivers between routes;
  - have warehouse staff weigh on a calibrated scale and record the scale ID;
  - reconcile cylinder counts against delivery notes and invoices every month;
  - treat audit results as the strongest evidence.

**Core records**
- **Roles** (enforced on the server): *Administrator* registers cylinders, prints and replaces labels, manages sites, users, phones and settings. *Operator* records events and exceptions and reports missing cylinders. *Supervisor* reviews the queue, approves or rejects, adds corrections and performs audits. No one can review their own submission.
- **Registration:** the engraved serial is required and unique; reference photos of the whole cylinder and the serial are stored.
- **QR labels:** each QR encodes only `PUBLIC_BASE_URL/c/<random token>` (no serial, customer data or coordinates). Labels print singly or in batches, reprints are logged, and replacing a label revokes the old token. Opening the URL with a normal phone camera shows a read-only page and never records a location.
- **Movement:** dispatch or transfer sets **In transit**; receipt needs its own inspection at the destination. Movement status and verification status (Recorded, Evidence pending review, Evidence reviewed, Exception pending, Rejected) are separate, and so are the latest submitted event and the last approved event. A rejected event never replaces the last approved location.
- **Exceptions:** damaged label (cylinder chosen by serial, supervisor approval needed), location not confirmed, and missing reports.
- **Audit trail:** events, reviews, flags, the audit log and label prints are append-only (SQLite triggers abort any change). Corrections are new entries that reference the original. Scan photos are visible only to supervisors, admins and the person who took them, and every view is logged. Retention (default 365 days) purges photos but keeps records.
- **Dashboard:** counts, cylinders by status and site, overdue returns, cylinders without a recent inspection, map of last approved locations with accuracy circles, filters and CSV export.
- **Languages:** English and Thai.

## Needs external services, hardware or native development

| Item | Status |
|---|---|
| **SMS provider account** | Required for real use. The Twilio and ThaiBulkSMS integrations follow the vendors' published HTTP APIs but have **not been tested against a live account**. Thai sender names usually need registration with the provider. Each SMS costs money. Upcountry signal can delay codes. |
| **HTTPS hosting and domain** | Required for phone camera and location. |
| **Map tiles** | Public OpenStreetMap by default. Use a commercial tile provider for production volume. |
| **Secure NFC** | Integration point only (`501`). It needs authenticated tags, backend keys and tested hardware. Never simulated. |
| **Mock-location detection** | Not possible in a browser. A native Android app could partly detect mock GPS. |
| **Phone numbers and PDPA** | Mobile numbers are personal data. Inform staff and customer contacts and get consent. |

## Limitations

- A copied QR at the right place with the right phone passes the in-app checks. The scan photo, review signals and audits are what catch it.
- SIM swap or SMS forwarding defeats SMS codes. Watch the `phone_changed_recently` signal.
- If one person can use both the operator's phone and the customer's phone, the customer confirmation means nothing. That is why pair concentration and audits exist.
- Single-process SQLite (Node 22 built-in, experimental) suits a pilot. Use PostgreSQL to run several server instances.
