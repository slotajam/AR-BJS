# Freon TankTracker

Freon TankTracker is a mobile-first web app for refrigerant cylinders. It registers new cylinders, prints unique QR labels and records inspections and custody movements, with fresh evidence for each one. It is built for checking where cylinders delivered to upcountry customers were last recorded.

> **What it does and does not prove.** The app records the **scanning phone's reported location at inspection events**. It is not live tracking. A QR scan is not conclusive proof that the cylinder was present. A QR code shown on another screen or in a photo still decodes, and the automated tests show this. Browser camera and location data can be manipulated by a determined user, so none of these controls are tamper-proof. Fresh evidence clips, server checks and review signals help supervisors **detect and investigate** misuse. They do not prevent it.

## Quick start

```bash
cd freon-tanktracker
npm install                         # also copies browser libraries into public/vendor
npm run seed                        # creates admin/supervisor/operator accounts (prints passwords) and sample sites
npm start                           # http://localhost:3000
```

Camera and geolocation work only in a **secure context**: HTTPS, or `localhost` on the same machine. To test with phones:

* **Pilot on a LAN:** `npm run cert -- <server-LAN-IP>` creates a self-signed certificate. Then run
  `TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem PUBLIC_BASE_URL=https://<ip>:3000 npm start`. Phones will show a certificate warning.
