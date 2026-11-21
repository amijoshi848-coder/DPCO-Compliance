import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { evaluateForm1Applicability } from './server/form1Engine.ts';
import {
  backfillNppaLogsSince,
  downloadNppaPdfBuffer,
  getIstDateAndTimeParts,
  NPPA_URLS,
  parseAndApplyNotificationText,
  runNppaSync,
  startDaily10AmScheduler,
} from './server/nppaScraper.ts';
import { generateStandaloneHtml } from './server/standaloneHtmlGenerator.ts';
import {
  createSessionToken,
  getEnvAdminCredentials,
  verifyPassword,
  verifySessionToken,
} from './server/storage.ts';
import {
  aiConvertPdfToComplianceData,
  aiExtractNotificationRows,
  aiGenerateForm1Brief,
  askComplianceAssistant,
  formatGeminiError,
} from './server/aiCompliance.ts';
import { buildComplianceCalendar } from './server/complianceCalendar.ts';
import { parseNppaGazettePdf } from './server/pdfTableParser.ts';
import { adminAuth } from './src/lib/firebase-admin.ts';
import {
  classifyNppaNotification,
  createCustomCalendarEvent,
  createNlem2022Entry,
  createProvisionedUser,
  createRetailPriceIfUnique,
  deleteCeilingPriceRecord,
  deleteCustomCalendarEvent,
  deleteNlem2022Entry,
  deleteNppaLogById,
  deleteProvisionedUser,
  deleteRetailPriceRecord,
  findNppaLogById,
  findUserByUid,
  findUserRecordByLoginId,
  getAllNppaLogsGrouped,
  getCeilingPricesMaster,
  getCompanyProfile,
  getLastDailyRunDateIst,
  getOrCreateFirebaseUser,
  hasActiveAdminPg,
  listAllUsers,
  listNlem2022,
  listRetailPrices,
  listSoTracking,
  listSyncLogs,
  loadCalendarDataSnapshot,
  purgeExpiredRetailPrices,
  recordCeilingPriceNotification,
  touchUserLastLogin,
  updateCeilingPriceRecord,
  updateCompanyProfile,
  updateNppaLogMetadata,
  updateProvisionedUser,
  updateRetailPriceRecord,
  upsertNppaLogs,
  upsertSoTracking,
} from './src/db/repository.ts';
import type {
  AiChatHistoryTurn,
  AiParsedNotificationRow,
  AuthUser,
  CalendarEventCategory,
  CeilingPriceEntry,
  CompanyProfile,
  Form1CheckResult,
  GlobalSearchResultItem,
  Nlem2022Entry,
  NppaDocumentLog,
  NppaLogCategory,
  RetailPriceEntry,
  SearchResultCategory,
  SoTrackingRecord,
} from './src/types/compliance.ts';

interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

function extractAuthToken(req: Request): { token: string | null; viaCookie: boolean } {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return { token: header.slice(7).trim(), viaCookie: false };
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('dpco_token='));
    if (match) {
      return { token: decodeURIComponent(match.split('=')[1] || ''), viaCookie: true };
    }
  }
  return { token: null, viaCookie: false };
}

