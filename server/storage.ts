import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AllowedUserRecord,
  AuthUser,
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  CompanyProfile,
  CustomCalendarEvent,
  Nlem2022Entry,
  NppaDocumentLog,
  RetailPriceEntry,
  SoTrackingRecord,
  SyncLogEntry,
} from '../src/types/compliance.ts';
import {
  INITIAL_CEILING_HISTORY,
  INITIAL_CEILING_PRICES,
  INITIAL_COMPANY_PROFILE,
  INITIAL_NLEM_2022,
  INITIAL_NPPA_LOGS,
  INITIAL_RETAIL_PRICES,
} from './nlem2022Data.ts';

export interface DatabaseState {
  users: AllowedUserRecord[];
  ceilingPrices: CeilingPriceEntry[];
  ceilingPriceHistory: CeilingPriceHistoryEntry[];
  retailPrices: RetailPriceEntry[];
  nppaLogs: NppaDocumentLog[];
  nlem2022: Nlem2022Entry[];
  companyProfile: CompanyProfile;
  syncLogs: SyncLogEntry[];
  customCalendarEvents: CustomCalendarEvent[];
  soTrackingRecords: SoTrackingRecord[];
  lastDailyRunDateIst: string | null;
}

export function getDataDir(): string {
  const configured = process.env.DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), 'data');
}

function getDbFilePath(): string {
  return path.join(getDataDir(), 'nppa_compliance_db.json');
}

const SESSION_SECRET =
  process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');

export function getEnvAdminCredentials(): { loginId: string; password: string } | null {
  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!password) return null;
  const loginId = process.env.ADMIN_LOGIN_ID?.trim() || 'admin';
  return { loginId, password };
}

export function hasActiveAdmin(db: DatabaseState): boolean {
  return db.users.some((u) => u.role === 'admin' && u.active);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function createSessionToken(user: AuthUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      loginId: user.loginId,
      role: user.role,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(
  token: string
): { id: string; loginId: string; role: 'admin' | 'user' } | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return { id: parsed.id, loginId: parsed.loginId, role: parsed.role };
  } catch {
    return null;
  }
}

