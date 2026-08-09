# LuminaGrid — Web Dashboard

Web-based monitoring dashboard for **LuminaGrid: An IoT-Based Smart Streetlight
Monitoring and Fault Detection System via GSM Network for Local Government
Units in Cebu City** (Capstone 2, University of Cebu – Main).

Built dashboard-first since the ESP32/SIM800L hardware isn't ready yet. Every
page reads and writes through `js/data-service.js`, which currently serves
mock data from `data/mock-nodes.json`. When hardware exists, only the
*internals* of `data-service.js` change to real Firebase Realtime Database
calls — no other file in this project needs to be touched.

## Folder structure

```
luminagrid-dashboard/
├── index.html               Secured Login Portal
├── dashboard.html            Interactive Telemetry Dashboard / Main Map View
├── energy-analytics.html     Energy Analytics Workspace (Admin, Finance)
├── node-management.html      Register / configure monitoring nodes (Admin)
├── user-management.html      Manage Electrician & Finance accounts (Admin)
├── fault-records.html        Full fault history + resolve (Admin)
├── system-logs.html          Combined audit feed (Admin)
├── super-admin.html          Dev-team panel — creates the Admin account
│
├── css/
│   └── style.css              shared styling for every page
│
├── js/
│   ├── firebase-config.js     Firebase project keys (commented out until wired in)
│   ├── data-service.js         ★ single data-access layer — every page calls this
│   ├── utils.js                requireRole(), role labels, user chip, logout, date formatting
│   ├── auth.js                 login only — no self-registration (see below)
│   ├── dashboard.js
│   ├── energy-analytics.js
│   ├── node-management.js
│   ├── user-management.js
│   ├── fault-records.js
│   ├── system-logs.js
│   └── super-admin.js
│
├── assets/icons/               (empty — favicon, map pin icons, etc.)
└── data/
    └── mock-nodes.json         6 ERD entities, object-keyed by ID
```

## Why no register.html

Per the confirmed Use Case Diagrams, there's no self-service sign-up for any
of the three LGU-facing roles:

- The **Super Admin** (dev team, `super-admin.html`) creates the one
  **Barangay/LGU Administrator** account.
- That **Administrator** then creates **Maintenance Electrician** and
  **Budget/Finance Officer** accounts in `user-management.html`.

## Roles enforced by `requireRole()` (in `utils.js`)

| Page | admin | electrician | finance |
|---|---|---|---|
| dashboard.html | ✔ | ✔ | ✔ |
| energy-analytics.html | ✔ | — | ✔ |
| node-management.html | ✔ | — | — |
| user-management.html | ✔ | — | — |
| fault-records.html | ✔ | — | — |
| system-logs.html | ✔ | — | — |

The nav bar itself also hides links a role can't use (`data-roles` attribute
on each `<a>`, checked by `gateNavByRole()` in `dashboard.js` — worth lifting
into `utils.js` if you add it to every page).

## Data model (`data/mock-nodes.json`)

Object-keyed by ID, matching the confirmed ERD field names exactly
(`fault_id`, `detected_at`, `resolved_at`, `description`, `severity`,
`ambient_light`, `power_consumption`, `light_status`, `repair_date`,
`repair_status`, `remarks`, `barangay`):

```
users/{user_id}                          first_name, last_name, email, role, contact_number, created_at
streetlights/{streetlight_id}            pole_number, barangay, latitude, longitude, installation_date, status
sensor_readings/{streetlight_id}/{reading_id}   current, voltage, ambient_light, power_consumption, light_status, timestamp
fault_reports/{fault_id}                 streetlight_id, reading_id, fault_type, description, severity, status, detected_at, resolved_at
maintenance_records/{maintenance_id}     fault_id, user_id, repair_date, repair_status, remarks
notifications/{notification_id}          fault_id, user_id, notification_type, status, sent_at
```

Seeded test accounts (any non-empty password works — see note below):
`juan.delacruz@cebucity.gov.ph` (Admin), `mario.reyes@cebucity.gov.ph`
(Electrician), `liza.santos@cebucity.gov.ph` (Finance).

## Running it locally

Static site, no build step. From inside this folder:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`. (Must be served over `http://`, not
opened as `file://` — the `fetch()` call in `data-service.js` for
`mock-nodes.json` will fail otherwise.)

## What's real vs. what's stubbed

**Working now, against mock data:** login (role-based redirect), live map
with status-colored markers and node popups, KPI counters, fault alerts,
resolving faults, energy charts + CSV export, node registration, user
account management, full fault history, and a merged system-log feed.

**Known simplifications, flagged in code comments:**
- `auth.js` checks mock users with any non-empty password — swap for real
  `firebase.auth().signInWithEmailAndPassword()` once Firebase is live.
- `DataService.addUser()` only writes the profile record — creating the
  actual Firebase Auth sign-in credential for someone else needs to go
  through a Cloud Function/Admin SDK, not the client.
- `super-admin.html`'s passphrase gate is a placeholder, not real access
  control.
- Energy kWh figures are a rough per-reading estimate
  (`power_consumption / 1000`), not a real interval-based accumulation.

## Next steps

1. Swap `data-service.js` internals for Firebase Realtime Database calls
   once the four ESP32 nodes are transmitting.
2. Replace the mock-password check in `auth.js` with real Firebase Auth.
3. Replace the placeholder map center in `dashboard.js` with the real GPS
   coordinates of the four installed nodes.
4. Decide whether `super-admin.html`'s other Use Case items (deploy
   firmware, configure DB/backend settings, monitor system health) need
   actual UI, or stay as manual dev-team tasks — flagged as an open
   assumption in the page itself.