function isSameOriginMutation(req: Request): boolean {
  if (req.headers['x-requested-with']) return true;
  const origin = req.headers.origin;
  const expectedHost = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString()
    .toLowerCase();
  if (!origin || !expectedHost) return false;
  try {
    return new URL(origin).host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `dpco_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isHttps) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = ['dpco_token=', 'Path=/', 'HttpOnly', 'Max-Age=0'];
  if (isHttps) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { token, viaCookie } = extractAuthToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (
    viaCookie &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase()) &&
    !isSameOriginMutation(req)
  ) {
    res.status(403).json({ error: 'Cross-site request verification failed.' });
    return;
  }

  try {
    // 1. Try Firebase ID token first
    let decodedFirebase: { uid: string; email?: string; name?: string } | null = null;
    try {
      decodedFirebase = await adminAuth.verifyIdToken(token);
    } catch {
      decodedFirebase = null;
    }

    if (decodedFirebase) {
      const user = await getOrCreateFirebaseUser({
        uid: decodedFirebase.uid,
        email: decodedFirebase.email || '',
        displayName: decodedFirebase.name,
      });
      if (!user.active) {
        res.status(403).json({ error: 'Account is disabled or not permitted.' });
        return;
      }
      req.authUser = user;
      next();
      return;
    }

    const verified = verifySessionToken(token);
    if (!verified) {
      res.status(401).json({ error: 'Session expired or invalid.' });
      return;
    }
    const user = await findUserByUid(verified.id);
    if (!user || !user.active) {
      res.status(403).json({ error: 'Account is disabled or not permitted.' });
      return;
    }
    req.authUser = user;
    next();
  } catch (err) {
    console.error('Authentication verification failed:', err);
    res.status(500).json({ error: 'Authentication verification failed.' });
  }
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

function handleRouteError(res: Response, err: unknown, fallbackMessage: string): void {
  console.error(`[API Error] ${fallbackMessage}`, err);
  const status =
    err instanceof Error && typeof (err as Error & { statusCode?: number }).statusCode === 'number'
      ? (err as Error & { statusCode: number }).statusCode
      : 500;
  const message = err instanceof Error && err.message ? err.message : fallbackMessage;
  res.status(status).json({ error: message });
}

async function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));

  // Start daily 10:00 AM IST scheduler (runs asynchronously after startup delay)
  startDaily10AmScheduler();

  // --- Health & Public Overview ---
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'dpco-compliance' });
  });

  app.get('/api/export/standalone-html', (_req, res) => {
    const html = generateStandaloneHtml();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="dpco-compliance-outlook.html"'
    );
    res.send(html);
  });

  app.get('/api/export/standalone-html/preview', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(generateStandaloneHtml());
  });

  // --- Auth Routes ---
  app.get('/api/auth/status', async (_req, res) => {
    try {
      res.json({
        adminConfigured: await hasActiveAdminPg(),
        envAdminConfigured: Boolean(getEnvAdminCredentials()),
        firebaseAuthEnabled: true,
      });
    } catch (err) {
      handleRouteError(res, err, 'Unable to read auth configuration.');
    }
  });

  app.post('/api/auth/setup-admin', async (req, res) => {
    try {
      if (getEnvAdminCredentials()) {
        res.status(403).json({
          error: 'Initial administrator is managed by server environment variables.',
        });
        return;
      }
      if (await hasActiveAdminPg()) {
        res.status(403).json({ error: 'Initial administrator is already configured.' });
        return;
      }

      const { loginId, password, fullName, department } = req.body as {
        loginId?: string;
        password?: string;
        fullName?: string;
        department?: string;
      };
      const cleanLogin = loginId?.trim() || '';
      const cleanPass = password?.trim() || '';
      if (cleanLogin.length < 3 || cleanPass.length < 8) {
        res.status(400).json({
          error: 'Login ID (min 3 characters) and Password (min 8 characters) are required.',
        });
        return;
      }

      const publicUser = await createProvisionedUser({
        uid: 'usr-admin',
        loginId: cleanLogin,
        fullName: (fullName || 'DPCO Administrator').trim(),
        department: (department || 'Regulatory & Pricing Governance').trim(),
        role: 'admin',
        password: cleanPass,
      });
      await touchUserLastLogin(publicUser.id);
      const token = createSessionToken(publicUser);
      setSessionCookie(req, res, token);
      res.status(201).json({ token, user: publicUser });
    } catch (err) {
      handleRouteError(res, err, 'Unable to configure initial administrator.');
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { loginId, password } = req.body as { loginId?: string; password?: string };
      if (!loginId || !password) {
        res.status(400).json({ error: 'Login ID and Password are required.' });
        return;
      }

      const user = await findUserRecordByLoginId(loginId);
      if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        res.status(401).json({ error: 'Invalid Login ID or Password.' });
        return;
      }

      if (!user.active) {
        res.status(403).json({
          error: 'This Login ID is currently deactivated. Contact an administrator.',
        });
        return;
      }

      await touchUserLastLogin(user.id);
      const publicUser: AuthUser = {
        id: user.id,
        loginId: user.loginId,
        fullName: user.fullName,
        department: user.department,
        role: user.role,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: new Date().toISOString(),
      };
      const token = createSessionToken(publicUser);
      setSessionCookie(req, res, token);
      res.json({ token, user: publicUser });
    } catch (err) {
      handleRouteError(res, err, 'Unable to verify login credentials.');
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser });
  });

  // --- Dashboard Overview ---
  app.get('/api/dashboard/overview', requireAuth, async (_req, res) => {
    try {
      const [cpData, rpList, nlemList, groupedLogs, company, sLogs, lastDailyRunDateIst] =
        await Promise.all([
          getCeilingPricesMaster(),
          listRetailPrices(),
          listNlem2022(),
          getAllNppaLogsGrouped(),
          getCompanyProfile(),
          listSyncLogs(10),
          getLastDailyRunDateIst(),
        ]);

      const now = new Date();
      const activeRetail = rpList.filter((r) => {
        if (r.notificationDate <= '2026-07-16') return false;
        const expiry = new Date(r.notificationDate);
        expiry.setFullYear(expiry.getFullYear() + 1);
        return expiry >= now;
      });
      const ist = getIstDateAndTimeParts();
      res.json({
        counts: {
          ceilingPrices: cpData.items.length,
          ceilingRecordsTotal: cpData.allRecords.length,
          activeRetailPrices: activeRetail.length,
          totalRetailPrices: rpList.length,
          nlemFormulations: nlemList.length,
          ceilingLogs: groupedLogs.ceilingLogs.length,
          retailLogs: groupedLogs.retailLogs.length,
          meetingMinutesLogs: groupedLogs.meetingMinutesLogs.length,
          circulars: groupedLogs.allLogs.filter((d) => d.sourceType === 'circular').length,
          authorityMinutes: groupedLogs.allLogs.filter(
            (d) => d.sourceType === 'authority_minutes'
          ).length,
          expertMinutes: groupedLogs.allLogs.filter(
            (d) => d.sourceType === 'expert_committee'
          ).length,
          companySkus: company.existingFormulations.length,
        },
        sources: NPPA_URLS,
        scheduler: {
          scheduleTimeIst: '10:00 AM IST Daily',
          currentIstDate: ist.istDate,
          lastDailyRunDateIst,
          latestSync: sLogs[0] || null,
        },
        syncLogs: sLogs,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load dashboard overview.');
    }
  });

  // --- Ceiling Prices (Schedule Formulations · Latest Implemented Record Resolved) ---
  app.get('/api/ceiling-prices', requireAuth, async (_req, res) => {
    try {
      const data = await getCeilingPricesMaster();
      res.json({
        items: data.items,
        allRecords: data.allRecords,
        supersededCount: data.supersededCount,
        history: data.history,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load ceiling prices.');
    }
  });

  app.post('/api/ceiling-prices', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const body = req.body as Partial<CeilingPriceEntry>;
      if (!body.medicineName || !body.strength || !body.dosageFormat || body.ceilingPrice == null) {
        res.status(400).json({
          error: 'medicineName, strength, dosageFormat, and ceilingPrice are required.',
        });
        return;
      }
      const nowIso = new Date().toISOString();
      const notifNo = (body.notificationNumber || 'S.O. Manual').trim();
      const notifDate = body.notificationDate || nowIso.slice(0, 10);
      const effDate = body.effectiveDate || notifDate;

      const recorded = await recordCeilingPriceNotification({
        entry: {
          medicineName: body.medicineName.trim(),
          composition: (body.composition || body.medicineName).trim(),
          strength: body.strength.trim(),
          dosageFormat: body.dosageFormat.trim(),
          unitLabel: (body.unitLabel || `1 ${body.dosageFormat}`).trim(),
          ceilingPrice: Number(body.ceilingPrice),
          notificationNumber: notifNo,
          notificationDate: notifDate,
          effectiveDate: effDate,
          nlemSection: (body.nlemSection || 'NLEM 2022').trim(),
          gstDefault: body.gstDefault != null ? Number(body.gstDefault) : 12,
          sourceUrl: body.sourceUrl || NPPA_URLS.circular,
          updatedAt: nowIso,
        },
        source: 'admin_edit',
        changedBy: req.authUser?.loginId || 'admin',
      });

      await upsertSoTracking({
        soNumber: recorded.item.notificationNumber,
        soDate: recorded.item.notificationDate,
        sourceType: 'manual_entry',
        sourceUrl: recorded.item.sourceUrl,
        ceilingCount: 1,
        retailCount: 0,
        importedBy: req.authUser?.loginId || 'admin',
        notes: `Added ceiling price for ${recorded.item.medicineName} ${recorded.item.strength}.`,
      });

      res.status(201).json({
        item: recorded.item,
        isLatestImplemented: recorded.isLatestImplemented,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to add ceiling price record.');
    }
  });

  app.put('/api/ceiling-prices/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const updated = await updateCeilingPriceRecord(
        req.params.id,
        req.body as Partial<CeilingPriceEntry>,
        req.authUser?.loginId || 'admin'
      );
      if (!updated) {
        res.status(404).json({ error: 'Ceiling price record not found.' });
        return;
      }
      res.json({ item: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update ceiling price record.');
    }
  });

  app.delete('/api/ceiling-prices/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const deleted = await deleteCeilingPriceRecord(
        req.params.id,
        req.authUser?.loginId || 'admin'
      );
      if (!deleted) {
        res.status(404).json({ error: 'Ceiling price record not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete ceiling price record.');
    }
  });

  // --- Retail Prices (Post 16 July 2026 · Form 1A · 1-year Retention) ---
  app.get('/api/retail-prices', requireAuth, async (_req, res) => {
    try {
      const rpList = await listRetailPrices();
      const now = new Date();
      const enriched = rpList
        .filter((r) => r.notificationDate > '2026-07-16')
        .map((r) => {
          const notifDate = new Date(`${r.notificationDate}T00:00:00Z`);
          const expiryDate = new Date(notifDate);
          expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + 1);
          const msRemaining = expiryDate.getTime() - now.getTime();
          const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
          return {
            ...r,
            retentionExpiresOn: expiryDate.toISOString().slice(0, 10),
            daysRemaining,
            isActiveRetention: daysRemaining >= 0,
          };
        })
        .sort((a, b) => b.notificationDate.localeCompare(a.notificationDate));

      res.json({ items: enriched });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load retail prices.');
    }
  });

  app.post('/api/retail-prices', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const body = req.body as Partial<RetailPriceEntry>;
      if (
        !body.notificationNumber ||
        !body.notificationDate ||
        !body.formulation ||
        body.retailPrice == null
      ) {
        res.status(400).json({
          error: 'notificationNumber, notificationDate, formulation, and retailPrice are required.',
        });
        return;
      }
      if (body.notificationDate <= '2026-07-16') {
        res.status(400).json({
          error: 'Retail Price log only tracks circulars issued after 16th July 2026.',
        });
        return;
      }

      const result = await createRetailPriceIfUnique({
        id: `rp-${Date.now()}`,
        notificationNumber: body.notificationNumber.trim(),
        notificationDate: body.notificationDate.trim(),
        formulation: body.formulation.trim(),
        composition: (body.composition || body.formulation).trim(),
        strength: (body.strength || 'As notified').trim(),
        dosageFormat: (body.dosageFormat || 'Tablet').trim(),
        unitLabel: (body.unitLabel || '1 Unit').trim(),
        retailPrice: Number(body.retailPrice),
        applicantCompany: (body.applicantCompany || 'Form 1A Notified Benchmark').trim(),
        sourceUrl: body.sourceUrl || NPPA_URLS.circular,
        createdAt: new Date().toISOString(),
      });

      if (!result.item) {
        res.status(409).json({
          error: 'A retail price entry for this S.O. number and formulation already exists.',
        });
        return;
      }

      await upsertSoTracking({
        soNumber: result.item.notificationNumber,
        soDate: result.item.notificationDate,
        sourceType: 'manual_entry',
        sourceUrl: result.item.sourceUrl,
        ceilingCount: 0,
        retailCount: 1,
        importedBy: req.authUser?.loginId || 'admin',
        notes: `Added Form 1A retail price for ${result.item.formulation}.`,
      });

      res.status(201).json({ item: result.item });
    } catch (err) {
      handleRouteError(res, err, 'Failed to add retail price record.');
    }
  });

  app.put('/api/retail-prices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const updated = await updateRetailPriceRecord(
        req.params.id,
        req.body as Partial<RetailPriceEntry>
      );
      if (!updated) {
        res.status(404).json({ error: 'Retail price record not found.' });
        return;
      }
      res.json({ item: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update retail price record.');
    }
  });

  app.delete('/api/retail-prices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deleted = await deleteRetailPriceRecord(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Retail price record not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete retail price record.');
    }
  });

  app.post('/api/retail-prices/purge-expired', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const purged = await purgeExpiredRetailPrices();
      res.json({ purged });
    } catch (err) {
      handleRouteError(res, err, 'Failed to purge expired retail prices.');
    }
  });

  // --- 3 Separate NPPA Notification Logs (Ceiling Price, Retail Price, Meeting Minutes) ---
  app.get('/api/nppa-logs', requireAuth, async (_req, res) => {
    try {
      const [grouped, sLogs] = await Promise.all([
        getAllNppaLogsGrouped(),
        listSyncLogs(30),
      ]);
      res.json({
        items: grouped.allLogs,
        ceilingLogs: grouped.ceilingLogs,
        retailLogs: grouped.retailLogs,
        meetingMinutesLogs: grouped.meetingMinutesLogs,
        syncLogs: sLogs,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load NPPA notification logs.');
    }
  });

  app.post('/api/nppa-logs/sync', requireAuth, async (_req, res) => {
    try {
      const syncResult = await runNppaSync('manual');
      const [grouped, sLogs] = await Promise.all([
        getAllNppaLogsGrouped(),
        listSyncLogs(30),
      ]);
      res.json({
        syncResult,
        items: grouped.allLogs,
        ceilingLogs: grouped.ceilingLogs,
        retailLogs: grouped.retailLogs,
        meetingMinutesLogs: grouped.meetingMinutesLogs,
        syncLogs: sLogs,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to sync NPPA portals.');
    }
  });

  app.post('/api/nppa-logs/backfill', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { sinceDate } = (req.body || {}) as { sinceDate?: string };
      const cleanSince =
        sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(sinceDate.trim())
          ? sinceDate.trim()
          : '2025-01-01';
      const result = await backfillNppaLogsSince(cleanSince);
      const [grouped, sLogs] = await Promise.all([
        getAllNppaLogsGrouped(),
        listSyncLogs(30),
      ]);
      res.json({
        ...result,
        items: grouped.allLogs,
        ceilingLogs: grouped.ceilingLogs,
        retailLogs: grouped.retailLogs,
        meetingMinutesLogs: grouped.meetingMinutesLogs,
        syncLogs: sLogs,
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load historical NPPA archive.');
    }
  });

  app.post('/api/nppa-logs/parse-notification', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const { rawText, notificationNumber, notificationDate, defaultKind } = req.body as {
        rawText?: string;
        notificationNumber?: string;
        notificationDate?: string;
        defaultKind?: 'auto' | 'ceiling' | 'retail';
      };
      if (!rawText || !rawText.trim()) {
        res.status(400).json({
          error: 'Notification text is required to parse formulations and prices.',
        });
        return;
      }
      const result = await parseAndApplyNotificationText(rawText, {
        notificationNumber,
        notificationDate,
        defaultKind: defaultKind || 'auto',
        source: 'notification_parser',
        changedBy: req.authUser?.loginId || 'admin',
      });
      res.json({ result });
    } catch (err) {
      handleRouteError(res, err, 'Failed to parse notification text.');
    }
  });

  app.post('/api/nppa-logs', requireAuth, requireAdmin, async (req, res) => {
    try {
      const body = req.body as Partial<NppaDocumentLog> & { logCategory?: NppaLogCategory };
      if (!body.title || !body.sourceType) {
        res.status(400).json({ error: 'title and sourceType are required.' });
        return;
      }
      const summary = (body.summary || '').trim();
      const logCategory = classifyNppaNotification(
        body.title.trim(),
        body.sourceType,
        summary,
        body.logCategory
      );
      const item: NppaDocumentLog = {
        id: `doc-${Date.now()}`,
        sourceType: body.sourceType,
        logCategory,
        title: body.title.trim(),
        referenceNumber: (body.referenceNumber || 'NPPA Notice').trim(),
        publishedDate: body.publishedDate || new Date().toISOString().slice(0, 10),
        summary,
        url: body.url || NPPA_URLS[body.sourceType],
        fetchedAt: new Date().toISOString(),
        isLiveFetched: false,
      };
      await upsertNppaLogs([item]);
      res.status(201).json({ item });
    } catch (err) {
      handleRouteError(res, err, 'Failed to save NPPA log entry.');
    }
  });

  app.delete('/api/nppa-logs/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deleted = await deleteNppaLogById(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Document log not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete NPPA log entry.');
    }
  });

  // --- S.O. Tracking Ledger & NPPA PDF Download / Conversion ---
  app.get('/api/so-tracking', requireAuth, async (_req, res) => {
    try {
      const items = await listSoTracking();
      res.json({ items });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load S.O. tracking records.');
    }
  });

  app.get('/api/nppa-logs/:id/download-pdf', requireAuth, async (req, res) => {
    try {
      const log = await findNppaLogById(req.params.id);
      if (!log) {
        res.status(404).json({ error: 'NPPA log entry not found.' });
        return;
      }
      try {
        const { buffer, fileName, resolvedUrl } = await downloadNppaPdfBuffer(
          log.pdfUrl || log.url,
          log.referenceNumber
        );
        if (!log.pdfUrl && resolvedUrl.toLowerCase().includes('.pdf')) {
          await updateNppaLogMetadata(log.id, { pdfUrl: resolvedUrl });
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to download NPPA PDF.';
        res.status(422).json({ error: message });
      }
    } catch (err) {
      handleRouteError(res, err, 'Unable to download NPPA PDF.');
    }
  });

  app.post('/api/nppa-logs/:id/convert-pdf', requireAuth, requireAdmin, async (req, res) => {
    try {
      const log = await findNppaLogById(req.params.id);
      if (!log) {
        res.status(404).json({ error: 'NPPA log entry not found.' });
        return;
      }
      const { defaultKind } = (req.body || {}) as { defaultKind?: 'auto' | 'ceiling' | 'retail' };
      try {
        const { buffer, fileName, resolvedUrl } = await downloadNppaPdfBuffer(
          log.pdfUrl || log.url,
          log.referenceNumber
        );
        if (!log.pdfUrl && resolvedUrl.toLowerCase().includes('.pdf')) {
          await updateNppaLogMetadata(log.id, { pdfUrl: resolvedUrl });
        }
        const deterministicResult = await parseNppaGazettePdf({
          pdfBuffer: buffer,
          fileName,
          fallbackSoNumber: log.referenceNumber,
          fallbackSoDate: log.publishedDate,
          defaultKind: defaultKind || 'auto',
        }).catch(() => null);

        const result =
          deterministicResult && deterministicResult.rows.length > 0
            ? deterministicResult
            : await aiConvertPdfToComplianceData({
                pdfBase64: buffer.toString('base64'),
                fileName,
                fallbackSoNumber: log.referenceNumber,
                fallbackSoDate: log.publishedDate,
                defaultKind: defaultKind || 'auto',
              });
        res.json({ result, resolvedUrl });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (
          raw.includes('No direct PDF') ||
          raw.includes('NPPA portal') ||
          raw.includes('Linked NPPA') ||
          raw.includes('HTTP/HTTPS') ||
          raw.includes('abort')
        ) {
          res.status(422).json({ error: raw });
          return;
        }
        const formatted = formatGeminiError(err);
        res.status(formatted.status).json({ error: formatted.message });
      }
    } catch (err) {
      handleRouteError(res, err, 'Failed to convert NPPA PDF.');
    }
  });

  app.post('/api/pdf/convert', requireAuth, requireAdmin, async (req, res) => {
    const { pdfBase64, fileName, fallbackSoNumber, fallbackSoDate, defaultKind } = req.body as {
      pdfBase64?: string;
      fileName?: string;
      fallbackSoNumber?: string;
      fallbackSoDate?: string;
      defaultKind?: 'auto' | 'ceiling' | 'retail';
    };
    if (!pdfBase64 || !pdfBase64.trim()) {
      res.status(400).json({ error: 'Please upload a PDF file to convert.' });
      return;
    }
    try {
      const deterministicResult = await parseNppaGazettePdf({
        pdfBase64,
        fileName,
        fallbackSoNumber,
        fallbackSoDate,
        defaultKind: defaultKind || 'auto',
      }).catch(() => null);

      const result =
        deterministicResult && deterministicResult.rows.length > 0
          ? deterministicResult
          : await aiConvertPdfToComplianceData({
              pdfBase64,
              fileName,
              fallbackSoNumber,
              fallbackSoDate,
              defaultKind: defaultKind || 'auto',
            });
      res.json({ result });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // --- NLEM 2022 Master & Form I Check ---
  app.get('/api/nlem2022', requireAuth, async (_req, res) => {
    try {
      const items = await listNlem2022();
      res.json({ items });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load NLEM 2022 directory.');
    }
  });

  app.post('/api/nlem2022', requireAuth, requireAdmin, async (req, res) => {
    try {
      const body = req.body as Partial<Nlem2022Entry>;
      if (!body.medicineName || !body.dosageForms || body.dosageForms.length === 0) {
        res.status(400).json({ error: 'medicineName and at least one dosageForm are required.' });
        return;
      }
      const item = await createNlem2022Entry({
        medicineName: body.medicineName.trim(),
        aliases: body.aliases || [],
        therapeuticCategory: (body.therapeuticCategory || 'Essential Medicines').trim(),
        sectionCode: (body.sectionCode || 'NLEM 2022').trim(),
        dosageForms: body.dosageForms,
        notes: body.notes,
      });
      res.status(201).json({ item });
    } catch (err) {
      handleRouteError(res, err, 'Failed to add NLEM 2022 entry.');
    }
  });

  app.delete('/api/nlem2022/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deleted = await deleteNlem2022Entry(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'NLEM entry not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete NLEM 2022 entry.');
    }
  });

  app.post('/api/form1-check', requireAuth, async (req, res) => {
    try {
      const { productName, dosageForm, compositionText } = req.body as {
        productName?: string;
        dosageForm?: string;
        compositionText?: string;
      };
      if (!compositionText || !compositionText.trim()) {
        res.status(400).json({
          error: 'Please enter the product composition to check Form I applicability.',
        });
        return;
      }
      const [nlemList, company] = await Promise.all([listNlem2022(), getCompanyProfile()]);
      const result = evaluateForm1Applicability(
        {
          productName: productName || 'Proposed New Formulation',
          dosageForm: dosageForm || 'Tablet',
          compositionText: compositionText.trim(),
        },
        nlemList,
        company
      );
      res.json({ result });
    } catch (err) {
      handleRouteError(res, err, 'Failed to run Form I check.');
    }
  });

  // --- Company Profile ---
  app.get('/api/company', requireAuth, async (_req, res) => {
    try {
      const company = await getCompanyProfile();
      res.json({ company });
    } catch (err) {
      handleRouteError(res, err, 'Failed to load company profile.');
    }
  });

  app.put('/api/company', requireAuth, async (req, res) => {
    try {
      const company = await updateCompanyProfile(req.body as Partial<CompanyProfile>);
      res.json({ company });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update company profile.');
    }
  });

  // --- Admin: Allowed Login IDs Management ---
  app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const all = await listAllUsers();
      res.json({ users: all });
    } catch (err) {
      handleRouteError(res, err, 'Failed to list authorized users.');
    }
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { loginId, fullName, department, role, password } = req.body as {
        loginId?: string;
        fullName?: string;
        department?: string;
        role?: 'admin' | 'user';
        password?: string;
      };
      if (!loginId || !password || !fullName) {
        res.status(400).json({ error: 'loginId, fullName, and password are required.' });
        return;
      }
      const created = await createProvisionedUser({
        loginId,
        fullName,
        department: department || 'Regulatory Affairs',
        role: role === 'admin' ? 'admin' : 'user',
        password,
      });
      res.status(201).json({ user: created });
    } catch (err) {
      handleRouteError(res, err, 'Failed to create allowed Login ID.');
    }
  });

  app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const { fullName, department, role, active, password } = req.body as {
        fullName?: string;
        department?: string;
        role?: 'admin' | 'user';
        active?: boolean;
        password?: string;
      };
      if (req.params.id === req.authUser?.id && active === false) {
        res.status(400).json({ error: 'You cannot deactivate your own active admin session.' });
        return;
      }
      const updated = await updateProvisionedUser(req.params.id, {
        fullName,
        department,
        role,
        active,
        password,
      });
      if (!updated) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      res.json({ user: updated });
    } catch (err) {
      handleRouteError(res, err, 'Failed to update user account.');
    }
  });

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      if (req.params.id === req.authUser?.id) {
        res.status(400).json({ error: 'You cannot delete the currently signed-in admin account.' });
        return;
      }
      const deleted = await deleteProvisionedUser(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete user account.');
    }
  });

  // --- Unified Cross-Registry Search ---
  app.get('/api/search', requireAuth, async (req, res) => {
    try {
      const rawQuery = String(req.query.q || '').trim();
      const categoryFilter = String(req.query.category || 'all').trim() as
        | 'all'
        | SearchResultCategory;

      if (!rawQuery) {
        res.json({ query: '', total: 0, results: [] });
        return;
      }

      const [cpData, rpList, nlemList, groupedLogs] = await Promise.all([
        getCeilingPricesMaster(),
        listRetailPrices(),
        listNlem2022(),
        getAllNppaLogsGrouped(),
      ]);

      const terms = rawQuery
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);

      const matchesAll = (haystack: string) => {
        const lower = haystack.toLowerCase();
        return terms.every((t) => lower.includes(t));
      };

      const results: GlobalSearchResultItem[] = [];

      if (categoryFilter === 'all' || categoryFilter === 'ceiling') {
        for (const c of cpData.items) {
          const hay = `${c.medicineName} ${c.composition} ${c.strength} ${c.dosageFormat} ${c.notificationNumber} ${c.nlemSection}`;
          if (matchesAll(hay)) {
            results.push({
              id: `sr-cp-${c.id}`,
              category: 'ceiling',
              title: `${c.medicineName} ${c.strength} ${c.dosageFormat}`,
              subtitle: `${c.composition} · Sec ${c.nlemSection}`,
              meta: `₹${c.ceilingPrice.toFixed(2)}/${c.unitLabel} · ${c.notificationNumber}`,
              tabTarget: 'schedule_formulations',
              searchKeyword: c.medicineName,
            });
          }
        }
      }

      if (categoryFilter === 'all' || categoryFilter === 'retail') {
        for (const r of rpList) {
          if (r.notificationDate <= '2026-07-16') continue;
          const hay = `${r.formulation} ${r.composition} ${r.notificationNumber} ${r.applicantCompany} ${r.notificationDate}`;
          if (matchesAll(hay)) {
            results.push({
              id: `sr-rp-${r.id}`,
              category: 'retail',
              title: r.formulation,
              subtitle: `${r.applicantCompany} · ${r.unitLabel}`,
              meta: `₹${r.retailPrice.toFixed(2)} · ${r.notificationNumber} (${r.notificationDate})`,
              tabTarget: 'retail_prices',
              searchKeyword: r.notificationNumber,
            });
          }
        }
      }

      if (categoryFilter === 'all' || categoryFilter === 'nlem') {
        for (const n of nlemList) {
          const strengths = n.dosageForms
            .map((d) => `${d.dosageForm} ${d.strength}`)
            .join(' ');
          const hay = `${n.medicineName} ${(n.aliases || []).join(' ')} ${n.therapeuticCategory} ${n.sectionCode} ${strengths}`;
          if (matchesAll(hay)) {
            results.push({
              id: `sr-nlem-${n.id}`,
              category: 'nlem',
              title: `${n.medicineName} (NLEM 2022)`,
              subtitle: `Sec ${n.sectionCode} · ${n.therapeuticCategory}`,
              meta: n.dosageForms
                .map((d) => `${d.dosageForm} ${d.strength}`)
                .slice(0, 4)
                .join(', '),
              tabTarget: 'new_product',
              searchKeyword: n.medicineName,
            });
          }
        }
      }

      if (categoryFilter === 'all' || categoryFilter === 'nppa_log') {
        for (const d of groupedLogs.allLogs) {
          const hay = `${d.title} ${d.referenceNumber} ${d.summary} ${d.sourceType} ${d.logCategory || ''} ${d.publishedDate}`;
          if (matchesAll(hay)) {
            results.push({
              id: `sr-log-${d.id}`,
              category: 'nppa_log',
              title: d.title,
              subtitle: d.summary || d.logCategory || d.sourceType,
              meta: `${d.referenceNumber} · ${d.publishedDate}`,
              tabTarget: 'schedule_formulations',
              searchKeyword: '',
            });
          }
        }
      }

      if (categoryFilter === 'all' || categoryFilter === 'history') {
        for (const h of cpData.history) {
          const hay = `${h.medicineName} ${h.strength} ${h.dosageFormat} ${h.notificationNumber} ${h.notes} ${h.changedBy}`;
          if (matchesAll(hay)) {
            results.push({
              id: `sr-hist-${h.id}`,
              category: 'history',
              title: `${h.medicineName} ${h.strength} (${h.changeType})`,
              subtitle: h.notes,
              meta: `${h.notificationNumber} · ${h.notificationDate}`,
              tabTarget: 'schedule_formulations',
              searchKeyword: h.medicineName,
            });
          }
        }
      }

      res.json({
        query: rawQuery,
        total: results.length,
        results: results.slice(0, 50),
      });
    } catch (err) {
      handleRouteError(res, err, 'Failed to execute registry search.');
    }
  });

  // --- Server-Side Gemini AI Capabilities ---
  app.post('/api/ai/chat', requireAuth, async (req, res) => {
    const { message, history, useWebSearch } = req.body as {
      message?: string;
      history?: AiChatHistoryTurn[];
      useWebSearch?: boolean;
    };
    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Please enter a regulatory question or search query.' });
      return;
    }
    try {
      const data = await askComplianceAssistant({
        message: message.trim(),
        history: Array.isArray(history) ? history : [],
        useWebSearch: Boolean(useWebSearch),
      });
      res.json(data);
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/ai/extract-notification', requireAuth, requireAdmin, async (req, res) => {
    const { rawText, notificationNumber, notificationDate, defaultKind } = req.body as {
      rawText?: string;
      notificationNumber?: string;
      notificationDate?: string;
      defaultKind?: 'auto' | 'ceiling' | 'retail';
    };
    if (!rawText || !rawText.trim()) {
      res.status(400).json({ error: 'Notification text is required for AI extraction.' });
      return;
    }
    try {
      const rows = await aiExtractNotificationRows({
        rawText: rawText.trim(),
        notificationNumber,
        notificationDate,
        defaultKind: defaultKind || 'auto',
      });
      res.json({ rows });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/ai/apply-extracted-rows', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const {
        rows,
        soNumber,
        soDate,
        sourceType,
        sourceFileName,
        sourceUrl,
        logId,
      } = req.body as {
        rows?: AiParsedNotificationRow[];
        soNumber?: string;
        soDate?: string;
        sourceType?: SoTrackingRecord['sourceType'];
        sourceFileName?: string;
        sourceUrl?: string;
        logId?: string;
      };
      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: 'No extracted rows supplied.' });
        return;
      }

      const nowIso = new Date().toISOString();
      const actor = req.authUser?.loginId || 'admin';
      const overrideSoNo = soNumber?.trim() || '';
      const overrideSoDate = soDate?.trim() || '';
      let ceilingAdded = 0;
      let ceilingRevised = 0;
      let retailAdded = 0;
      const perSoSummary = new Map<
        string,
        { soNumber: string; soDate: string; ceiling: number; retail: number }
      >();

      const trackBucket = (num: string, dt: string, kind: 'ceiling' | 'retail') => {
        const key = `${num}|${dt}`;
        const cur = perSoSummary.get(key) || { soNumber: num, soDate: dt, ceiling: 0, retail: 0 };
        if (kind === 'ceiling') cur.ceiling += 1;
        else cur.retail += 1;
        perSoSummary.set(key, cur);
      };

      for (const row of rows) {
        if (!row.medicineName || typeof row.price !== 'number' || row.price <= 0) continue;
        const effectiveSoNo = overrideSoNo || row.notificationNumber || 'S.O. Unspecified';
        const effectiveSoDate = overrideSoDate || row.notificationDate || nowIso.slice(0, 10);

        if (row.kind === 'retail') {
          const notifDate = effectiveSoDate > '2026-07-16' ? effectiveSoDate : '2026-07-17';
          const rpRes = await createRetailPriceIfUnique({
            id: `rp-ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            notificationNumber: effectiveSoNo,
            notificationDate: notifDate,
            formulation: `${row.medicineName} ${row.strength} ${row.dosageFormat}`.trim(),
            composition: row.composition || row.medicineName,
            strength: row.strength,
            dosageFormat: row.dosageFormat,
            unitLabel: row.unitLabel || `1 ${row.dosageFormat}`,
            retailPrice: row.price,
            applicantCompany: sourceFileName
              ? `PDF Converted (${sourceFileName})`
              : 'AI Extracted Form 1A Reference',
            sourceUrl: sourceUrl || NPPA_URLS.circular,
            createdAt: nowIso,
          });
          if (rpRes.created) {
            retailAdded += 1;
            trackBucket(effectiveSoNo, notifDate, 'retail');
          }
        } else {
          const rec = await recordCeilingPriceNotification({
            entry: {
              medicineName: row.medicineName,
              composition: row.composition || row.medicineName,
              strength: row.strength,
              dosageFormat: row.dosageFormat,
              unitLabel: row.unitLabel || `1 ${row.dosageFormat}`,
              ceilingPrice: row.price,
              notificationNumber: effectiveSoNo,
              notificationDate: effectiveSoDate,
              effectiveDate: effectiveSoDate,
              nlemSection: row.nlemSection || 'NLEM 2022',
              gstDefault: 12,
              sourceUrl: sourceUrl || NPPA_URLS.circular,
              updatedAt: nowIso,
            },
            source: 'notification_parser',
            changedBy: `${actor} (PDF/AI Extract)`,
          });
          if (rec.action === 'revised') {
            ceilingRevised += 1;
          } else {
            ceilingAdded += 1;
          }
          trackBucket(effectiveSoNo, effectiveSoDate, 'ceiling');
        }
      }

      let lastSoRecord: SoTrackingRecord | null = null;
      for (const bucket of perSoSummary.values()) {
        lastSoRecord = await upsertSoTracking({
          soNumber: bucket.soNumber,
          soDate: bucket.soDate,
          sourceType: sourceType || (sourceFileName ? 'pdf_upload' : 'manual_entry'),
          sourceFileName,
          sourceUrl,
          ceilingCount: bucket.ceiling,
          retailCount: bucket.retail,
          importedBy: actor,
          notes: sourceFileName
            ? `Converted from PDF "${sourceFileName}" (${bucket.ceiling} ceiling, ${bucket.retail} retail).`
            : `Imported ${bucket.ceiling} ceiling and ${bucket.retail} retail entries.`,
        });
      }

      if (logId) {
        const logEntry = await findNppaLogById(logId);
        if (logEntry) {
          await updateNppaLogMetadata(logId, {
            soImportedAt: nowIso,
            incrementEntryCount: ceilingAdded + ceilingRevised + retailAdded,
            referenceNumber:
              overrideSoNo && /^Notice\s*\(/i.test(logEntry.referenceNumber)
                ? overrideSoNo
                : undefined,
          });
        }
      }

      res.json({ ceilingAdded, ceilingRevised, retailAdded, soRecord: lastSoRecord });
    } catch (err) {
      handleRouteError(res, err, 'Failed to apply extracted rows.');
    }
  });

  app.post('/api/ai/form1-brief', requireAuth, async (req, res) => {
    const { result } = req.body as { result?: Form1CheckResult };
    if (!result || !result.compositionText) {
      res.status(400).json({ error: 'Form I check result is required.' });
      return;
    }
    try {
      const brief = await aiGenerateForm1Brief(result);
      res.json({ brief });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // --- Compliance Calendar (Deadlines & Authority / Expert Committee Meetings) ---
  app.get('/api/calendar', requireAuth, async (_req, res) => {
    try {
      const snapshot = await loadCalendarDataSnapshot();
      res.json(buildComplianceCalendar(snapshot));
    } catch (err) {
      handleRouteError(res, err, 'Failed to load compliance calendar.');
    }
  });

  app.post('/api/calendar', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    try {
      const { title, date, category, referenceNumber, notes } = req.body as {
        title?: string;
        date?: string;
        category?: CalendarEventCategory;
        referenceNumber?: string;
        notes?: string;
      };
      if (!title || !title.trim() || !date || !date.trim()) {
        res.status(400).json({ error: 'title and date (YYYY-MM-DD) are required.' });
        return;
      }
      const item = await createCustomCalendarEvent({
        title: title.trim(),
        date: date.trim(),
        category: category || 'custom_deadline',
        referenceNumber: (referenceNumber || 'Internal Notice').trim(),
        notes: (notes || '').trim(),
        createdBy: req.authUser?.loginId || 'admin',
      });
      const snapshot = await loadCalendarDataSnapshot();
      res.status(201).json({ item, calendar: buildComplianceCalendar(snapshot) });
    } catch (err) {
      handleRouteError(res, err, 'Failed to create calendar event.');
    }
  });

  app.delete('/api/calendar/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deleted = await deleteCustomCalendarEvent(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Custom calendar event not found.' });
        return;
      }
      const snapshot = await loadCalendarDataSnapshot();
      res.json({ ok: true, calendar: buildComplianceCalendar(snapshot) });
    } catch (err) {
      handleRouteError(res, err, 'Failed to delete calendar event.');
    }
  });

  // --- Unmatched API 404 Handler ---
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // --- Vite / Static Frontend Serving ---
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`DPCO Compliance server running on http://0.0.0.0:${port}`);
  });
}

createApp().catch((err) => {
  console.error('Failed to start DPCO Compliance server:', err);
  process.exit(1);
});
