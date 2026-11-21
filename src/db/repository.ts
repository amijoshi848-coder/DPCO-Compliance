import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { desc, eq, or } from 'drizzle-orm';
import { db } from './index.ts';
import {
  appSettings,
  ceilingPriceHistory,
  ceilingPrices,
  companyProfiles,
  customCalendarEvents,
  nlem2022,
  nppaCeilingLogs,
  nppaMeetingMinutesLogs,
  nppaRetailLogs,
  retailPrices,
  soTrackingRecords,
  syncLogs,
  users,
} from './schema.ts';
import {
  INITIAL_CEILING_HISTORY,
  INITIAL_CEILING_PRICES,
  INITIAL_COMPANY_PROFILE,
  INITIAL_NLEM_2022,
  INITIAL_NPPA_LOGS,
  INITIAL_RETAIL_PRICES,
} from '../../server/nlem2022Data.ts';
import {
  getEnvAdminCredentials,
  hashPassword,
  verifyPassword,
  type DatabaseState,
} from '../../server/storage.ts';
import type {
  AuthUser,
  CalendarEventCategory,
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  CompanyProfile,
  CustomCalendarEvent,
  Nlem2022Entry,
  NppaDocumentLog,
  NppaLogCategory,
  NppaSourceType,
  RetailPriceEntry,
  SoTrackingRecord,
  SyncLogEntry,
  UserRole,
} from '../types/compliance.ts';

const COMPANY_PROFILE_ROW_ID = 'default-company';
const PG_SEED_KEY = 'pg_seeded_v1';
const LAST_DAILY_RUN_KEY = 'last_daily_run_date_ist';

export function classifyNppaNotification(
  title: string,
  sourceType: NppaSourceType,
  summary = '',
  explicitCategory?: NppaLogCategory
): NppaLogCategory {
  if (
    explicitCategory === 'ceiling_price' ||
    explicitCategory === 'retail_price' ||
    explicitCategory === 'meeting_minutes'
  ) {
    return explicitCategory;
  }
  if (sourceType === 'authority_minutes' || sourceType === 'expert_committee') {
    return 'meeting_minutes';
  }
  const combined = `${title} ${summary}`;
  if (/(?:authority\s*meeting|expert\s*committee|multidisciplinary\s*committee|minutes\s*of\s*the\s*\d+)/i.test(combined)) {
    return 'meeting_minutes';
  }
  if (
    /(?:retail\s*price|form\s*1a|form\s*ia|new\s*drug|proposed\s*retail\s*price)/i.test(combined) &&
    !/ceiling\s*price/i.test(combined)
  ) {
    return 'retail_price';
  }
  return 'ceiling_price';
}

export function computeFormulationKey(
  medicineName: string,
  strength: string,
  dosageFormat: string,
  unitLabel = ''
): string {
  const normMed = medicineName
    .toLowerCase()
    .replace(/\([a-z0-9]+\)/gi, '')
    .replace(/[^a-z0-9]+/g, '');
  const normStrength = strength.toLowerCase().replace(/[^a-z0-9.%+/]+/g, '');
  const normDosage = dosageFormat.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normUnit = unitLabel.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normMed === 'oralrehydrationsalts') {
    return `${normMed}|${normStrength}|${normDosage}|${normUnit}`;
  }
  return `${normMed}|${normStrength}|${normDosage}`;
}

function compareCeilingRecencyDesc(a: CeilingPriceEntry, b: CeilingPriceEntry): number {
  const effCmp = (b.effectiveDate || b.notificationDate || '').localeCompare(
    a.effectiveDate || a.notificationDate || ''
  );
  if (effCmp !== 0) return effCmp;
  const notifCmp = (b.notificationDate || '').localeCompare(a.notificationDate || '');
  if (notifCmp !== 0) return notifCmp;
  const updCmp = (b.updatedAt || '').localeCompare(a.updatedAt || '');
  if (updCmp !== 0) return updCmp;
  return b.id.localeCompare(a.id);
}

export function resolveLatestCeilingPrices(records: CeilingPriceEntry[]): {
  implementedPrices: CeilingPriceEntry[];
  allRecords: CeilingPriceEntry[];
  supersededCount: number;
} {
  const groups = new Map<string, CeilingPriceEntry[]>();
  for (const rec of records) {
    const key =
      rec.formulationKey ||
      computeFormulationKey(rec.medicineName, rec.strength, rec.dosageFormat, rec.unitLabel);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push({ ...rec, formulationKey: key });
    } else {
      groups.set(key, [{ ...rec, formulationKey: key }]);
    }
  }

  const implementedPrices: CeilingPriceEntry[] = [];
  for (const group of groups.values()) {
    group.sort(compareCeilingRecencyDesc);
    implementedPrices.push({
      ...group[0],
      supersededCount: Math.max(0, group.length - 1),
    });
  }

  implementedPrices.sort((a, b) => {
    const dtCmp = (b.effectiveDate || b.notificationDate).localeCompare(
      a.effectiveDate || a.notificationDate
    );
    if (dtCmp !== 0) return dtCmp;
    return a.medicineName.localeCompare(b.medicineName);
  });

  const allRecords = [...records]
    .map((r) => ({
      ...r,
      formulationKey:
        r.formulationKey ||
        computeFormulationKey(r.medicineName, r.strength, r.dosageFormat, r.unitLabel),
    }))
    .sort(compareCeilingRecencyDesc);

  return {
    implementedPrices,
    allRecords,
    supersededCount: Math.max(0, allRecords.length - implementedPrices.length),
  };
}

function makeLogDedupKey(doc: {
  pdfUrl?: string | null;
  sourceType: string;
  title: string;
  publishedDate: string;
}): string {
  return (doc.pdfUrl || `${doc.sourceType}|${doc.title}|${doc.publishedDate}`).toLowerCase();
}

function chunkArray<T>(items: T[], size = 150): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function mapUserRow(row: typeof users.$inferSelect): AuthUser {
  return {
    id: row.uid,
    loginId: row.loginId,
    fullName: row.fullName,
    department: row.department,
    role: row.role === 'admin' ? 'admin' : 'user',
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : undefined,
  };
}

function readBundledJsonSeed(): DatabaseState {
  const bundledPath = path.resolve(process.cwd(), 'data', 'nppa_compliance_db.json');
  if (fs.existsSync(bundledPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(bundledPath, 'utf8')) as Partial<DatabaseState>;
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        ceilingPrices: Array.isArray(parsed.ceilingPrices)
          ? parsed.ceilingPrices.filter((cp) => cp.id !== 'cp-10')
          : [],
        ceilingPriceHistory: Array.isArray(parsed.ceilingPriceHistory)
          ? parsed.ceilingPriceHistory.filter(
              (h) =>
                !['cph-1', 'cph-2', 'cph-3'].includes(h.id) &&
                h.notificationNumber !== 'S.O. 4950(E)'
            )
          : INITIAL_CEILING_HISTORY,
        retailPrices: Array.isArray(parsed.retailPrices)
          ? parsed.retailPrices.filter((rp) => !/^rp-[1-6]$/.test(rp.id))
          : INITIAL_RETAIL_PRICES,
        nppaLogs: Array.isArray(parsed.nppaLogs)
          ? parsed.nppaLogs.filter(
              (log) => Boolean(log.isLiveFetched) && log.id.startsWith('live-')
            )
          : INITIAL_NPPA_LOGS,
        nlem2022: Array.isArray(parsed.nlem2022) ? parsed.nlem2022 : INITIAL_NLEM_2022,
        companyProfile: parsed.companyProfile || INITIAL_COMPANY_PROFILE,
        syncLogs: Array.isArray(parsed.syncLogs)
          ? parsed.syncLogs.filter((s) => s.id !== 'sync-init-1')
          : [],
        customCalendarEvents: Array.isArray(parsed.customCalendarEvents)
          ? parsed.customCalendarEvents
          : [],
        soTrackingRecords: Array.isArray(parsed.soTrackingRecords)
          ? parsed.soTrackingRecords.filter(
              (s) => s.importedBy !== 'NPPA Registry Baseline'
            )
          : [],
        lastDailyRunDateIst: parsed.lastDailyRunDateIst || null,
      };
    } catch {
      // fallback below
    }
  }
  return {
    users: [],
    ceilingPrices: INITIAL_CEILING_PRICES,
    ceilingPriceHistory: INITIAL_CEILING_HISTORY,
    retailPrices: INITIAL_RETAIL_PRICES,
    nppaLogs: INITIAL_NPPA_LOGS,
    nlem2022: INITIAL_NLEM_2022,
    companyProfile: INITIAL_COMPANY_PROFILE,
    syncLogs: [],
    customCalendarEvents: [],
    soTrackingRecords: [],
    lastDailyRunDateIst: null,
  };
}

