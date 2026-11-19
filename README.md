# LuminaGrid — Web Dashboard

Web-based monitoring dashboard for **LuminaGrid: An IoT-Based Smart Streetlight
Monitoring and Fault Detection System via GSM Network for Local Government
Units in Cebu City** (Capstone 2, University of Cebu – Main).

The static dashboard uses Firebase Authentication and Realtime Database through
`js/data-service.js`. Trusted Node.js workers handle automatic faults and interval
energy accounting. The dashboard shows worker-owned operational status alongside
device heartbeat and sensor data.

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

Sign in with a Firebase Authentication account and role assigned by the project owner.

## Running it locally

Static site, no build step. From inside this folder:

```
python -m http.server 8080 --bind 127.0.0.1
```

Then open `http://localhost:8080`. (Must be served over `http://`, not
opened as `file://` — the Firebase SDK needs a real origin.) The checked-in web
configuration points to the project database. Use team-approved test Firebase
configuration and accounts when testing actions that write data. Keep Admin
credentials outside the web root. For shared hosting, publish only the HTML,
`js/`, `css/`, and `assets/` files.

## Development checks

Run from the repository root with Node.js and npm. The suites use local fixtures
and Firebase doubles and run without Firebase credentials.

```text
npm ci --prefix backend
npm test --prefix backend
npm run test:browser --prefix backend
```

The browser smoke test uses local Chromium. Set `LUMINAGRID_TEST_BROWSER` to its
executable path if needed. Review `git status` before committing and keep
credentials, device captures, and local experiments out of shared branches.

## What's real vs. what's stubbed

**Working now, against Firebase Realtime Database + Authentication:**
login (Email/Password, role-based redirect), live map with status-colored
markers and node popups, KPI counters, fault alerts, resolving faults,
energy charts + CSV export, user account management, full fault history,
and a merged system-log feed.

**Node registration:** writes the registered node and its coordinates to
Firebase. The dashboard reads telemetry and automatic fault status from Firebase.

**Known simplifications, flagged in code comments:**
- `DataService.addUser()` creates the Firebase Auth credential through a
  secondary "UserCreator" Firebase app instance — a client-side prototype
  convenience; an admin-only server boundary would need the Admin SDK /
  Cloud Functions.
- `super-admin.html`'s passphrase gate is a placeholder, not real access
  control.
- Energy totals come from the trusted worker interval aggregates. Offline
  checks do not exercise the live worker deployment.

## Next steps

1. Verify the deployed Firebase Realtime Database rules against the team role
   and write-access requirements before deployment.
2. Replace the placeholder map center in `dashboard.js` with the real GPS
   coordinates of the four installed nodes.
3. Decide whether `super-admin.html`'s other Use Case items (deploy
   firmware, configure DB/backend settings, monitor system health) need
   actual UI, or stay as manual dev-team tasks — flagged as an open
   assumption in the page itself.
