# DPCO Compliance — NPPA Pricing & Form I Intelligence

Full-stack NPPA DPCO 2013 & NLEM 2022 regulatory compliance workspace built with React, TypeScript, Tailwind CSS, and Express.

## Features
- **Authorized Login & Admin Access Control**: Server-side hashed authentication (`scrypt`) configured via `ADMIN_LOGIN_ID` and `ADMIN_PASSWORD` environment variables (with one-time initial admin setup if omitted), plus multi-user team management under Admin Access.
- **Schedule Formulations**: Master ceiling price logs by composition, strength, and dosage format with instant MRP conversion (`Ceiling Price + (Ceiling Price × GST%)`) × Pack Size, plus daily 10:00 AM IST & manual sync for NPPA Circulars (`view_more?id=4`), Authority Minutes (`year2026-2027`), and Expert Committee Minutes (`expertscommittee`), direct PDF download, and S.O. number/date tracking.
- **Retail Prices**: Post-16 July 2026 Form 1A ready reference log with Notification Number, Date, Formulation, Retail Price, GST-adjusted MRP, and automated 1-year retention tracking.
- **Company Details**: Corporate registration details and multi-composition Fixed Dose Combination (FDC) product portfolio with Excel (`.xlsx` / `.xls` / `.csv`) upload, template download, and portfolio export.
- **New Product (Form I & Existing Manufacturer Check)**: Screens new formulations against NLEM 2022 and checks existing manufacturer status against the company portfolio and NLEM 2022 schedule.
- **Compliance Calendar & AI Search**: Visualizes Authority/Expert Committee meetings and regulatory deadlines, plus server-side Gemini AI regulatory Q&A, semantic search, and PDF-to-data extraction.

---

## Runtime & Local Development

- **Node.js Version**: `22.23.2` (pinned in `.nvmrc`, `package.json` `engines`, and `render.yaml`; required `>=22.18.0 <23.0.0` for native TypeScript execution of `node server.ts`).

```bash
cp .env.example .env
# Edit .env to set ADMIN_LOGIN_ID, ADMIN_PASSWORD, and optionally GEMINI_API_KEY
npm install
npm run dev
```

Verify production build & server locally:

```bash
npm run build
NODE_ENV=production npm start
```

---

## Deploying on Render

The repository includes a ready-to-use `render.yaml` Blueprint. You can deploy via **New + → Blueprint** in Render, or configure a **Web Service** manually with the exact settings below:

### Service Settings
| Setting | Value |
| --- | --- |
| **Runtime** | `Node` |
| **Node Version** | `22.23.2` (read automatically from `.nvmrc` or `NODE_VERSION`) |
| **Build Command** | `npm install --include=dev && npm run build` |
| **Start Command** | `npm start` (`node server.ts`) |
| **Health Check Path** | `/api/health` |

### Persistent Disk (Recommended)
To preserve `nppa_compliance_db.json` (users, company portfolio, ceiling/retail prices, S.O. tracking, and NPPA logs) across deploys and restarts:
1. Attach a **Render Persistent Disk** (available on **Starter** or higher plans):
   - **Name**: `dpco-data`
   - **Mount Path**: `/var/data`
   - **Size**: `1 GB` (minimum)
2. Set `DATA_DIR=/var/data` in Environment Variables.

*(If deploying on the Free tier without a persistent disk, remove the `disk` block from `render.yaml` and omit `DATA_DIR` so the server falls back to `./data`; note that Free tier local disk storage is ephemeral across restarts/deploys.)*

### Environment Variables (Server-Side Only)
Configure these in **Render Dashboard → Environment**:

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | Yes | Set to `production` |
| `NODE_VERSION` | Recommended | `22.23.2` |
| `SESSION_SECRET` | Yes | Secret used to sign session tokens (`generateValue: true` in `render.yaml`) |
| `ADMIN_LOGIN_ID` | Yes | Initial administrator Login ID (e.g. `admin`) |
| `ADMIN_PASSWORD` | Yes | Initial administrator password (kept secret on the server; never exposed to the browser) |
| `DATA_DIR` | With Disk | Directory path for database JSON storage (e.g. `/var/data`; defaults to `./data`) |
| `GEMINI_API_KEY` | Optional | Google Gemini API key for AI Assistant, semantic search, and PDF-to-data conversion (server-side only) |
| `PORT` | Auto | Injected automatically by Render (defaults to `3000` locally) |

## Supabase persistent storage

See [Supabase setup](docs/SUPABASE_SETUP.md) for server configuration, explicit data import, and deployment verification. Back up live data before redeployment.