async function ensureEnvAdminInPg(): Promise<void> {
  const envAdmin = getEnvAdminCredentials();
  if (!envAdmin) return;
  const existing = await db
    .select()
    .from(users)
    .where(or(eq(users.uid, 'usr-admin'), eq(users.loginId, envAdmin.loginId)));

  if (existing.length > 0) {
    const target = existing[0];
    const needsUpdate =
      target.loginId !== envAdmin.loginId ||
      target.role !== 'admin' ||
      !target.active ||
      !verifyPassword(envAdmin.password, target.passwordHash);
    if (needsUpdate) {
      await db
        .update(users)
        .set({
          loginId: envAdmin.loginId,
          role: 'admin',
          active: true,
          passwordHash: verifyPassword(envAdmin.password, target.passwordHash)
            ? target.passwordHash
            : hashPassword(envAdmin.password),
        })
        .where(eq(users.id, target.id));
    }
    return;
  }

  await db
    .insert(users)
    .values({
      uid: 'usr-admin',
      loginId: envAdmin.loginId,
      email: envAdmin.loginId.includes('@') ? envAdmin.loginId : `${envAdmin.loginId}@dpco.local`,
      fullName: 'DPCO Administrator',
      department: 'Regulatory & Pricing Governance',
      role: 'admin',
      passwordHash: hashPassword(envAdmin.password),
      active: true,
    })
    .onConflictDoNothing();
}

let seedPromise: Promise<void> | null = null;

export async function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      try {
        const flagRows = await db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, PG_SEED_KEY));

        if (flagRows.length > 0) {
          await ensureEnvAdminInPg();
          return;
        }

        const seed = readBundledJsonSeed();
        const nowIso = new Date().toISOString();

        // 1. Seed 3 Separate NPPA Log Tables
        const ceilingLogRows: Array<typeof nppaCeilingLogs.$inferInsert> = [];
        const retailLogRows: Array<typeof nppaRetailLogs.$inferInsert> = [];
        const minuteLogRows: Array<typeof nppaMeetingMinutesLogs.$inferInsert> = [];
        const seenLogIds = new Set<string>();

        for (const rawLog of seed.nppaLogs) {
          let logId = rawLog.id || `doc-${crypto.randomBytes(6).toString('hex')}`;
          if (seenLogIds.has(logId)) {
            logId = `${logId}-${seenLogIds.size}`;
          }
          seenLogIds.add(logId);

          const category = classifyNppaNotification(
            rawLog.title,
            rawLog.sourceType,
            rawLog.summary,
            rawLog.logCategory
          );
          if (category === 'meeting_minutes') {
            minuteLogRows.push({
              id: logId,
              minuteType:
                rawLog.sourceType === 'expert_committee'
                  ? 'expert_committee'
                  : 'authority_minutes',
              title: rawLog.title,
              referenceNumber: rawLog.referenceNumber,
              publishedDate: rawLog.publishedDate,
              summary: rawLog.summary || '',
              url: rawLog.url,
              pdfUrl: rawLog.pdfUrl || null,
              fetchedAt: rawLog.fetchedAt || nowIso,
              isLiveFetched: Boolean(rawLog.isLiveFetched),
              soImportedAt: rawLog.soImportedAt || null,
              importedEntryCount: rawLog.importedEntryCount ?? null,
            });
          } else if (category === 'retail_price') {
            retailLogRows.push({
              id: logId,
              title: rawLog.title,
              referenceNumber: rawLog.referenceNumber,
              publishedDate: rawLog.publishedDate,
              summary: rawLog.summary || '',
              url: rawLog.url,
              pdfUrl: rawLog.pdfUrl || null,
              fetchedAt: rawLog.fetchedAt || nowIso,
              isLiveFetched: Boolean(rawLog.isLiveFetched),
              soImportedAt: rawLog.soImportedAt || null,
              importedEntryCount: rawLog.importedEntryCount ?? null,
            });
          } else {
            ceilingLogRows.push({
              id: logId,
              title: rawLog.title,
              referenceNumber: rawLog.referenceNumber,
              publishedDate: rawLog.publishedDate,
              summary: rawLog.summary || '',
              url: rawLog.url,
              pdfUrl: rawLog.pdfUrl || null,
              fetchedAt: rawLog.fetchedAt || nowIso,
              isLiveFetched: Boolean(rawLog.isLiveFetched),
              soImportedAt: rawLog.soImportedAt || null,
              importedEntryCount: rawLog.importedEntryCount ?? null,
            });
          }
        }

        for (const chunk of chunkArray(ceilingLogRows)) {
          await db.insert(nppaCeilingLogs).values(chunk).onConflictDoNothing();
        }
        for (const chunk of chunkArray(retailLogRows)) {
          await db.insert(nppaRetailLogs).values(chunk).onConflictDoNothing();
        }
        for (const chunk of chunkArray(minuteLogRows)) {
          await db.insert(nppaMeetingMinutesLogs).values(chunk).onConflictDoNothing();
        }

        // 2. Seed Ceiling Prices with formulationKey
        const cpRows: Array<typeof ceilingPrices.$inferInsert> = seed.ceilingPrices.map((cp) => ({
          id: cp.id,
          formulationKey:
            cp.formulationKey ||
            computeFormulationKey(cp.medicineName, cp.strength, cp.dosageFormat, cp.unitLabel),
          medicineName: cp.medicineName,
          composition: cp.composition,
          strength: cp.strength,
          dosageFormat: cp.dosageFormat,
          unitLabel: cp.unitLabel,
          ceilingPrice: Number(cp.ceilingPrice),
          notificationNumber: cp.notificationNumber,
          notificationDate: cp.notificationDate,
          effectiveDate: cp.effectiveDate || cp.notificationDate,
          nlemSection: cp.nlemSection || 'NLEM 2022',
          gstDefault: cp.gstDefault ?? 12,
          sourceUrl: cp.sourceUrl,
          updatedAt: cp.updatedAt || nowIso,
        }));
        for (const chunk of chunkArray(cpRows)) {
          await db.insert(ceilingPrices).values(chunk).onConflictDoNothing();
        }

        // 3. Seed Ceiling Price History
        const histRows: Array<typeof ceilingPriceHistory.$inferInsert> =
          seed.ceilingPriceHistory.map((h) => ({
            id: h.id,
            ceilingPriceId: h.ceilingPriceId,
            medicineName: h.medicineName,
            strength: h.strength,
            dosageFormat: h.dosageFormat,
            changeType: h.changeType,
            previousCeilingPrice: h.previousCeilingPrice,
            newCeilingPrice: h.newCeilingPrice,
            notificationNumber: h.notificationNumber,
            notificationDate: h.notificationDate,
            source: h.source,
            changedBy: h.changedBy,
            notes: h.notes,
            timestamp: h.timestamp,
          }));
        for (const chunk of chunkArray(histRows)) {
          await db.insert(ceilingPriceHistory).values(chunk).onConflictDoNothing();
        }

        // 4. Seed Retail Prices
        const rpRows: Array<typeof retailPrices.$inferInsert> = seed.retailPrices.map((rp) => ({
          id: rp.id,
          notificationNumber: rp.notificationNumber,
          notificationDate: rp.notificationDate,
          formulation: rp.formulation,
          composition: rp.composition,
          strength: rp.strength,
          dosageFormat: rp.dosageFormat,
          unitLabel: rp.unitLabel,
          retailPrice: Number(rp.retailPrice),
          applicantCompany: rp.applicantCompany,
          sourceUrl: rp.sourceUrl,
          createdAt: rp.createdAt || nowIso,
        }));
        for (const chunk of chunkArray(rpRows)) {
          await db.insert(retailPrices).values(chunk).onConflictDoNothing();
        }

        // 5. Seed NLEM 2022
        const nlemSeen = new Set(seed.nlem2022.map((n) => n.id));
        const mergedNlem = [...seed.nlem2022];
        for (const base of INITIAL_NLEM_2022) {
          if (!nlemSeen.has(base.id)) mergedNlem.push(base);
        }
        const nlemRows: Array<typeof nlem2022.$inferInsert> = mergedNlem.map((n) => ({
          id: n.id,
          medicineName: n.medicineName,
          aliases: n.aliases || [],
          therapeuticCategory: n.therapeuticCategory,
          sectionCode: n.sectionCode,
          dosageForms: n.dosageForms,
          notes: n.notes || null,
        }));
        for (const chunk of chunkArray(nlemRows)) {
          await db.insert(nlem2022).values(chunk).onConflictDoNothing();
        }

        // 6. Seed Company Profile
        const comp = seed.companyProfile || INITIAL_COMPANY_PROFILE;
        await db
          .insert(companyProfiles)
          .values({
            id: COMPANY_PROFILE_ROW_ID,
            companyName: comp.companyName,
            cin: comp.cin || '',
            gstin: comp.gstin || '',
            manufacturingLicenseNo: comp.manufacturingLicenseNo || '',
            corporateAddress: comp.corporateAddress || '',
            regulatoryOfficerName: comp.regulatoryOfficerName || '',
            regulatoryOfficerEmail: comp.regulatoryOfficerEmail || '',
            existingFormulations: comp.existingFormulations || [],
            updatedAt: comp.updatedAt || nowIso,
          })
          .onConflictDoNothing();

        // 7. Seed S.O. Tracking
        const soRows: Array<typeof soTrackingRecords.$inferInsert> = (
          seed.soTrackingRecords || []
        ).map((s) => ({
          id: s.id,
          soNumber: s.soNumber,
          soDate: s.soDate,
          sourceType: s.sourceType,
          sourceFileName: s.sourceFileName || null,
          sourceUrl: s.sourceUrl || null,
          ceilingCount: s.ceilingCount || 0,
          retailCount: s.retailCount || 0,
          importedBy: s.importedBy,
          importedAt: s.importedAt || nowIso,
          notes: s.notes || null,
        }));
        for (const chunk of chunkArray(soRows)) {
          await db.insert(soTrackingRecords).values(chunk).onConflictDoNothing();
        }

        // 8. Seed Sync Logs
        const sLogs: Array<typeof syncLogs.$inferInsert> = (seed.syncLogs || []).map((sl) => ({
          id: sl.id,
          triggeredBy: sl.triggeredBy,
          timestamp: sl.timestamp,
          status: sl.status,
          circularsFetched: sl.circularsFetched || 0,
          authorityMinutesFetched: sl.authorityMinutesFetched || 0,
          expertNotesFetched: sl.expertNotesFetched || 0,
          newCeilingPricesFound: sl.newCeilingPricesFound || 0,
          newRetailPricesFound: sl.newRetailPricesFound || 0,
          message: sl.message,
        }));
        for (const chunk of chunkArray(sLogs)) {
          await db.insert(syncLogs).values(chunk).onConflictDoNothing();
        }

        // 9. Seed Custom Calendar Events
        const calRows: Array<typeof customCalendarEvents.$inferInsert> = (
          seed.customCalendarEvents || []
        ).map((ev) => ({
          id: ev.id,
          title: ev.title,
          date: ev.date,
          category: ev.category,
          referenceNumber: ev.referenceNumber || '',
          notes: ev.notes || '',
          createdBy: ev.createdBy,
          createdAt: ev.createdAt || nowIso,
        }));
        for (const chunk of chunkArray(calRows)) {
          await db.insert(customCalendarEvents).values(chunk).onConflictDoNothing();
        }

        // 10. Seed App Settings + Users
        if (seed.lastDailyRunDateIst) {
          await db
            .insert(appSettings)
            .values({
              key: LAST_DAILY_RUN_KEY,
              value: seed.lastDailyRunDateIst,
              updatedAt: nowIso,
            })
            .onConflictDoNothing();
        }
        for (const u of seed.users || []) {
          await db
            .insert(users)
            .values({
              uid: u.id,
              loginId: u.loginId,
              email: u.loginId.includes('@') ? u.loginId : `${u.loginId}@dpco.local`,
              fullName: u.fullName,
              department: u.department,
              role: u.role,
              passwordHash: u.passwordHash,
              active: u.active,
            })
            .onConflictDoNothing();
        }
        await ensureEnvAdminInPg();

        await db
          .insert(appSettings)
          .values({
            key: PG_SEED_KEY,
            value: '1',
            updatedAt: nowIso,
          })
          .onConflictDoNothing();
      } catch (err) {
        seedPromise = null;
        throw new Error('Failed to initialize compliance PostgreSQL datastore.', { cause: err });
      }
    })();
  }
  await seedPromise;
}

