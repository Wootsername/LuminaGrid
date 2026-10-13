# LuminaGrid — Web Dashboard

Web-based monitoring dashboard for **LuminaGrid: An IoT-Based Smart Streetlight
Monitoring and Fault Detection System via GSM Network for Local Government
Units in Cebu City** (Capstone 2, University of Cebu – Main).

Built dashboard-first since the ESP32/SIM800L hardware isn't ready yet. Every
page reads and writes through `js/data-service.js`, whose *internals* now call
Firebase Realtime Database (all eight data nodes) and Firebase Authentication
(Email/Password). The legacy `data/mock-nodes.json` file was deleted in the
final migration step — `upsertStreetlight()`, `tickHeartbeat()` and
`markNodeActive()` now read and write Firebase like everything else, so no
runtime code depends on it anymore.

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
│   ├── firebase-config.js     Firebase project config (active — wired in)
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
└── assets/icons/               (empty — favicon, map pin icons, etc.)
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
on each `<a>`, checked by `gateNavByRole()` in `utils.js`, which every page
loads).

## Data model (Firebase Realtime Database)

Object-keyed by ID, matching the confirmed ERD field names exactly
(`fault_id`, `detected_at`, `resolved_at`, `description`, `severity`,
`ambient_light`, `power_consumption`, `light_status`, `repair_date`,
`repair_status`, `remarks`, `barangay`):

```
user/{user_id}                           first_name, last_name, email, role, contact_number, created_at
streetlight/{streetlight_id}             pole_number, barangay, latitude, longitude, installation_date, status
sensor_reading/{streetlight_id}/{reading_id}    current, voltage, ambient_light, power_consumption, light_status, timestamp
fault_report/{fault_id}                  streetlight_id, reading_id, fault_type, description, severity, status, detected_at, resolved_at
maintenance_record/{maintenance_id}      fault_id, user_id, repair_date, repair_status, remarks
notification/{notification_id}           fault_id, user_id, notification_type, status, sent_at
system_config                            energy_rate_per_kwh, thresholds, LDR dusk/dawn, heartbeat_timeout_minutes
energy_monthly/{YYYY-MM}                 month, total_kwh, cost
```

Seeded profile accounts (sign-in uses Firebase Authentication — Email/Password):
`juan.delacruz@cebucity.gov.ph` (Admin), `mario.reyes@cebucity.gov.ph`
(Electrician), `liza.santos@cebucity.gov.ph` (Finance).

## Running it locally

Static site, no build step. From inside this folder:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`. (Must be served over `http://`, not
opened as `file://` — the Firebase SDK needs a real origin.)

## What's real vs. what's stubbed

**Working now, against Firebase Realtime Database + Authentication:**
login (Email/Password, role-based redirect), live map with status-colored
markers and node popups, KPI counters, fault alerts, resolving faults,
energy charts + CSV export, user account management, full fault history,
and a merged system-log feed.

**Node registration and the dashboard simulation buttons:** also against
Firebase — `upsertStreetlight()`, `tickHeartbeat()` and `markNodeActive()`
were migrated off the legacy mock file, which has been deleted.

**Known simplifications, flagged in code comments:**
- `DataService.addUser()` creates the Firebase Auth credential through a
  secondary "UserCreator" Firebase app instance — a client-side prototype
  convenience; an admin-only server boundary would need the Admin SDK /
  Cloud Functions.
- `super-admin.html`'s passphrase gate is a placeholder, not real access
  control.
- Energy kWh figures are a rough per-reading estimate
  (`power_consumption / 1000`), not a real interval-based accumulation.

## Next steps

1. Harden the Firebase Realtime Database security rules once migration
   cleanup is complete (temporary read/write rules are in place for the
   migration period).
2. Replace the placeholder map center in `dashboard.js` with the real GPS
   coordinates of the four installed nodes.
3. Decide whether `super-admin.html`'s other Use Case items (deploy
   firmware, configure DB/backend settings, monitor system health) need
   actual UI, or stay as manual dev-team tasks — flagged as an open
   assumption in the page itself.
