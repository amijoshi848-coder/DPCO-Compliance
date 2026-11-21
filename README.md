# DPCO Compliance — NPPA Pricing & Form I Intelligence

Full-stack NPPA DPCO 2013 & NLEM 2022 regulatory compliance workspace built with React, TypeScript, Tailwind CSS, and Express.

## Features
- **Login Portal (`DPCO Compliance`)**: Brief overview, feature summary boxes (`Ceiling Price`, `Retail Price`, `Form I Updates`), and role-based access (`Admin` + `Allowed Login IDs`).
- **Schedule Formulations**: Master ceiling price logs by composition, strength, and dosage format with instant MRP conversion (`Ceiling Price + (Ceiling Price × GST%)`) × Pack Size, plus daily 10:00 AM IST & manual sync for NPPA Circulars (`view_more?id=4`), Authority Minutes (`year2026-2027`), and Expert Committee Minutes (`expertscommittee`).
- **Retail Prices**: Post-16 July 2026 Form 1A ready reference log with Notification Number, Date, Formulation, Retail Price, GST-adjusted MRP, and automated 1-year retention tracking.
- **Company Details**: Corporate registration details and existing manufactured formulations portfolio.
- **New Product (Form I & Existing Manufacturer Check)**: Screens new formulations against NLEM 2022 and checks existing manufacturer status against the company portfolio and NLEM 2022 schedule.
- **Admin Access Control**: Add, enable/disable, or delete allowed Login IDs, edit/delete any regulatory records, and export standalone HTML.

## Local & Render Deployment
```bash
npm install
npm run build
npm start
```