// ============================================================================
// USERS & AUTH
// ============================================================================

export async function hasActiveAdminPg(): Promise<boolean> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(users);
    return rows.some((u) => u.role === 'admin' && u.active);
  } catch (err) {
    throw new Error('Failed to verify administrator configuration.', { cause: err });
  }
}

export async function findUserByUid(uid: string): Promise<AuthUser | null> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid));
    return rows[0] ? mapUserRow(rows[0]) : null;
  } catch (err) {
    throw new Error('Failed to retrieve user profile.', { cause: err });
  }
}

export async function findUserRecordByLoginId(
  loginId: string
): Promise<(AuthUser & { passwordHash: string }) | null> {
  await ensureSeeded();
  try {
    const clean = loginId.trim().toLowerCase();
    const rows = await db.select().from(users);
    const match = rows.find(
      (u) => u.loginId.toLowerCase() === clean || u.email.toLowerCase() === clean
    );
    if (!match) return null;
    return {
      ...mapUserRow(match),
      passwordHash: match.passwordHash,
    };
  } catch (err) {
    throw new Error('Failed to look up user credentials.', { cause: err });
  }
}

export async function touchUserLastLogin(uid: string): Promise<void> {
  await ensureSeeded();
  try {
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.uid, uid));
  } catch (err) {
    throw new Error('Failed to update last login timestamp.', { cause: err });
  }
}

export async function getOrCreateFirebaseUser(params: {
  uid: string;
  email: string;
  displayName?: string;
}): Promise<AuthUser> {
  await ensureSeeded();
  try {
    const cleanEmail = params.email.trim().toLowerCase();
    const existingByUid = await db.select().from(users).where(eq(users.uid, params.uid));
    if (existingByUid[0]) {
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, existingByUid[0].id));
      return mapUserRow({ ...existingByUid[0], lastLoginAt: new Date() });
    }

    const allUsers = await db.select().from(users);
    const matchedByEmail = cleanEmail
      ? allUsers.find(
          (u) => u.email.toLowerCase() === cleanEmail || u.loginId.toLowerCase() === cleanEmail
        )
      : undefined;

    if (matchedByEmail) {
      const updated = await db
        .update(users)
        .set({
          uid: params.uid,
          email: cleanEmail || matchedByEmail.email,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, matchedByEmail.id))
        .returning();
      return mapUserRow(updated[0]);
    }

    const configuredAdminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const hasAdminAlready = allUsers.some((u) => u.role === 'admin' && u.active);
    const shouldBeAdmin =
      !hasAdminAlready ||
      (Boolean(configuredAdminEmail) && cleanEmail === configuredAdminEmail);

    const loginHandle = cleanEmail || params.uid;
    const inserted = await db
      .insert(users)
      .values({
        uid: params.uid,
        loginId: loginHandle,
        email: cleanEmail || `${params.uid}@firebase.local`,
        fullName: (params.displayName || cleanEmail.split('@')[0] || 'Authorized User').trim(),
        department: shouldBeAdmin ? 'Regulatory & Pricing Governance' : 'Regulatory Affairs',
        role: shouldBeAdmin ? 'admin' : 'user',
        passwordHash: '',
        active: true,
        lastLoginAt: new Date(),
      })
      .returning();
    return mapUserRow(inserted[0]);
  } catch (err) {
    throw new Error('Failed to synchronize authenticated user account.', { cause: err });
  }
}

export async function listAllUsers(): Promise<AuthUser[]> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(users);
    return rows.map(mapUserRow);
  } catch (err) {
    throw new Error('Failed to list authorized users.', { cause: err });
  }
}

export async function createProvisionedUser(params: {
  uid?: string;
  loginId: string;
  email?: string;
  fullName: string;
  department: string;
  role: UserRole;
  password: string;
}): Promise<AuthUser> {
  await ensureSeeded();
  try {
    const cleanLogin = params.loginId.trim();
    const rows = await db.select().from(users);
    if (rows.some((u) => u.loginId.toLowerCase() === cleanLogin.toLowerCase())) {
      const conflict = new Error('This Login ID is already registered.');
      (conflict as Error & { statusCode?: number }).statusCode = 409;
      throw conflict;
    }
    const uid = params.uid || `usr-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const inserted = await db
      .insert(users)
      .values({
        uid,
        loginId: cleanLogin,
        email:
          params.email?.trim() ||
          (cleanLogin.includes('@') ? cleanLogin : `${cleanLogin}@dpco.local`),
        fullName: params.fullName.trim(),
        department: (params.department || 'Regulatory Affairs').trim(),
        role: params.role === 'admin' ? 'admin' : 'user',
        passwordHash: hashPassword(params.password),
        active: true,
      })
      .returning();
    return mapUserRow(inserted[0]);
  } catch (err) {
    if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 409) {
      throw err;
    }
    throw new Error('Failed to create user account.', { cause: err });
  }
}

export async function updateProvisionedUser(
  uid: string,
  patch: {
    fullName?: string;
    department?: string;
    role?: UserRole;
    active?: boolean;
    password?: string;
  }
): Promise<AuthUser | null> {
  await ensureSeeded();
  try {
    const existing = await db.select().from(users).where(eq(users.uid, uid));
    if (!existing[0]) return null;
    const updates: Partial<typeof users.$inferInsert> = {};
    if (patch.fullName !== undefined) updates.fullName = patch.fullName.trim();
    if (patch.department !== undefined) updates.department = patch.department.trim();
    if (patch.role !== undefined) updates.role = patch.role === 'admin' ? 'admin' : 'user';
    if (patch.active !== undefined) updates.active = Boolean(patch.active);
    if (patch.password && patch.password.trim()) {
      updates.passwordHash = hashPassword(patch.password.trim());
    }
    const updated = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, existing[0].id))
      .returning();
    return mapUserRow(updated[0]);
  } catch (err) {
    throw new Error('Failed to update user account.', { cause: err });
  }
}

export async function deleteProvisionedUser(uid: string): Promise<boolean> {
  await ensureSeeded();
  try {
    const deleted = await db.delete(users).where(eq(users.uid, uid)).returning();
    return deleted.length > 0;
  } catch (err) {
    throw new Error('Failed to delete user account.', { cause: err });
  }
}

// ============================================================================
// 3 SEPARATE NPPA LOGS (CEILING PRICE, RETAIL PRICE, MEETING MINUTES)
// ============================================================================

export async function getAllNppaLogsGrouped(): Promise<{
  ceilingLogs: NppaDocumentLog[];
  retailLogs: NppaDocumentLog[];
  meetingMinutesLogs: NppaDocumentLog[];
  allLogs: NppaDocumentLog[];
}> {
  await ensureSeeded();
  try {
    const [cRows, rRows, mRows] = await Promise.all([
      db.select().from(nppaCeilingLogs).orderBy(desc(nppaCeilingLogs.publishedDate)),
      db.select().from(nppaRetailLogs).orderBy(desc(nppaRetailLogs.publishedDate)),
      db.select().from(nppaMeetingMinutesLogs).orderBy(desc(nppaMeetingMinutesLogs.publishedDate)),
    ]);

    const ceilingLogs: NppaDocumentLog[] = cRows.map((row) => ({
      id: row.id,
      sourceType: 'circular',
      logCategory: 'ceiling_price',
      title: row.title,
      referenceNumber: row.referenceNumber,
      publishedDate: row.publishedDate,
      summary: row.summary,
      url: row.url,
      pdfUrl: row.pdfUrl || undefined,
      fetchedAt: row.fetchedAt,
      isLiveFetched: row.isLiveFetched,
      soImportedAt: row.soImportedAt || undefined,
      importedEntryCount: row.importedEntryCount ?? undefined,
    }));

    const retailLogs: NppaDocumentLog[] = rRows.map((row) => ({
      id: row.id,
      sourceType: 'circular',
      logCategory: 'retail_price',
      title: row.title,
      referenceNumber: row.referenceNumber,
      publishedDate: row.publishedDate,
      summary: row.summary,
      url: row.url,
      pdfUrl: row.pdfUrl || undefined,
      fetchedAt: row.fetchedAt,
      isLiveFetched: row.isLiveFetched,
      soImportedAt: row.soImportedAt || undefined,
      importedEntryCount: row.importedEntryCount ?? undefined,
    }));

    const meetingMinutesLogs: NppaDocumentLog[] = mRows.map((row) => ({
      id: row.id,
      sourceType:
        row.minuteType === 'expert_committee' ? 'expert_committee' : 'authority_minutes',
      logCategory: 'meeting_minutes',
      title: row.title,
      referenceNumber: row.referenceNumber,
      publishedDate: row.publishedDate,
      summary: row.summary,
      url: row.url,
      pdfUrl: row.pdfUrl || undefined,
      fetchedAt: row.fetchedAt,
      isLiveFetched: row.isLiveFetched,
      soImportedAt: row.soImportedAt || undefined,
      importedEntryCount: row.importedEntryCount ?? undefined,
    }));

    const allLogs = [...ceilingLogs, ...retailLogs, ...meetingMinutesLogs].sort((a, b) =>
      b.publishedDate.localeCompare(a.publishedDate)
    );

    return { ceilingLogs, retailLogs, meetingMinutesLogs, allLogs };
  } catch (err) {
    throw new Error('Failed to load classified NPPA notification logs.', { cause: err });
  }
}

export async function upsertNppaLogs(
  docs: NppaDocumentLog[]
): Promise<{ newlyAdded: number; newlyAddedDocs: NppaDocumentLog[] }> {
  await ensureSeeded();
  try {
    const existing = await getAllNppaLogsGrouped();
    const existingKeys = new Set<string>();
    const existingIds = new Set<string>();
    for (const item of existing.allLogs) {
      existingIds.add(item.id);
      existingKeys.add(makeLogDedupKey(item));
    }

    const newCeiling: Array<typeof nppaCeilingLogs.$inferInsert> = [];
    const newRetail: Array<typeof nppaRetailLogs.$inferInsert> = [];
    const newMinutes: Array<typeof nppaMeetingMinutesLogs.$inferInsert> = [];
    const newlyAddedDocs: NppaDocumentLog[] = [];

    for (const doc of docs) {
      const dedupKey = makeLogDedupKey(doc);
      if (existingKeys.has(dedupKey) || existingIds.has(doc.id)) {
        continue;
      }
      existingKeys.add(dedupKey);
      existingIds.add(doc.id);

      const category = classifyNppaNotification(
        doc.title,
        doc.sourceType,
        doc.summary,
        doc.logCategory
      );
      const categorizedDoc: NppaDocumentLog = { ...doc, logCategory: category };
      newlyAddedDocs.push(categorizedDoc);

      if (category === 'meeting_minutes') {
        newMinutes.push({
          id: doc.id,
          minuteType:
            doc.sourceType === 'expert_committee' ? 'expert_committee' : 'authority_minutes',
          title: doc.title,
          referenceNumber: doc.referenceNumber,
          publishedDate: doc.publishedDate,
          summary: doc.summary || '',
          url: doc.url,
          pdfUrl: doc.pdfUrl || null,
          fetchedAt: doc.fetchedAt,
          isLiveFetched: doc.isLiveFetched,
          soImportedAt: doc.soImportedAt || null,
          importedEntryCount: doc.importedEntryCount ?? null,
        });
      } else if (category === 'retail_price') {
        newRetail.push({
          id: doc.id,
          title: doc.title,
          referenceNumber: doc.referenceNumber,
          publishedDate: doc.publishedDate,
          summary: doc.summary || '',
          url: doc.url,
          pdfUrl: doc.pdfUrl || null,
          fetchedAt: doc.fetchedAt,
          isLiveFetched: doc.isLiveFetched,
          soImportedAt: doc.soImportedAt || null,
          importedEntryCount: doc.importedEntryCount ?? null,
        });
      } else {
        newCeiling.push({
          id: doc.id,
          title: doc.title,
          referenceNumber: doc.referenceNumber,
          publishedDate: doc.publishedDate,
          summary: doc.summary || '',
          url: doc.url,
          pdfUrl: doc.pdfUrl || null,
          fetchedAt: doc.fetchedAt,
          isLiveFetched: doc.isLiveFetched,
          soImportedAt: doc.soImportedAt || null,
          importedEntryCount: doc.importedEntryCount ?? null,
        });
      }
    }

    for (const chunk of chunkArray(newCeiling)) {
      await db.insert(nppaCeilingLogs).values(chunk).onConflictDoNothing();
    }
    for (const chunk of chunkArray(newRetail)) {
      await db.insert(nppaRetailLogs).values(chunk).onConflictDoNothing();
    }
    for (const chunk of chunkArray(newMinutes)) {
      await db.insert(nppaMeetingMinutesLogs).values(chunk).onConflictDoNothing();
    }

    return { newlyAdded: newlyAddedDocs.length, newlyAddedDocs };
  } catch (err) {
    throw new Error('Failed to store NPPA notification logs.', { cause: err });
  }
}

export async function findNppaLogById(id: string): Promise<NppaDocumentLog | null> {
  await ensureSeeded();
  try {
    const [c, r, m] = await Promise.all([
      db.select().from(nppaCeilingLogs).where(eq(nppaCeilingLogs.id, id)),
      db.select().from(nppaRetailLogs).where(eq(nppaRetailLogs.id, id)),
      db.select().from(nppaMeetingMinutesLogs).where(eq(nppaMeetingMinutesLogs.id, id)),
    ]);
    if (c[0]) {
      const row = c[0];
      return {
        id: row.id,
        sourceType: 'circular',
        logCategory: 'ceiling_price',
        title: row.title,
        referenceNumber: row.referenceNumber,
        publishedDate: row.publishedDate,
        summary: row.summary,
        url: row.url,
        pdfUrl: row.pdfUrl || undefined,
        fetchedAt: row.fetchedAt,
        isLiveFetched: row.isLiveFetched,
        soImportedAt: row.soImportedAt || undefined,
        importedEntryCount: row.importedEntryCount ?? undefined,
      };
    }
    if (r[0]) {
      const row = r[0];
      return {
        id: row.id,
        sourceType: 'circular',
        logCategory: 'retail_price',
        title: row.title,
        referenceNumber: row.referenceNumber,
        publishedDate: row.publishedDate,
        summary: row.summary,
        url: row.url,
        pdfUrl: row.pdfUrl || undefined,
        fetchedAt: row.fetchedAt,
        isLiveFetched: row.isLiveFetched,
        soImportedAt: row.soImportedAt || undefined,
        importedEntryCount: row.importedEntryCount ?? undefined,
      };
    }
    if (m[0]) {
      const row = m[0];
      return {
        id: row.id,
        sourceType:
          row.minuteType === 'expert_committee' ? 'expert_committee' : 'authority_minutes',
        logCategory: 'meeting_minutes',
        title: row.title,
        referenceNumber: row.referenceNumber,
        publishedDate: row.publishedDate,
        summary: row.summary,
        url: row.url,
        pdfUrl: row.pdfUrl || undefined,
        fetchedAt: row.fetchedAt,
        isLiveFetched: row.isLiveFetched,
        soImportedAt: row.soImportedAt || undefined,
        importedEntryCount: row.importedEntryCount ?? undefined,
      };
    }
    return null;
  } catch (err) {
    throw new Error('Failed to retrieve NPPA log record.', { cause: err });
  }
}

export async function updateNppaLogMetadata(
  id: string,
  patch: {
    pdfUrl?: string;
    soImportedAt?: string;
    incrementEntryCount?: number;
    referenceNumber?: string;
  }
): Promise<void> {
  await ensureSeeded();
  try {
    const existing = await findNppaLogById(id);
    if (!existing) return;

    const updates: {
      pdfUrl?: string;
      soImportedAt?: string;
      importedEntryCount?: number;
      referenceNumber?: string;
    } = {};
    if (patch.pdfUrl !== undefined) updates.pdfUrl = patch.pdfUrl;
    if (patch.soImportedAt !== undefined) updates.soImportedAt = patch.soImportedAt;
    if (patch.incrementEntryCount !== undefined) {
      updates.importedEntryCount = (existing.importedEntryCount || 0) + patch.incrementEntryCount;
    }
    if (patch.referenceNumber !== undefined) updates.referenceNumber = patch.referenceNumber;

    if (existing.logCategory === 'meeting_minutes') {
      await db
        .update(nppaMeetingMinutesLogs)
        .set(updates)
        .where(eq(nppaMeetingMinutesLogs.id, id));
    } else if (existing.logCategory === 'retail_price') {
      await db.update(nppaRetailLogs).set(updates).where(eq(nppaRetailLogs.id, id));
    } else {
      await db.update(nppaCeilingLogs).set(updates).where(eq(nppaCeilingLogs.id, id));
    }
  } catch (err) {
    throw new Error('Failed to update NPPA log metadata.', { cause: err });
  }
}

export async function deleteNppaLogById(id: string): Promise<boolean> {
  await ensureSeeded();
  try {
    const [d1, d2, d3] = await Promise.all([
      db.delete(nppaCeilingLogs).where(eq(nppaCeilingLogs.id, id)).returning(),
      db.delete(nppaRetailLogs).where(eq(nppaRetailLogs.id, id)).returning(),
      db.delete(nppaMeetingMinutesLogs).where(eq(nppaMeetingMinutesLogs.id, id)).returning(),
    ]);
    return d1.length + d2.length + d3.length > 0;
  } catch (err) {
    throw new Error('Failed to delete NPPA log record.', { cause: err });
  }
}

// ============================================================================
// CEILING PRICES (ALL HISTORICAL VERSIONS STORED · LATEST RESOLVED AS IMPLEMENTED)
// ============================================================================

function mapCeilingPriceRow(row: typeof ceilingPrices.$inferSelect): CeilingPriceEntry {
  return {
    id: row.id,
    formulationKey: row.formulationKey,
    medicineName: row.medicineName,
    composition: row.composition,
    strength: row.strength,
    dosageFormat: row.dosageFormat,
    unitLabel: row.unitLabel,
    ceilingPrice: row.ceilingPrice,
    notificationNumber: row.notificationNumber,
    notificationDate: row.notificationDate,
    effectiveDate: row.effectiveDate,
    nlemSection: row.nlemSection,
    gstDefault: row.gstDefault,
    sourceUrl: row.sourceUrl,
    updatedAt: row.updatedAt,
  };
}

function mapHistoryRow(row: typeof ceilingPriceHistory.$inferSelect): CeilingPriceHistoryEntry {
  return {
    id: row.id,
    ceilingPriceId: row.ceilingPriceId,
    medicineName: row.medicineName,
    strength: row.strength,
    dosageFormat: row.dosageFormat,
    changeType:
      row.changeType === 'revised' || row.changeType === 'deleted' ? row.changeType : 'created',
    previousCeilingPrice: row.previousCeilingPrice,
    newCeilingPrice: row.newCeilingPrice,
    notificationNumber: row.notificationNumber,
    notificationDate: row.notificationDate,
    source:
      row.source === 'scheduled_10am_ist' ||
      row.source === 'manual_sync' ||
      row.source === 'notification_parser'
        ? row.source
        : 'admin_edit',
    changedBy: row.changedBy,
    notes: row.notes,
    timestamp: row.timestamp,
  };
}

export async function getCeilingPricesMaster(): Promise<{
  items: CeilingPriceEntry[];
  allRecords: CeilingPriceEntry[];
  supersededCount: number;
  history: CeilingPriceHistoryEntry[];
}> {
  await ensureSeeded();
  try {
    const [rows, histRows] = await Promise.all([
      db.select().from(ceilingPrices),
      db
        .select()
        .from(ceilingPriceHistory)
        .orderBy(desc(ceilingPriceHistory.timestamp))
        .limit(150),
    ]);
    const mapped = rows.map(mapCeilingPriceRow);
    const resolved = resolveLatestCeilingPrices(mapped);
    return {
      items: resolved.implementedPrices,
      allRecords: resolved.allRecords,
      supersededCount: resolved.supersededCount,
      history: histRows.map(mapHistoryRow),
    };
  } catch (err) {
    throw new Error('Failed to load ceiling price master records.', { cause: err });
  }
}

export async function recordCeilingPriceNotification(params: {
  entry: Omit<CeilingPriceEntry, 'id' | 'formulationKey' | 'supersededCount'>;
  source: CeilingPriceHistoryEntry['source'];
  changedBy: string;
  notes?: string;
}): Promise<{
  action: 'created' | 'revised';
  item: CeilingPriceEntry;
  previousPrice: number | null;
  isLatestImplemented: boolean;
}> {
  await ensureSeeded();
  try {
    const fKey = computeFormulationKey(
      params.entry.medicineName,
      params.entry.strength,
      params.entry.dosageFormat,
      params.entry.unitLabel
    );
    const existingForFormulation = (
      await db.select().from(ceilingPrices).where(eq(ceilingPrices.formulationKey, fKey))
    ).map(mapCeilingPriceRow);

    existingForFormulation.sort(compareCeilingRecencyDesc);
    const latestExisting = existingForFormulation[0] || null;
    const prevPrice = latestExisting ? latestExisting.ceilingPrice : null;

    const exactNotifMatch = existingForFormulation.find(
      (r) =>
        r.notificationNumber.toLowerCase() === params.entry.notificationNumber.toLowerCase() &&
        r.notificationDate === params.entry.notificationDate
    );

    const nowIso = params.entry.updatedAt || new Date().toISOString();
    let savedItem: CeilingPriceEntry;
    let action: 'created' | 'revised';

    if (exactNotifMatch) {
      const updatedRows = await db
        .update(ceilingPrices)
        .set({
          medicineName: params.entry.medicineName,
          composition: params.entry.composition,
          strength: params.entry.strength,
          dosageFormat: params.entry.dosageFormat,
          unitLabel: params.entry.unitLabel,
          ceilingPrice: Number(params.entry.ceilingPrice),
          effectiveDate: params.entry.effectiveDate || params.entry.notificationDate,
          nlemSection: params.entry.nlemSection || 'NLEM 2022',
          gstDefault: params.entry.gstDefault ?? 12,
          sourceUrl: params.entry.sourceUrl,
          updatedAt: nowIso,
        })
        .where(eq(ceilingPrices.id, exactNotifMatch.id))
        .returning();
      savedItem = mapCeilingPriceRow(updatedRows[0]);
      action = 'revised';
    } else {
      const hash = crypto
        .createHash('sha1')
        .update(
          `${fKey}|${params.entry.notificationNumber}|${params.entry.notificationDate}|${nowIso}`
        )
        .digest('hex')
        .slice(0, 10);
      const newId = `cp-${hash}`;
      const insertedRows = await db
        .insert(ceilingPrices)
        .values({
          id: newId,
          formulationKey: fKey,
          medicineName: params.entry.medicineName,
          composition: params.entry.composition,
          strength: params.entry.strength,
          dosageFormat: params.entry.dosageFormat,
          unitLabel: params.entry.unitLabel,
          ceilingPrice: Number(params.entry.ceilingPrice),
          notificationNumber: params.entry.notificationNumber,
          notificationDate: params.entry.notificationDate,
          effectiveDate: params.entry.effectiveDate || params.entry.notificationDate,
          nlemSection: params.entry.nlemSection || 'NLEM 2022',
          gstDefault: params.entry.gstDefault ?? 12,
          sourceUrl: params.entry.sourceUrl,
          updatedAt: nowIso,
        })
        .returning();
      savedItem = mapCeilingPriceRow(insertedRows[0]);
      action = latestExisting ? 'revised' : 'created';
    }

    // Re-check which record is now latest implemented for this formulationKey
    const afterGroup = (
      await db.select().from(ceilingPrices).where(eq(ceilingPrices.formulationKey, fKey))
    )
      .map(mapCeilingPriceRow)
      .sort(compareCeilingRecencyDesc);
    const isLatestImplemented = afterGroup[0]?.id === savedItem.id;

    await db.insert(ceilingPriceHistory).values({
      id: `cph-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      ceilingPriceId: savedItem.id,
      medicineName: savedItem.medicineName,
      strength: savedItem.strength,
      dosageFormat: savedItem.dosageFormat,
      changeType: action,
      previousCeilingPrice: prevPrice,
      newCeilingPrice: savedItem.ceilingPrice,
      notificationNumber: savedItem.notificationNumber,
      notificationDate: savedItem.notificationDate,
      source: params.source,
      changedBy: params.changedBy,
      notes:
        params.notes ||
        (prevPrice != null
          ? `Recorded ${savedItem.notificationNumber} (${savedItem.notificationDate}): ₹${savedItem.ceilingPrice.toFixed(2)} (prior ₹${prevPrice.toFixed(2)})${isLatestImplemented ? ' — Active to implement.' : ' — Historical record stored.'}`
          : `Added ceiling price ₹${savedItem.ceilingPrice.toFixed(2)} (${savedItem.notificationNumber}).`),
      timestamp: nowIso,
    });

    return {
      action,
      item: savedItem,
      previousPrice: prevPrice,
      isLatestImplemented,
    };
  } catch (err) {
    throw new Error('Failed to save ceiling price notification record.', { cause: err });
  }
}

export async function updateCeilingPriceRecord(
  id: string,
  patch: Partial<CeilingPriceEntry>,
  changedBy: string
): Promise<CeilingPriceEntry | null> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(ceilingPrices).where(eq(ceilingPrices.id, id));
    if (!rows[0]) return null;
    const prev = mapCeilingPriceRow(rows[0]);
    const nowIso = new Date().toISOString();

    const nextMedicineName = (patch.medicineName ?? prev.medicineName).trim();
    const nextStrength = (patch.strength ?? prev.strength).trim();
    const nextDosageFormat = (patch.dosageFormat ?? prev.dosageFormat).trim();
    const nextUnitLabel = (patch.unitLabel ?? prev.unitLabel).trim();
    const nextNotifDate = (patch.notificationDate ?? prev.notificationDate).trim();
    const nextEffDate = (patch.effectiveDate ?? patch.notificationDate ?? prev.effectiveDate).trim();
    const nextPrice =
      patch.ceilingPrice != null ? Number(patch.ceilingPrice) : prev.ceilingPrice;

    const updated = await db
      .update(ceilingPrices)
      .set({
        formulationKey: computeFormulationKey(
          nextMedicineName,
          nextStrength,
          nextDosageFormat,
          nextUnitLabel
        ),
        medicineName: nextMedicineName,
        composition: (patch.composition ?? prev.composition).trim(),
        strength: nextStrength,
        dosageFormat: nextDosageFormat,
        unitLabel: nextUnitLabel,
        ceilingPrice: nextPrice,
        notificationNumber: (patch.notificationNumber ?? prev.notificationNumber).trim(),
        notificationDate: nextNotifDate,
        effectiveDate: nextEffDate,
        nlemSection: (patch.nlemSection ?? prev.nlemSection).trim(),
        gstDefault: patch.gstDefault != null ? Number(patch.gstDefault) : prev.gstDefault,
        sourceUrl: patch.sourceUrl ?? prev.sourceUrl,
        updatedAt: nowIso,
      })
      .where(eq(ceilingPrices.id, id))
      .returning();

    const item = mapCeilingPriceRow(updated[0]);
    await db.insert(ceilingPriceHistory).values({
      id: `cph-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      ceilingPriceId: item.id,
      medicineName: item.medicineName,
      strength: item.strength,
      dosageFormat: item.dosageFormat,
      changeType: 'revised',
      previousCeilingPrice: prev.ceilingPrice,
      newCeilingPrice: item.ceilingPrice,
      notificationNumber: item.notificationNumber,
      notificationDate: item.notificationDate,
      source: 'admin_edit',
      changedBy,
      notes: `Updated ceiling price from ₹${prev.ceilingPrice.toFixed(2)} to ₹${item.ceilingPrice.toFixed(2)}.`,
      timestamp: nowIso,
    });

    return item;
  } catch (err) {
    throw new Error('Failed to update ceiling price record.', { cause: err });
  }
}

export async function deleteCeilingPriceRecord(
  id: string,
  changedBy: string
): Promise<boolean> {
  await ensureSeeded();
  try {
    const deleted = await db.delete(ceilingPrices).where(eq(ceilingPrices.id, id)).returning();
    if (!deleted[0]) return false;
    const target = mapCeilingPriceRow(deleted[0]);
    await db.insert(ceilingPriceHistory).values({
      id: `cph-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      ceilingPriceId: target.id,
      medicineName: target.medicineName,
      strength: target.strength,
      dosageFormat: target.dosageFormat,
      changeType: 'deleted',
      previousCeilingPrice: target.ceilingPrice,
      newCeilingPrice: null,
      notificationNumber: target.notificationNumber,
      notificationDate: target.notificationDate,
      source: 'admin_edit',
      changedBy,
      notes: `Removed ceiling price record (was ₹${target.ceilingPrice.toFixed(2)}).`,
      timestamp: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    throw new Error('Failed to delete ceiling price record.', { cause: err });
  }
}

// ============================================================================
// RETAIL PRICES (POST-16 JULY 2026 · FORM 1A)
// ============================================================================

function mapRetailPriceRow(row: typeof retailPrices.$inferSelect): RetailPriceEntry {
  return {
    id: row.id,
    notificationNumber: row.notificationNumber,
    notificationDate: row.notificationDate,
    formulation: row.formulation,
    composition: row.composition,
    strength: row.strength,
    dosageFormat: row.dosageFormat,
    unitLabel: row.unitLabel,
    retailPrice: row.retailPrice,
    applicantCompany: row.applicantCompany,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt,
  };
}

export async function listRetailPrices(): Promise<RetailPriceEntry[]> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(retailPrices)
      .orderBy(desc(retailPrices.notificationDate));
    return rows.map(mapRetailPriceRow);
  } catch (err) {
    throw new Error('Failed to load retail price records.', { cause: err });
  }
}

export async function createRetailPriceIfUnique(
  entry: Omit<RetailPriceEntry, 'id'> & { id?: string }
): Promise<{ created: boolean; item: RetailPriceEntry | null }> {
  await ensureSeeded();
  try {
    const existing = await db.select().from(retailPrices);
    const dup = existing.some(
      (r) =>
        r.notificationNumber.toLowerCase() === entry.notificationNumber.toLowerCase() &&
        (r.formulation.toLowerCase() === entry.formulation.toLowerCase() ||
          r.formulation.toLowerCase().includes(entry.formulation.toLowerCase()))
    );
    if (dup) {
      return { created: false, item: null };
    }
    const id = entry.id || `rp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const inserted = await db
      .insert(retailPrices)
      .values({
        id,
        notificationNumber: entry.notificationNumber,
        notificationDate: entry.notificationDate,
        formulation: entry.formulation,
        composition: entry.composition,
        strength: entry.strength,
        dosageFormat: entry.dosageFormat,
        unitLabel: entry.unitLabel,
        retailPrice: Number(entry.retailPrice),
        applicantCompany: entry.applicantCompany,
        sourceUrl: entry.sourceUrl,
        createdAt: entry.createdAt || new Date().toISOString(),
      })
      .returning();
    return { created: true, item: mapRetailPriceRow(inserted[0]) };
  } catch (err) {
    throw new Error('Failed to save retail price record.', { cause: err });
  }
}

export async function updateRetailPriceRecord(
  id: string,
  patch: Partial<RetailPriceEntry>
): Promise<RetailPriceEntry | null> {
  await ensureSeeded();
  try {
    const existing = await db.select().from(retailPrices).where(eq(retailPrices.id, id));
    if (!existing[0]) return null;
    const prev = mapRetailPriceRow(existing[0]);
    const updated = await db
      .update(retailPrices)
      .set({
        notificationNumber: patch.notificationNumber ?? prev.notificationNumber,
        notificationDate: patch.notificationDate ?? prev.notificationDate,
        formulation: patch.formulation ?? prev.formulation,
        composition: patch.composition ?? prev.composition,
        strength: patch.strength ?? prev.strength,
        dosageFormat: patch.dosageFormat ?? prev.dosageFormat,
        unitLabel: patch.unitLabel ?? prev.unitLabel,
        retailPrice: patch.retailPrice != null ? Number(patch.retailPrice) : prev.retailPrice,
        applicantCompany: patch.applicantCompany ?? prev.applicantCompany,
        sourceUrl: patch.sourceUrl ?? prev.sourceUrl,
      })
      .where(eq(retailPrices.id, id))
      .returning();
    return mapRetailPriceRow(updated[0]);
  } catch (err) {
    throw new Error('Failed to update retail price record.', { cause: err });
  }
}

export async function deleteRetailPriceRecord(id: string): Promise<boolean> {
  await ensureSeeded();
  try {
    const deleted = await db.delete(retailPrices).where(eq(retailPrices.id, id)).returning();
    return deleted.length > 0;
  } catch (err) {
    throw new Error('Failed to delete retail price record.', { cause: err });
  }
}

export async function purgeExpiredRetailPrices(): Promise<number> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(retailPrices);
    const now = new Date();
    const expiredIds: string[] = [];
    for (const r of rows) {
      const expiry = new Date(`${r.notificationDate}T00:00:00Z`);
      expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
      if (expiry < now) expiredIds.push(r.id);
    }
    for (const id of expiredIds) {
      await db.delete(retailPrices).where(eq(retailPrices.id, id));
    }
    return expiredIds.length;
  } catch (err) {
    throw new Error('Failed to purge expired retail prices.', { cause: err });
  }
}

// ============================================================================
// NLEM 2022, COMPANY PROFILE, S.O. TRACKING, SYNC LOGS, CALENDAR & SETTINGS
// ============================================================================

export async function listNlem2022(): Promise<Nlem2022Entry[]> {
  await ensureSeeded();
  try {
    const rows = await db.select().from(nlem2022);
    return rows.map((row) => ({
      id: row.id,
      medicineName: row.medicineName,
      aliases: row.aliases || [],
      therapeuticCategory: row.therapeuticCategory,
      sectionCode: row.sectionCode,
      dosageForms: row.dosageForms || [],
      notes: row.notes || undefined,
    }));
  } catch (err) {
    throw new Error('Failed to load NLEM 2022 directory.', { cause: err });
  }
}

export async function createNlem2022Entry(
  entry: Omit<Nlem2022Entry, 'id'>
): Promise<Nlem2022Entry> {
  await ensureSeeded();
  try {
    const inserted = await db
      .insert(nlem2022)
      .values({
        id: `nlem-${Date.now()}`,
        medicineName: entry.medicineName,
        aliases: entry.aliases || [],
        therapeuticCategory: entry.therapeuticCategory,
        sectionCode: entry.sectionCode,
        dosageForms: entry.dosageForms,
        notes: entry.notes || null,
      })
      .returning();
    const row = inserted[0];
    return {
      id: row.id,
      medicineName: row.medicineName,
      aliases: row.aliases || [],
      therapeuticCategory: row.therapeuticCategory,
      sectionCode: row.sectionCode,
      dosageForms: row.dosageForms || [],
      notes: row.notes || undefined,
    };
  } catch (err) {
    throw new Error('Failed to save NLEM 2022 medicine.', { cause: err });
  }
}

export async function deleteNlem2022Entry(id: string): Promise<boolean> {
  await ensureSeeded();
  try {
    const deleted = await db.delete(nlem2022).where(eq(nlem2022.id, id)).returning();
    return deleted.length > 0;
  } catch (err) {
    throw new Error('Failed to delete NLEM 2022 medicine.', { cause: err });
  }
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.id, COMPANY_PROFILE_ROW_ID));
    const row = rows[0];
    if (!row) return INITIAL_COMPANY_PROFILE;
    return {
      companyName: row.companyName,
      cin: row.cin,
      gstin: row.gstin,
      manufacturingLicenseNo: row.manufacturingLicenseNo,
      corporateAddress: row.corporateAddress,
      regulatoryOfficerName: row.regulatoryOfficerName,
      regulatoryOfficerEmail: row.regulatoryOfficerEmail,
      existingFormulations: row.existingFormulations || [],
      updatedAt: row.updatedAt,
    };
  } catch (err) {
    throw new Error('Failed to load company profile.', { cause: err });
  }
}

export async function updateCompanyProfile(
  patch: Partial<CompanyProfile>
): Promise<CompanyProfile> {
  await ensureSeeded();
  try {
    const prev = await getCompanyProfile();
    const nowIso = new Date().toISOString();
    const next: CompanyProfile = {
      ...prev,
      ...patch,
      existingFormulations: patch.existingFormulations ?? prev.existingFormulations,
      updatedAt: nowIso,
    };
    await db
      .update(companyProfiles)
      .set({
        companyName: next.companyName,
        cin: next.cin,
        gstin: next.gstin,
        manufacturingLicenseNo: next.manufacturingLicenseNo,
        corporateAddress: next.corporateAddress,
        regulatoryOfficerName: next.regulatoryOfficerName,
        regulatoryOfficerEmail: next.regulatoryOfficerEmail,
        existingFormulations: next.existingFormulations,
        updatedAt: nowIso,
      })
      .where(eq(companyProfiles.id, COMPANY_PROFILE_ROW_ID));
    return next;
  } catch (err) {
    throw new Error('Failed to update company profile.', { cause: err });
  }
}

export async function listSoTracking(): Promise<SoTrackingRecord[]> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(soTrackingRecords)
      .orderBy(desc(soTrackingRecords.soDate));
    return rows.map((row) => ({
      id: row.id,
      soNumber: row.soNumber,
      soDate: row.soDate,
      sourceType: row.sourceType as SoTrackingRecord['sourceType'],
      sourceFileName: row.sourceFileName || undefined,
      sourceUrl: row.sourceUrl || undefined,
      ceilingCount: row.ceilingCount,
      retailCount: row.retailCount,
      importedBy: row.importedBy,
      importedAt: row.importedAt,
      notes: row.notes || undefined,
    }));
  } catch (err) {
    throw new Error('Failed to load S.O. tracking ledger.', { cause: err });
  }
}

export async function upsertSoTracking(params: {
  soNumber: string;
  soDate: string;
  sourceType: SoTrackingRecord['sourceType'];
  sourceFileName?: string;
  sourceUrl?: string;
  ceilingCount?: number;
  retailCount?: number;
  importedBy: string;
  notes?: string;
}): Promise<SoTrackingRecord> {
  await ensureSeeded();
  try {
    const soNumber = params.soNumber.trim() || 'S.O. Unspecified';
    const soDate = params.soDate.trim() || new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    const cAdd = Math.max(0, params.ceilingCount || 0);
    const rAdd = Math.max(0, params.retailCount || 0);

    const existing = await db.select().from(soTrackingRecords);
    const match = existing.find(
      (rec) =>
        rec.soNumber.toLowerCase() === soNumber.toLowerCase() && rec.soDate === soDate
    );

    if (match) {
      const updated = await db
        .update(soTrackingRecords)
        .set({
          sourceType: params.sourceType || match.sourceType,
          sourceFileName: params.sourceFileName || match.sourceFileName,
          sourceUrl: params.sourceUrl || match.sourceUrl,
          ceilingCount: match.ceilingCount + cAdd,
          retailCount: match.retailCount + rAdd,
          importedBy: params.importedBy,
          importedAt: nowIso,
          notes: params.notes || match.notes,
        })
        .where(eq(soTrackingRecords.id, match.id))
        .returning();
      const row = updated[0];
      return {
        id: row.id,
        soNumber: row.soNumber,
        soDate: row.soDate,
        sourceType: row.sourceType as SoTrackingRecord['sourceType'],
        sourceFileName: row.sourceFileName || undefined,
        sourceUrl: row.sourceUrl || undefined,
        ceilingCount: row.ceilingCount,
        retailCount: row.retailCount,
        importedBy: row.importedBy,
        importedAt: row.importedAt,
        notes: row.notes || undefined,
      };
    }

    const inserted = await db
      .insert(soTrackingRecords)
      .values({
        id: `so-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        soNumber,
        soDate,
        sourceType: params.sourceType,
        sourceFileName: params.sourceFileName || null,
        sourceUrl: params.sourceUrl || null,
        ceilingCount: cAdd,
        retailCount: rAdd,
        importedBy: params.importedBy,
        importedAt: nowIso,
        notes: params.notes || null,
      })
      .returning();
    const row = inserted[0];
    return {
      id: row.id,
      soNumber: row.soNumber,
      soDate: row.soDate,
      sourceType: row.sourceType as SoTrackingRecord['sourceType'],
      sourceFileName: row.sourceFileName || undefined,
      sourceUrl: row.sourceUrl || undefined,
      ceilingCount: row.ceilingCount,
      retailCount: row.retailCount,
      importedBy: row.importedBy,
      importedAt: row.importedAt,
      notes: row.notes || undefined,
    };
  } catch (err) {
    throw new Error('Failed to record S.O. tracking entry.', { cause: err });
  }
}

export async function listSyncLogs(limit = 30): Promise<SyncLogEntry[]> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(syncLogs)
      .orderBy(desc(syncLogs.timestamp))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      triggeredBy:
        row.triggeredBy === 'scheduled_10am_ist' ? 'scheduled_10am_ist' : 'manual',
      timestamp: row.timestamp,
      status:
        row.status === 'success' || row.status === 'partial' ? row.status : 'fallback',
      circularsFetched: row.circularsFetched,
      authorityMinutesFetched: row.authorityMinutesFetched,
      expertNotesFetched: row.expertNotesFetched,
      newCeilingPricesFound: row.newCeilingPricesFound,
      newRetailPricesFound: row.newRetailPricesFound,
      message: row.message,
    }));
  } catch (err) {
    throw new Error('Failed to load sync history.', { cause: err });
  }
}

export async function insertSyncLog(entry: SyncLogEntry): Promise<void> {
  await ensureSeeded();
  try {
    await db.insert(syncLogs).values({
      id: entry.id,
      triggeredBy: entry.triggeredBy,
      timestamp: entry.timestamp,
      status: entry.status,
      circularsFetched: entry.circularsFetched,
      authorityMinutesFetched: entry.authorityMinutesFetched,
      expertNotesFetched: entry.expertNotesFetched,
      newCeilingPricesFound: entry.newCeilingPricesFound,
      newRetailPricesFound: entry.newRetailPricesFound,
      message: entry.message,
    });
  } catch (err) {
    throw new Error('Failed to log sync event.', { cause: err });
  }
}

export async function listCustomCalendarEvents(): Promise<CustomCalendarEvent[]> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(customCalendarEvents)
      .orderBy(desc(customCalendarEvents.date));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      category: row.category as CalendarEventCategory,
      referenceNumber: row.referenceNumber,
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  } catch (err) {
    throw new Error('Failed to load custom calendar events.', { cause: err });
  }
}

export async function createCustomCalendarEvent(
  event: Omit<CustomCalendarEvent, 'id' | 'createdAt'>
): Promise<CustomCalendarEvent> {
  await ensureSeeded();
  try {
    const nowIso = new Date().toISOString();
    const inserted = await db
      .insert(customCalendarEvents)
      .values({
        id: `cal-custom-${Date.now()}`,
        title: event.title,
        date: event.date,
        category: event.category,
        referenceNumber: event.referenceNumber,
        notes: event.notes,
        createdBy: event.createdBy,
        createdAt: nowIso,
      })
      .returning();
    const row = inserted[0];
    return {
      id: row.id,
      title: row.title,
      date: row.date,
      category: row.category as CalendarEventCategory,
      referenceNumber: row.referenceNumber,
      notes: row.notes,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  } catch (err) {
    throw new Error('Failed to create custom calendar event.', { cause: err });
  }
}

export async function deleteCustomCalendarEvent(id: string): Promise<boolean> {
  await ensureSeeded();
  try {
    const deleted = await db
      .delete(customCalendarEvents)
      .where(eq(customCalendarEvents.id, id))
      .returning();
    return deleted.length > 0;
  } catch (err) {
    throw new Error('Failed to delete custom calendar event.', { cause: err });
  }
}

export async function getLastDailyRunDateIst(): Promise<string | null> {
  await ensureSeeded();
  try {
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, LAST_DAILY_RUN_KEY));
    return rows[0]?.value || null;
  } catch (err) {
    throw new Error('Failed to read daily scheduler state.', { cause: err });
  }
}

export async function setLastDailyRunDateIst(istDate: string): Promise<void> {
  await ensureSeeded();
  try {
    const nowIso = new Date().toISOString();
    await db
      .insert(appSettings)
      .values({
        key: LAST_DAILY_RUN_KEY,
        value: istDate,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: istDate, updatedAt: nowIso },
      });
  } catch (err) {
    throw new Error('Failed to update daily scheduler state.', { cause: err });
  }
}

export async function loadCalendarDataSnapshot(): Promise<{
  nppaLogs: NppaDocumentLog[];
  ceilingPrices: CeilingPriceEntry[];
  retailPrices: RetailPriceEntry[];
  customCalendarEvents: CustomCalendarEvent[];
}> {
  const [groupedLogs, cpData, rpRows, customEvents] = await Promise.all([
    getAllNppaLogsGrouped(),
    getCeilingPricesMaster(),
    listRetailPrices(),
    listCustomCalendarEvents(),
  ]);
  return {
    nppaLogs: groupedLogs.allLogs,
    ceilingPrices: cpData.items,
    retailPrices: rpRows,
    customCalendarEvents: customEvents,
  };
}

export async function loadAiRegistrySnapshot(): Promise<{
  companyProfile: CompanyProfile;
  ceilingPrices: CeilingPriceEntry[];
  retailPrices: RetailPriceEntry[];
  nlem2022: Nlem2022Entry[];
  nppaLogs: NppaDocumentLog[];
}> {
  const [companyProfile, cpData, retailPrices, nlemList, groupedLogs] = await Promise.all([
    getCompanyProfile(),
    getCeilingPricesMaster(),
    listRetailPrices(),
    listNlem2022(),
    getAllNppaLogsGrouped(),
  ]);
  return {
    companyProfile,
    ceilingPrices: cpData.items,
    retailPrices,
    nlem2022: nlemList,
    nppaLogs: groupedLogs.allLogs,
  };
}