* **Production:** put the app behind a reverse proxy with a publicly trusted certificate (for example Let's Encrypt) and set `PUBLIC_BASE_URL=https://your-domain`. **Set `PUBLIC_BASE_URL` before you print labels**, because the QR encodes that address.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `DATA_DIR` | `./data` | SQLite database, reference photos and evidence clips |
| `PUBLIC_BASE_URL` | the address the admin browser used | Base URL encoded in QR labels |
| `TLS_CERT` / `TLS_KEY` | – | Serve HTTPS directly |
| `TILE_URL` | OpenStreetMap tiles | Map tiles. Set to empty for no tiles: accuracy circles still draw |

## Tests

```bash
npm test          # 15 API acceptance tests on a fresh database (section 13)
npm run test:e2e  # Chromium run with a fake camera and geolocation; screenshots go to test-output/
```

Mapping to the section 13 acceptance tests:

| Scenario | Where |
|---|---|
| Registration, duplicate-serial rejection | test 1, e2e |
| QR label generation, normal phone-camera opening | test 2, e2e (`03-label`, `04-qr-landing`) |
| Opening the QR URL without changing location | test 3 |
| Successful controlled inspection | test 4, e2e (`05`–`10`) |
| Location permission denied | test 5, e2e (`11`, `12`) |
| Poor / stale location | test 6 |
| Expired / reused challenge, idempotent replay | test 7 |
| Gallery-upload attempt, manual QR entry | test 8 |
| QR photo on another phone decodes → flagged → rejected | test 9, plus the e2e camera itself, which is fed a *picture* of the QR |
| Damaged-label exception, label replacement and revocation | test 10 |
| Separate dispatch and destination receipt | test 11 |
| Concurrent submissions | test 12 |
| Rejected evidence leaves the approved location unchanged | test 9 |
| Operator cannot alter audit history | test 13 |
| NFC: no simulated success | test 15 |

## How it works

**Roles.** All checks run on the server.
* *Administrator*: registers cylinders, prints and replaces labels, manages sites, users and settings, retires cylinders.
* *Operator*: scans, inspects, submits movements and exceptions, reports missing cylinders.
* *Supervisor*: reviews the evidence queue, approves or rejects, adds corrections.

No user can review their own submission.

**QR.** Each QR encodes `PUBLIC_BASE_URL/c/<128-bit random token>` and nothing else: no serial, customer data or coordinates. Opening the URL shows a read-only page with no location request and nothing written. Replacing a label revokes the old token. Scanning a revoked token is refused and logged.

**Controlled inspection (8 steps).**
1. Start an authenticated session.
2. Grant camera, microphone and location permission.
3. Scan the QR with the in-app live scanner (BarcodeDetector or jsQR).
4. Check the cylinder's serial and reference photos.
5. Take a fresh high-accuracy fix (`maximumAge: 0`) and see it on a map with an accuracy circle. Coordinates cannot be typed or pinned.
6. Record a video through the live camera with `MediaRecorder` while saying a 4-digit code. The code comes from a server-issued challenge that is single-use, short-lived and tied to the user, cylinder and session, with a random instruction.
7. Complete the required checklist and movement details.
8. Review and submit with an `Idempotency-Key`.

The normal flow has no gallery picker and no manual QR field.

**Server validation, applied atomically.** On submit the server checks:
* role and session expiry;
* that the challenge is unused and unexpired;
* that a clip was uploaded for that challenge and is not longer than the time since the challenge was issued;
* that the QR token is still active;
* the checklist, and comments when a problem is reported;
* fix age (default ≤ 30 s, measured on the phone's clock plus network delay) and accuracy (default ≤ 50 m);
* the movement rules;
* that the cylinder version has not changed since the challenge was issued. If it has, the submission gets `409 CONCURRENT_UPDATE`.

If location fails, normal submission is blocked. The user can retry, or file an exception that is marked as not location-verified.

**Movement and verification are separate.**
* Dispatch or transfer sets the cylinder to **In transit**. Arrival is never assumed: receipt needs its own inspection at the destination.
* A clean event is **Recorded**. An event with any review signal or a problem condition is **Evidence pending review**. Exceptions are **Exception pending**. Supervisors set **Evidence reviewed** or **Rejected**.
* The latest submitted event and the latest approved event are tracked separately. A rejected event never replaces the last approved location. **Secure tag authenticated** exists in the model but is never shown, because no verifier is configured (see below).

**Review signals.** These are not proof of fraud:
* outside the site geofence, or near the boundary and uncertain;
* implausibly fast travel;
* repeated scans within N minutes;
* byte-identical evidence files;
* unexpected custody changes;
* phone clock skew;
* problem conditions and exceptions.

Indoor rack or bay is shown as *operator-reported*. GPS does not verify it.

**Audit.** `events`, `reviews`, `flags`, `audit_log` and `label_prints` are append-only. SQLite triggers abort any UPDATE or DELETE, even from direct SQL. A correction is a new event that references the original. Evidence clips can be viewed only by supervisors, admins and the uploader, and every view is audited. Evidence retention (default 365 days) is configurable and purges clips while keeping the event records.

**Dashboard.** Shows registered count, cylinders by status and site, overdue returns, cylinders without a recent inspection, pending evidence and exceptions, and suspicious signals. The map shows last approved locations with accuracy circles and event age. Filters: serial, gas, customer, site, operator, dates, movement and verification status. CSV export of cylinders and events is available to admins and supervisors, with protection against spreadsheet formula injection.

**Pilot settings.** Fix age, accuracy, timeouts, challenge lifetime, clip length, travel speed, repeat window, overdue thresholds, retention and auto-accept are all set under *Admin → Settings*. Adjust them after warehouse testing.

## Features that need external services, hardware or native development

| Feature | Status |
|---|---|
| **HTTPS hosting and a domain** | Required for phone camera and location. Not included. Use a TLS reverse proxy or `npm run cert` for pilots. |
| **Map tiles** | Uses the public OpenStreetMap tile servers by default. For production volume, use a tile provider that fits your usage policy and set `TILE_URL`. Without tiles, maps still show accuracy circles on a blank background. |
| **Secure NFC** (section 12) | **Integration point only, not implemented.** It needs cryptographically authenticated tags (for example NTAG 424 DNA SUN), metal-mount tag housings, backend key management (HSM/KMS) and a verifier implemented and tested against vendor test vectors. Web NFC works only in Chrome on Android; iOS needs a native app. `server/nfc.js` documents the design, the `nfc_tags` table and endpoints exist, and every call returns `501`. Success is never simulated. Even a secure tag proves only that the tag was read. It does not prove GPS location, and it does not stop tag removal or relay attacks. |
| **Automated "photo vs real cylinder" detection** | Not built, on purpose. Review is human. Any future analysis must show its uncertainty and allow review. |
| **Durable label stock and printer** | Labels print from the browser. Use weather- and chemical-resistant stock and never cover markings, engraved serials or safety labels. |
| **Offline capture** | If the network fails at submit, the payload is kept under *Pending Submissions* with a Retry button. Retry is likely to be refused if the location fix or challenge has expired, and the app says so. |

## Limitations (honest)

* The server cannot prove that a clip came from the live camera rather than a modified client, or that a fix came from real GPS rather than a spoofed one. Clip duration versus challenge time, identical-file detection, geofence and travel checks, and human review reduce this risk but do not remove it.
* A fix-age check depends on the phone's clock. Large skew is flagged.
* Single-process SQLite (Node's built-in `node:sqlite`, experimental in Node 22) suits a pilot. For multiple server instances, move to PostgreSQL. The writes already run in transactions.
