import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb, saveDb, initializeStorage, importDatabaseFile } from '../server/storage.ts';

const state = () => ({users: [], ceilingPrices: [], retailPrices: [], nlem2022: [], companyProfile: {}, ceilingPriceHistory: [], nppaLogs: [], syncLogs: [], customCalendarEvents: [], soTrackingRecords: [], lastDailyRunDateIst: null});

test('remote persistence survives reload, rejects concurrent stale saves, and does not expose secret in errors', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
  process.env.SESSION_SECRET = 'test-only-session-secret';
  let row: any = { payload: state(), revision: 1 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal((options!.headers as any).apikey, 'sb_secret_test_only');
    if (options!.method === 'GET') return Response.json([structuredClone(row)]);
    assert.equal(options!.method, 'PATCH');
    const expected = Number(new URL(String(url)).searchParams.get('revision')!.slice(3));
    if (row.revision !== expected) return Response.json([]);
    row = JSON.parse(options!.body as string);
    return Response.json([row]);
  };
  try {
    const a = await loadDb(); const stale = await loadDb();
    a.lastDailyRunDateIst = '2026-11-21';
    await saveDb(a);
    assert.equal((await loadDb()).lastDailyRunDateIst, '2026-11-21');
    await assert.rejects(saveDb(stale), (err: any) => err.status === 409);
    assert.equal(row.revision, 2);
    globalThis.fetch = async () => new Response('secret database error', {status: 500});
    await assert.rejects(loadDb(), (err: any) => err.status === 503 && !err.message.includes('secret'));
  } finally { globalThis.fetch = original; }
});

test('empty remote database never silently creates demo data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([]);
  try { await assert.rejects(loadDb(), /explicit database import/); }
  finally { globalThis.fetch = original; }
});

test('partial configuration and missing session secret fail closed', async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  await assert.rejects(loadDb(), /Configure both/);
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
  delete process.env.SESSION_SECRET;
  await assert.rejects(initializeStorage(), /persistent SESSION_SECRET/);
});

test('import inserts once and never replaces existing state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dpco-test-'));
  const file = join(dir, 'backup.json');
  writeFileSync(file, JSON.stringify(state()));
  const original = globalThis.fetch;
  let inserted = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options!.method, 'POST');
    if (inserted) return new Response('', {status: 409});
    inserted = true;
    return Response.json([JSON.parse(options!.body as string)]);
  };
  try {
    await importDatabaseFile(file);
    await assert.rejects(importDatabaseFile(file), /HTTP 409/);
  } finally { globalThis.fetch = original; rmSync(dir, {recursive: true}); }
});
