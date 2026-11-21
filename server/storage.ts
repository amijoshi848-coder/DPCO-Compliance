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

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'nppa_compliance_db.json');
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(process.cwd() + '_dpco_compliance_secret').digest('hex');

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

function buildInitialState(): DatabaseState {
  const nowIso = new Date().toISOString();
  return {
    users: [
      {
        id: 'usr-admin',
        loginId: 'admin',
        fullName: 'DPCO Administrator',
        department: 'Regulatory & Pricing Governance',
        role: 'admin',
        passwordHash: hashPassword('admin@123'),
        active: true,
        createdAt: nowIso,
      },
      {
        id: 'usr-reg-1',
        loginId: 'regulatory.lead',
        fullName: 'Priya Nair',
        department: 'Regulatory Affairs',
        role: 'user',
        passwordHash: hashPassword('nppa@2026'),
        active: true,
        createdAt: nowIso,
      },
    ],
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
}

let cachedState: DatabaseState | null = null;

export function loadDb(): DatabaseState {
  if (cachedState) return cachedState;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(raw) as DatabaseState;
      let mutated = false;
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
      }
      cachedState = parsed;
      if (mutated) saveDb(cachedState);
      return cachedState;
    } catch {
      // fall through to re-seed if file corrupted
    }
  }
  cachedState = buildInitialState();
  saveDb(cachedState);
  return cachedState;
}

export function saveDb(state: DatabaseState): void {
  cachedState = state;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}