export function toPublicUser(user: AllowedUserRecord): AuthUser {
  return {
    id: user.id,
    loginId: user.loginId,
    fullName: user.fullName,
    department: user.department,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function buildSeedSoTracking(
  ceilingPrices: CeilingPriceEntry[],
  retailPrices: RetailPriceEntry[]
): SoTrackingRecord[] {
  const buckets = new Map<string, SoTrackingRecord>();
  for (const cp of ceilingPrices) {
    const key = `${cp.notificationNumber}|${cp.notificationDate}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.ceilingCount += 1;
    } else {
      buckets.set(key, {
        id: `so-${cp.notificationNumber.replace(/[^a-zA-Z0-9]/g, '')}-${cp.notificationDate}`,
        soNumber: cp.notificationNumber,
        soDate: cp.notificationDate,
        sourceType: 'daily_nppa_sync',
        sourceUrl: cp.sourceUrl,
        ceilingCount: 1,
        retailCount: 0,
        importedBy: 'NPPA Registry Baseline',
        importedAt: cp.updatedAt,
        notes: `Scheduled formulation ceiling price notification (${cp.medicineName}).`,
      });
    }
  }
  for (const rp of retailPrices) {
    const key = `${rp.notificationNumber}|${rp.notificationDate}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.retailCount += 1;
    } else {
      buckets.set(key, {
        id: `so-${rp.notificationNumber.replace(/[^a-zA-Z0-9]/g, '')}-${rp.notificationDate}`,
        soNumber: rp.notificationNumber,
        soDate: rp.notificationDate,
        sourceType: 'daily_nppa_sync',
        sourceUrl: rp.sourceUrl,
        ceilingCount: 0,
        retailCount: 1,
        importedBy: 'NPPA Registry Baseline',
        importedAt: rp.createdAt,
        notes: `Form 1A retail price circular (${rp.formulation}).`,
      });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.soDate.localeCompare(a.soDate));
}

function ensureConfiguredAdmin(db: DatabaseState): boolean {
  let mutated = false;
  if (!Array.isArray(db.users)) {
    db.users = [];
    mutated = true;
  }

  const envAdmin = getEnvAdminCredentials();
  if (envAdmin) {
    const existing = db.users.find(
      (u) =>
        u.id === 'usr-admin' ||
        u.loginId.toLowerCase() === envAdmin.loginId.toLowerCase()
    );
    if (existing) {
      if (existing.loginId !== envAdmin.loginId) {
        existing.loginId = envAdmin.loginId;
        mutated = true;
      }
      if (existing.role !== 'admin') {
        existing.role = 'admin';
        mutated = true;
      }
      if (!existing.active) {
        existing.active = true;
        mutated = true;
      }
      if (!verifyPassword(envAdmin.password, existing.passwordHash)) {
        existing.passwordHash = hashPassword(envAdmin.password);
        mutated = true;
      }
    } else {
      db.users.unshift({
        id: 'usr-admin',
        loginId: envAdmin.loginId,
        fullName: 'DPCO Administrator',
        department: 'Regulatory & Pricing Governance',
        role: 'admin',
        passwordHash: hashPassword(envAdmin.password),
        active: true,
        createdAt: new Date().toISOString(),
      });
      mutated = true;
    }
  }

  return mutated;
}

function buildInitialState(): DatabaseState {
  const bundledPath = path.resolve(process.cwd(), 'data', 'nppa_compliance_db.json');
  if (fs.existsSync(bundledPath)) {
    try {
      const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf8')) as Partial<DatabaseState>;
      const seeded: DatabaseState = {
        users: [],
        ceilingPrices: Array.isArray(bundled.ceilingPrices)
          ? bundled.ceilingPrices
          : INITIAL_CEILING_PRICES,
        ceilingPriceHistory: Array.isArray(bundled.ceilingPriceHistory)
          ? bundled.ceilingPriceHistory
          : INITIAL_CEILING_HISTORY,
        retailPrices: Array.isArray(bundled.retailPrices)
          ? bundled.retailPrices
          : INITIAL_RETAIL_PRICES,
        nppaLogs: Array.isArray(bundled.nppaLogs) ? bundled.nppaLogs : INITIAL_NPPA_LOGS,
        nlem2022: Array.isArray(bundled.nlem2022) ? bundled.nlem2022 : INITIAL_NLEM_2022,
        companyProfile: bundled.companyProfile || INITIAL_COMPANY_PROFILE,
        syncLogs: Array.isArray(bundled.syncLogs) ? bundled.syncLogs : [],
        customCalendarEvents: Array.isArray(bundled.customCalendarEvents)
          ? bundled.customCalendarEvents
          : [],
        soTrackingRecords: Array.isArray(bundled.soTrackingRecords)
          ? bundled.soTrackingRecords
          : buildSeedSoTracking(INITIAL_CEILING_PRICES, INITIAL_RETAIL_PRICES),
        lastDailyRunDateIst: bundled.lastDailyRunDateIst || '2026-11-18',
      };
      ensureConfiguredAdmin(seeded);
      return seeded;
    } catch {
      // fall back to minimal initial state
    }
  }

  const state: DatabaseState = {
    users: [],
    ceilingPrices: INITIAL_CEILING_PRICES,
    ceilingPriceHistory: INITIAL_CEILING_HISTORY,
    retailPrices: INITIAL_RETAIL_PRICES,
    nppaLogs: INITIAL_NPPA_LOGS,
    nlem2022: INITIAL_NLEM_2022,
    companyProfile: INITIAL_COMPANY_PROFILE,
    syncLogs: [
      {
        id: 'sync-init-1',
        triggeredBy: 'scheduled_10am_ist',
        timestamp: '2026-11-18T10:00:00+05:30',
        status: 'success',
        circularsFetched: 3,
        authorityMinutesFetched: 2,
        expertNotesFetched: 2,
        newCeilingPricesFound: 1,
        newRetailPricesFound: 1,
        message: 'Baseline NPPA master & 10:00 AM IST scheduled registry initialized.',
      },
    ],
    customCalendarEvents: [],
    soTrackingRecords: buildSeedSoTracking(INITIAL_CEILING_PRICES, INITIAL_RETAIL_PRICES),
    lastDailyRunDateIst: '2026-11-18',
  };
  ensureConfiguredAdmin(state);
  return state;
}

let cachedState: DatabaseState | null = null;
let cachedDbPath: string | null = null;

export function loadDb(): DatabaseState {
  const dataDir = getDataDir();
  const dbPath = getDbFilePath();
  if (cachedState && cachedDbPath === dbPath) return cachedState;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (fs.existsSync(dbPath)) {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw) as DatabaseState;
      let mutated = false;
      if (ensureConfiguredAdmin(parsed)) {
        mutated = true;
      }
      if (!Array.isArray(parsed.ceilingPriceHistory)) {
        parsed.ceilingPriceHistory = INITIAL_CEILING_HISTORY;
        mutated = true;
      }
      if (!Array.isArray(parsed.customCalendarEvents)) {
        parsed.customCalendarEvents = [];
        mutated = true;
      }
      if (!Array.isArray(parsed.soTrackingRecords)) {
        parsed.soTrackingRecords = buildSeedSoTracking(
          parsed.ceilingPrices || [],
          parsed.retailPrices || []
        );
        mutated = true;
      }
      const existingNlemIds = new Set(parsed.nlem2022.map((n) => n.id));
      for (const seed of INITIAL_NLEM_2022) {
        if (!existingNlemIds.has(seed.id)) {
          parsed.nlem2022.push(seed);
          mutated = true;
        }
      }
      if (Array.isArray(parsed.nppaLogs)) {
        const cleanedLogs = parsed.nppaLogs.filter(
          (log) =>
            !(
              log.isLiveFetched &&
              (/^[\d.]+\s*(?:KB|MB|GB)\s*(?:\/|\s)+PDF/i.test(log.title.trim()) ||
                log.referenceNumber === 'f Non-Scheduled')
            )
        );
        if (cleanedLogs.length !== parsed.nppaLogs.length) {
          parsed.nppaLogs = cleanedLogs;
          mutated = true;
        }

        // Migrate legacy truncated base64 IDs (e.g. aHR0cHM6Ly9ucHBhLm) & deduplicate nppaLogs
        const byKey = new Map<string, NppaDocumentLog>();
        const seenLogIds = new Set<string>();
        for (const log of parsed.nppaLogs) {
          const dedupKey = (
            log.pdfUrl || `${log.sourceType}|${log.title}|${log.publishedDate}`
          ).toLowerCase();
          let nextId = log.id;
          if (
            !nextId ||
            nextId.includes('aHR0cHM') ||
            seenLogIds.has(nextId)
          ) {
            const hash = crypto
              .createHash('sha256')
              .update(dedupKey)
              .digest('base64url')
              .slice(0, 16);
            nextId = `live-${log.sourceType}-${hash}`;
            let disambig = 1;
            while (seenLogIds.has(nextId)) {
              nextId = `live-${log.sourceType}-${hash}-${disambig++}`;
            }
            mutated = true;
          }
          const prev = byKey.get(dedupKey);
          if (!prev) {
            seenLogIds.add(nextId);
            byKey.set(dedupKey, nextId === log.id ? log : { ...log, id: nextId });
          } else {
            // Duplicate log entry for the same URL/title+date: merge tracking metadata & drop duplicate
            if (log.soImportedAt && !prev.soImportedAt) {
              prev.soImportedAt = log.soImportedAt;
              prev.importedEntryCount = log.importedEntryCount;
            }
            mutated = true;
          }
        }
        const dedupedLogs = Array.from(byKey.values());
        if (dedupedLogs.length !== parsed.nppaLogs.length) {
          parsed.nppaLogs = dedupedLogs;
          mutated = true;
        } else if (mutated) {
          parsed.nppaLogs = dedupedLogs;
        }
      }

      // Guarantee unique IDs across all master collections loaded from disk
      for (const collection of [
        parsed.ceilingPrices,
        parsed.ceilingPriceHistory,
        parsed.retailPrices,
        parsed.soTrackingRecords,
        parsed.nlem2022,
        parsed.customCalendarEvents,
      ]) {
        if (!Array.isArray(collection)) continue;
        const seen = new Set<string>();
        for (let i = 0; i < collection.length; i++) {
          const item = collection[i] as { id?: string };
          if (!item || !item.id || seen.has(item.id)) {
            item.id = `${item.id || 'item'}-${i}`;
            mutated = true;
          }
          seen.add(item.id);
        }
      }

      cachedState = parsed;
      cachedDbPath = dbPath;
      if (mutated) saveDb(cachedState);
      return cachedState;
    } catch {
      // fall through to re-seed if file corrupted
    }
  }
  cachedState = buildInitialState();
  cachedDbPath = dbPath;
  saveDb(cachedState);
  return cachedState;
}

export function saveDb(state: DatabaseState): void {
  const dataDir = getDataDir();
  const dbPath = getDbFilePath();
  cachedState = state;
  cachedDbPath = dbPath;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}
