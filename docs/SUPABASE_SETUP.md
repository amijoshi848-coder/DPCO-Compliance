# Supabase storage for DPCO Compliance

Project: DPCO Compliance (`sxhlxlqsdvldccayomyq`, Singapore).
Project URL: https://sxhlxlqsdvldccayomyq.supabase.co

## Status and design

The `public.dpco_app_state` table is provisioned with row-level security enabled, no browser grants, and server-only access. It stores the existing application's complete database document as JSONB, including password hashes, in one row. This is a compatibility migration, not a redesign into separate company tables. Existing application permissions and its shared company profile remain unchanged; this does not add tenant isolation or Supabase Auth.

Reads come from Supabase; saves wait for a confirmed database response. A revision condition rejects concurrent stale writes rather than silently losing another user's work. Conflicts require refresh/retry. This design is suitable for the initial small application; split into relational tables before high concurrency or independent company tenants.

Original PDF files are not archived by this change. Their extracted data and existing metadata are retained. Supabase Storage can be added separately.

## Before merging or deploying

Render currently uses temporary local files. Redeploying can erase records entered since its last start. Obtain a verified, current full JSON backup from the running application before redeploying. Do not assume the JSON file committed to GitHub contains the latest live records. Keep backups private: they contain user password hashes and company details.

The initial import is explicit and never overwrites a populated database. An empty or inaccessible remote database prevents startup; the app never silently replaces it with demo data or falls back to local storage.

## Server-only environment variables

In the new DPCO-Compliance Render service add:

- `SUPABASE_URL=https://sxhlxlqsdvldccayomyq.supabase.co`
- `SUPABASE_SECRET_KEY`: a secret API key from the Supabase project's Settings > API Keys (a legacy service_role key is also supported). Never use a publishable/anon key here and never put this value in GitHub, chat, or VITE_* variables.
- `SESSION_SECRET`: retain the existing stable random secret so active sessions do not change unexpectedly.
- `ADMIN_LOGIN_ID` and `ADMIN_PASSWORD`: retain the existing configured administrator values if used.
- Keep `GEMINI_API_KEY` and `NODE_ENV=production`.

No Render disk or DATA_DIR is needed for records once Supabase is active. Both Supabase variables must be present; partial configuration fails clearly. Without either variable, local development continues using its existing JSON storage.

## Import, then activate

In a trusted environment with the two Supabase variables set privately:

```sh
node scripts/import-supabase.ts /absolute/path/to/verified-current-backup.json
```

Import only once. A second import returns a conflict instead of overwriting the database. If intentionally starting from the repository's baseline, review its records and accounts first and explicitly choose that file; it is not automatically imported.

Merge the tested branch only after the import and Render environment configuration are ready. Render auto-deploys main. It currently uses `bun install --frozen-lockfile && bun run build` and `bun run start`. No dependency changes are needed for this adapter (it uses Node's native fetch).

After deployment: log in, save a test company edit, reload, and restart/redeploy to verify the edit remains. Check /api/health and exercise pricing edits, PDF conversion, and NPPA sync. Automatic NPPA scheduling still needs a running server; free Render instances sleep.

## Validation

`node --test tests/storage.test.ts` checks persistence after reload, stale-write rejection, database failures, missing configuration, and non-destructive import.

The database was checked directly for RLS and grants, and transactional write/revision checks were rolled back. The Supabase advisor's informational `rls_enabled_no_policy` finding is intentional: browser roles have no grants or policies, while server credentials access the table. See https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy .
