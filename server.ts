import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { evaluateForm1Applicability } from './server/form1Engine.ts';
import {
  downloadNppaPdfBuffer,
  getIstDateAndTimeParts,
  NPPA_URLS,
  parseAndApplyNotificationText,
  recordSoTracking,
  runNppaSync,
  startDaily10AmScheduler,
} from './server/nppaScraper.ts';
import { generateStandaloneHtml } from './server/standaloneHtmlGenerator.ts';
import {
  createSessionToken,
  hashPassword,
  loadDb,
  saveDb,
  toPublicUser,
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
import type {
  AiChatHistoryTurn,
  AiParsedNotificationRow,
  AuthUser,
  CalendarEventCategory,
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  CompanyProfile,
  CustomCalendarEvent,
  Form1CheckResult,
  GlobalSearchResultItem,
  Nlem2022Entry,
  NppaDocumentLog,
  RetailPriceEntry,
  SearchResultCategory,
  SoTrackingRecord,
} from './src/types/compliance.ts';

interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('dpco_token='));
    if (match) {
      return decodeURIComponent(match.split('=')[1] || '');
    }
  }
  return null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const verified = verifySessionToken(token);
  if (!verified) {
    res.status(401).json({ error: 'Session expired or invalid.' });
    return;
  }
  const db = loadDb();
  const user = db.users.find((u) => u.id === verified.id);
  if (!user || !user.active) {
    res.status(403).json({ error: 'Account is disabled or not permitted.' });
    return;
  }
  req.authUser = toPublicUser(user);
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Initialize DB and daily 10:00 AM IST scheduler
  loadDb();
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
  app.post('/api/auth/login', (req, res) => {
    const { loginId, password } = req.body as { loginId?: string; password?: string };
    if (!loginId || !password) {
      res.status(400).json({ error: 'Login ID and Password are required.' });
      return;
    }

    const db = loadDb();
    const user = db.users.find(
      (u) => u.loginId.toLowerCase() === loginId.trim().toLowerCase()
    );

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid Login ID or Password.' });
      return;
    }

    if (!user.active) {
      res.status(403).json({
        error: 'This Login ID is currently deactivated. Contact an administrator.',
      });
      return;
    }

    user.lastLoginAt = new Date().toISOString();
    saveDb(db);

    const publicUser = toPublicUser(user);
    const token = createSessionToken(publicUser);
    res.json({ token, user: publicUser });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser });
  });

  // --- Dashboard Overview ---
  app.get('/api/dashboard/overview', requireAuth, (_req, res) => {
    const db = loadDb();
    const now = new Date();
    const activeRetail = db.retailPrices.filter((r) => {
      if (r.notificationDate <= '2026-07-16') return false;
      const expiry = new Date(r.notificationDate);
      expiry.setFullYear(expiry.getFullYear() + 1);
      return expiry >= now;
    });
    const ist = getIstDateAndTimeParts();
    res.json({
      counts: {
        ceilingPrices: db.ceilingPrices.length,
        activeRetailPrices: activeRetail.length,
        totalRetailPrices: db.retailPrices.length,
        nlemFormulations: db.nlem2022.length,
        circulars: db.nppaLogs.filter((d) => d.sourceType === 'circular').length,
        authorityMinutes: db.nppaLogs.filter((d) => d.sourceType === 'authority_minutes').length,
        expertMinutes: db.nppaLogs.filter((d) => d.sourceType === 'expert_committee').length,
        companySkus: db.companyProfile.existingFormulations.length,
      },
      sources: NPPA_URLS,
      scheduler: {
        scheduleTimeIst: '10:00 AM IST Daily',
        currentIstDate: ist.istDate,
        lastDailyRunDateIst: db.lastDailyRunDateIst,
        latestSync: db.syncLogs[0] || null,
      },
      syncLogs: db.syncLogs.slice(0, 10),
    });
  });

  // --- Ceiling Prices (Schedule Formulations) ---
  app.get('/api/ceiling-prices', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json({ items: db.ceilingPrices, history: db.ceilingPriceHistory });
  });

  app.post('/api/ceiling-prices', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const body = req.body as Partial<CeilingPriceEntry>;
    if (!body.medicineName || !body.strength || !body.dosageFormat || body.ceilingPrice == null) {
      res.status(400).json({
        error: 'medicineName, strength, dosageFormat, and ceilingPrice are required.',
      });
      return;
    }
    const db = loadDb();
    const nowIso = new Date().toISOString();
    const item: CeilingPriceEntry = {
      id: `cp-${Date.now()}`,
      medicineName: body.medicineName.trim(),
      composition: (body.composition || body.medicineName).trim(),
      strength: body.strength.trim(),
      dosageFormat: body.dosageFormat.trim(),
      unitLabel: (body.unitLabel || `1 ${body.dosageFormat}`).trim(),
      ceilingPrice: Number(body.ceilingPrice),
      notificationNumber: (body.notificationNumber || 'S.O. Manual').trim(),
      notificationDate: body.notificationDate || nowIso.slice(0, 10),
      effectiveDate: body.effectiveDate || body.notificationDate || nowIso.slice(0, 10),
      nlemSection: (body.nlemSection || 'NLEM 2022').trim(),
      gstDefault: body.gstDefault != null ? Number(body.gstDefault) : 12,
      sourceUrl: body.sourceUrl || NPPA_URLS.circular,
      updatedAt: nowIso,
    };
    db.ceilingPrices.unshift(item);
    const hist: CeilingPriceHistoryEntry = {
      id: `cph-${Date.now()}`,
      ceilingPriceId: item.id,
      medicineName: item.medicineName,
      strength: item.strength,
      dosageFormat: item.dosageFormat,
      changeType: 'created',
      previousCeilingPrice: null,
      newCeilingPrice: item.ceilingPrice,
      notificationNumber: item.notificationNumber,
      notificationDate: item.notificationDate,
      source: 'admin_edit',
      changedBy: req.authUser?.loginId || 'admin',
      notes: `Added ceiling price ₹${item.ceilingPrice.toFixed(2)} (${item.notificationNumber}).`,
      timestamp: nowIso,
    };
    db.ceilingPriceHistory.unshift(hist);
    db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
    recordSoTracking(db, {
      soNumber: item.notificationNumber,
      soDate: item.notificationDate,
      sourceType: 'manual_entry',
      sourceUrl: item.sourceUrl,
      ceilingCount: 1,
      retailCount: 0,
      importedBy: req.authUser?.loginId || 'admin',
      notes: `Added ceiling price for ${item.medicineName} ${item.strength}.`,
    });
    saveDb(db);
    res.status(201).json({ item });
  });

  app.put('/api/ceiling-prices/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const db = loadDb();
    const idx = db.ceilingPrices.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Ceiling price record not found.' });
      return;
    }
    const prev = db.ceilingPrices[idx];
    const patch = req.body as Partial<CeilingPriceEntry>;
    const nowIso = new Date().toISOString();
    const nextPrice =
      patch.ceilingPrice != null ? Number(patch.ceilingPrice) : prev.ceilingPrice;

    db.ceilingPrices[idx] = {
      ...prev,
      ...patch,
      ceilingPrice: nextPrice,
      gstDefault:
        patch.gstDefault != null ? Number(patch.gstDefault) : prev.gstDefault,
      updatedAt: nowIso,
    };

    const hist: CeilingPriceHistoryEntry = {
      id: `cph-${Date.now()}`,
      ceilingPriceId: prev.id,
      medicineName: db.ceilingPrices[idx].medicineName,
      strength: db.ceilingPrices[idx].strength,
      dosageFormat: db.ceilingPrices[idx].dosageFormat,
      changeType: 'revised',
      previousCeilingPrice: prev.ceilingPrice,
      newCeilingPrice: nextPrice,
      notificationNumber: db.ceilingPrices[idx].notificationNumber,
      notificationDate: db.ceilingPrices[idx].notificationDate,
      source: 'admin_edit',
      changedBy: req.authUser?.loginId || 'admin',
      notes: `Updated ceiling price from ₹${prev.ceilingPrice.toFixed(2)} to ₹${nextPrice.toFixed(2)}.`,
      timestamp: nowIso,
    };
    db.ceilingPriceHistory.unshift(hist);
    db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
    saveDb(db);
    res.json({ item: db.ceilingPrices[idx] });
  });

  app.delete('/api/ceiling-prices/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const db = loadDb();
    const target = db.ceilingPrices.find((c) => c.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Ceiling price record not found.' });
      return;
    }
    db.ceilingPrices = db.ceilingPrices.filter((c) => c.id !== req.params.id);
    db.ceilingPriceHistory.unshift({
      id: `cph-${Date.now()}`,
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
      changedBy: req.authUser?.loginId || 'admin',
      notes: `Removed ceiling price record (was ₹${target.ceilingPrice.toFixed(2)}).`,
      timestamp: new Date().toISOString(),
    });
    db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
    saveDb(db);
    res.json({ ok: true });
  });

  // --- Retail Prices (Post 16 July 2026 · Form 1A · 1-year Retention) ---
  app.get('/api/retail-prices', requireAuth, (_req, res) => {
    const db = loadDb();
    const now = new Date();
    const enriched = db.retailPrices
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
  });

  app.post('/api/retail-prices', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const body = req.body as Partial<RetailPriceEntry>;
    if (!body.notificationNumber || !body.notificationDate || !body.formulation || body.retailPrice == null) {
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
    const db = loadDb();
    const item: RetailPriceEntry = {
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
    };
    db.retailPrices.unshift(item);
    recordSoTracking(db, {
      soNumber: item.notificationNumber,
      soDate: item.notificationDate,
      sourceType: 'manual_entry',
      sourceUrl: item.sourceUrl,
      ceilingCount: 0,
      retailCount: 1,
      importedBy: req.authUser?.loginId || 'admin',
      notes: `Added Form 1A retail price for ${item.formulation}.`,
    });
    saveDb(db);
    res.status(201).json({ item });
  });

  app.put('/api/retail-prices/:id', requireAuth, requireAdmin, (req, res) => {
    const db = loadDb();
    const idx = db.retailPrices.findIndex((r) => r.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Retail price record not found.' });
      return;
    }
    const patch = req.body as Partial<RetailPriceEntry>;
    db.retailPrices[idx] = {
      ...db.retailPrices[idx],
      ...patch,
      retailPrice:
        patch.retailPrice != null ? Number(patch.retailPrice) : db.retailPrices[idx].retailPrice,
    };
    saveDb(db);
    res.json({ item: db.retailPrices[idx] });
  });

  app.delete('/api/retail-prices/:id', requireAuth, requireAdmin, (req, res) => {
    const db = loadDb();
    const before = db.retailPrices.length;
    db.retailPrices = db.retailPrices.filter((r) => r.id !== req.params.id);
    if (db.retailPrices.length === before) {
      res.status(404).json({ error: 'Retail price record not found.' });
      return;
    }
    saveDb(db);
    res.json({ ok: true });
  });

  app.post('/api/retail-prices/purge-expired', requireAuth, requireAdmin, (_req, res) => {
    const db = loadDb();
    const now = new Date();
    const before = db.retailPrices.length;
    db.retailPrices = db.retailPrices.filter((r) => {
      const expiry = new Date(`${r.notificationDate}T00:00:00Z`);
      expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
      return expiry >= now;
    });
    const purged = before - db.retailPrices.length;
    saveDb(db);
    res.json({ purged });
  });

  // --- NPPA Circulars, Authority Minutes & Expert Committee Logs ---
  app.get('/api/nppa-logs', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json({ items: db.nppaLogs, syncLogs: db.syncLogs });
  });

  app.post('/api/nppa-logs/sync', requireAuth, async (_req, res) => {
    const syncResult = await runNppaSync('manual');
    const db = loadDb();
    res.json({ syncResult, items: db.nppaLogs, syncLogs: db.syncLogs });
  });

  app.post('/api/nppa-logs/parse-notification', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { rawText, notificationNumber, notificationDate, defaultKind } = req.body as {
      rawText?: string;
      notificationNumber?: string;
      notificationDate?: string;
      defaultKind?: 'auto' | 'ceiling' | 'retail';
    };
    if (!rawText || !rawText.trim()) {
      res.status(400).json({ error: 'Notification text is required to parse formulations and prices.' });
      return;
    }
    const result = parseAndApplyNotificationText(rawText, {
      notificationNumber,
      notificationDate,
      defaultKind: defaultKind || 'auto',
      source: 'notification_parser',
      changedBy: req.authUser?.loginId || 'admin',
    });
    res.json({ result });
  });

  app.post('/api/nppa-logs', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as Partial<NppaDocumentLog>;
    if (!body.title || !body.sourceType) {
      res.status(400).json({ error: 'title and sourceType are required.' });
      return;
    }
    const db = loadDb();
    const item: NppaDocumentLog = {
      id: `doc-${Date.now()}`,
      sourceType: body.sourceType,
      title: body.title.trim(),
      referenceNumber: (body.referenceNumber || 'NPPA Notice').trim(),
      publishedDate: body.publishedDate || new Date().toISOString().slice(0, 10),
      summary: (body.summary || '').trim(),
      url: body.url || NPPA_URLS[body.sourceType],
      fetchedAt: new Date().toISOString(),
      isLiveFetched: false,
    };
    db.nppaLogs.unshift(item);
    saveDb(db);
    res.status(201).json({ item });
  });

  app.delete('/api/nppa-logs/:id', requireAuth, requireAdmin, (req, res) => {
    const db = loadDb();
    const before = db.nppaLogs.length;
    db.nppaLogs = db.nppaLogs.filter((d) => d.id !== req.params.id);
    if (db.nppaLogs.length === before) {
      res.status(404).json({ error: 'Document log not found.' });
      return;
    }
    saveDb(db);
    res.json({ ok: true });
  });

  // --- S.O. Tracking Ledger & NPPA PDF Download / Conversion ---
  app.get('/api/so-tracking', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json({ items: db.soTrackingRecords || [] });
  });

  app.get('/api/nppa-logs/:id/download-pdf', requireAuth, async (req, res) => {
    const db = loadDb();
    const log = db.nppaLogs.find((d) => d.id === req.params.id);
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
        log.pdfUrl = resolvedUrl;
        saveDb(db);
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to download NPPA PDF.';
      res.status(422).json({ error: message });
    }
  });

  app.post('/api/nppa-logs/:id/convert-pdf', requireAuth, requireAdmin, async (req, res) => {
    const db = loadDb();
    const log = db.nppaLogs.find((d) => d.id === req.params.id);
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
        log.pdfUrl = resolvedUrl;
        saveDb(db);
      }
      const result = await aiConvertPdfToComplianceData({
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
      const result = await aiConvertPdfToComplianceData({
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
  app.get('/api/nlem2022', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json({ items: db.nlem2022 });
  });

  app.post('/api/nlem2022', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as Partial<Nlem2022Entry>;
    if (!body.medicineName || !body.dosageForms || body.dosageForms.length === 0) {
      res.status(400).json({ error: 'medicineName and at least one dosageForm are required.' });
      return;
    }
    const db = loadDb();
    const item: Nlem2022Entry = {
      id: `nlem-${Date.now()}`,
      medicineName: body.medicineName.trim(),
      aliases: body.aliases || [],
      therapeuticCategory: (body.therapeuticCategory || 'Essential Medicines').trim(),
      sectionCode: (body.sectionCode || 'NLEM 2022').trim(),
      dosageForms: body.dosageForms,
      notes: body.notes,
    };
    db.nlem2022.unshift(item);
    saveDb(db);
    res.status(201).json({ item });
  });

  app.delete('/api/nlem2022/:id', requireAuth, requireAdmin, (req, res) => {
    const db = loadDb();
    const before = db.nlem2022.length;
    db.nlem2022 = db.nlem2022.filter((n) => n.id !== req.params.id);
    if (db.nlem2022.length === before) {
      res.status(404).json({ error: 'NLEM entry not found.' });
      return;
    }
    saveDb(db);
    res.json({ ok: true });
  });

  app.post('/api/form1-check', requireAuth, (req, res) => {
    const { productName, dosageForm, compositionText } = req.body as {
      productName?: string;
      dosageForm?: string;
      compositionText?: string;
    };
    if (!compositionText || !compositionText.trim()) {
      res.status(400).json({ error: 'Please enter the product composition to check Form I applicability.' });
      return;
    }
    const db = loadDb();
    const result = evaluateForm1Applicability(
      {
        productName: productName || 'Proposed New Formulation',
        dosageForm: dosageForm || 'Tablet',
        compositionText: compositionText.trim(),
      },
      db.nlem2022,
      db.companyProfile
    );
    res.json({ result });
  });

  // --- Company Profile ---
  app.get('/api/company', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json({ company: db.companyProfile });
  });

  app.put('/api/company', requireAuth, (req, res) => {
    const patch = req.body as Partial<CompanyProfile>;
    const db = loadDb();
    db.companyProfile = {
      ...db.companyProfile,
      ...patch,
      existingFormulations:
        patch.existingFormulations ?? db.companyProfile.existingFormulations,
      updatedAt: new Date().toISOString(),
    };
    saveDb(db);
    res.json({ company: db.companyProfile });
  });

  // --- Admin: Allowed Login IDs Management ---
  app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
    const db = loadDb();
    res.json({ users: db.users.map(toPublicUser) });
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
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
    const db = loadDb();
    const exists = db.users.some(
      (u) => u.loginId.toLowerCase() === loginId.trim().toLowerCase()
    );
    if (exists) {
      res.status(409).json({ error: 'This Login ID is already registered.' });
      return;
    }
    const created = {
      id: `usr-${Date.now()}`,
      loginId: loginId.trim(),
      fullName: fullName.trim(),
      department: (department || 'Regulatory Affairs').trim(),
      role: role === 'admin' ? ('admin' as const) : ('user' as const),
      passwordHash: hashPassword(password),
      active: true,
      createdAt: new Date().toISOString(),
    };
    db.users.push(created);
    saveDb(db);
    res.status(201).json({ user: toPublicUser(created) });
  });

  app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const db = loadDb();
    const target = db.users.find((u) => u.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const { fullName, department, role, active, password } = req.body as {
      fullName?: string;
      department?: string;
      role?: 'admin' | 'user';
      active?: boolean;
      password?: string;
    };
    if (target.id === req.authUser?.id && active === false) {
      res.status(400).json({ error: 'You cannot deactivate your own active admin session.' });
      return;
    }
    if (fullName !== undefined) target.fullName = fullName.trim();
    if (department !== undefined) target.department = department.trim();
    if (role !== undefined) target.role = role === 'admin' ? 'admin' : 'user';
    if (active !== undefined) target.active = Boolean(active);
    if (password && password.trim()) target.passwordHash = hashPassword(password.trim());
    saveDb(db);
    res.json({ user: toPublicUser(target) });
  });

  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const db = loadDb();
    if (req.params.id === req.authUser?.id) {
      res.status(400).json({ error: 'You cannot delete the currently signed-in admin account.' });
      return;
    }
    const before = db.users.length;
    db.users = db.users.filter((u) => u.id !== req.params.id);
    if (db.users.length === before) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    saveDb(db);
    res.json({ ok: true });
  });

  // --- Unified Cross-Registry Search ---
  app.get('/api/search', requireAuth, (req, res) => {
    const rawQuery = String(req.query.q || '').trim();
    const categoryFilter = String(req.query.category || 'all').trim() as
      | 'all'
      | SearchResultCategory;

    if (!rawQuery) {
      res.json({ query: '', total: 0, results: [] });
      return;
    }

    const db = loadDb();
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
      for (const c of db.ceilingPrices) {
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
      for (const r of db.retailPrices) {
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
      for (const n of db.nlem2022) {
        const strengths = n.dosageForms.map((d) => `${d.dosageForm} ${d.strength}`).join(' ');
        const hay = `${n.medicineName} ${(n.aliases || []).join(' ')} ${n.therapeuticCategory} ${n.sectionCode} ${strengths}`;
        if (matchesAll(hay)) {
          results.push({
            id: `sr-nlem-${n.id}`,
            category: 'nlem',
            title: `${n.medicineName} (NLEM 2022)`,
            subtitle: `Sec ${n.sectionCode} · ${n.therapeuticCategory}`,
            meta: n.dosageForms.map((d) => `${d.dosageForm} ${d.strength}`).slice(0, 4).join(', '),
            tabTarget: 'new_product',
            searchKeyword: n.medicineName,
          });
        }
      }
    }

    if (categoryFilter === 'all' || categoryFilter === 'nppa_log') {
      for (const d of db.nppaLogs) {
        const hay = `${d.title} ${d.referenceNumber} ${d.summary} ${d.sourceType} ${d.publishedDate}`;
        if (matchesAll(hay)) {
          results.push({
            id: `sr-log-${d.id}`,
            category: 'nppa_log',
            title: d.title,
            subtitle: d.summary || d.sourceType,
            meta: `${d.referenceNumber} · ${d.publishedDate}`,
            tabTarget: 'schedule_formulations',
            searchKeyword: '',
          });
        }
      }
    }

    if (categoryFilter === 'all' || categoryFilter === 'history') {
      for (const h of db.ceilingPriceHistory) {
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

  app.post('/api/ai/apply-extracted-rows', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
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

    const db = loadDb();
    const nowIso = new Date().toISOString();
    const actor = req.authUser?.loginId || 'admin';
    const overrideSoNo = soNumber?.trim() || '';
    const overrideSoDate = soDate?.trim() || '';
    let ceilingAdded = 0;
    let ceilingRevised = 0;
    let retailAdded = 0;
    const perSoSummary = new Map<string, { soNumber: string; soDate: string; ceiling: number; retail: number }>();

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
        const duplicate = db.retailPrices.some(
          (r) =>
            r.notificationNumber.toLowerCase() === effectiveSoNo.toLowerCase() &&
            r.formulation.toLowerCase().includes(row.medicineName.toLowerCase())
        );
        if (!duplicate) {
          db.retailPrices.unshift({
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
          retailAdded += 1;
          trackBucket(effectiveSoNo, notifDate, 'retail');
        }
      } else {
        const existingIdx = db.ceilingPrices.findIndex(
          (c) =>
            c.medicineName.toLowerCase() === row.medicineName.toLowerCase() &&
            c.strength.toLowerCase().replace(/\s+/g, '') ===
              row.strength.toLowerCase().replace(/\s+/g, '') &&
            c.dosageFormat.toLowerCase() === row.dosageFormat.toLowerCase()
        );
        if (existingIdx >= 0) {
          const prev = db.ceilingPrices[existingIdx];
          db.ceilingPrices[existingIdx] = {
            ...prev,
            ceilingPrice: row.price,
            notificationNumber: effectiveSoNo,
            notificationDate: effectiveSoDate,
            effectiveDate: effectiveSoDate,
            sourceUrl: sourceUrl || prev.sourceUrl,
            updatedAt: nowIso,
          };
          db.ceilingPriceHistory.unshift({
            id: `cph-ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            ceilingPriceId: prev.id,
            medicineName: prev.medicineName,
            strength: prev.strength,
            dosageFormat: prev.dosageFormat,
            changeType: 'revised',
            previousCeilingPrice: prev.ceilingPrice,
            newCeilingPrice: row.price,
            notificationNumber: effectiveSoNo,
            notificationDate: effectiveSoDate,
            source: 'notification_parser',
            changedBy: `${actor} (PDF/AI Extract)`,
            notes: `Extracted revision from ₹${prev.ceilingPrice.toFixed(2)} to ₹${row.price.toFixed(2)} (${effectiveSoNo}).`,
            timestamp: nowIso,
          });
          ceilingRevised += 1;
          trackBucket(effectiveSoNo, effectiveSoDate, 'ceiling');
        } else {
          const created: CeilingPriceEntry = {
            id: `cp-ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
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
          };
          db.ceilingPrices.unshift(created);
          db.ceilingPriceHistory.unshift({
            id: `cph-ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            ceilingPriceId: created.id,
            medicineName: created.medicineName,
            strength: created.strength,
            dosageFormat: created.dosageFormat,
            changeType: 'created',
            previousCeilingPrice: null,
            newCeilingPrice: created.ceilingPrice,
            notificationNumber: created.notificationNumber,
            notificationDate: created.notificationDate,
            source: 'notification_parser',
            changedBy: `${actor} (PDF/AI Extract)`,
            notes: `Extracted ceiling price ₹${created.ceilingPrice.toFixed(2)} (${created.notificationNumber}).`,
            timestamp: nowIso,
          });
          ceilingAdded += 1;
          trackBucket(effectiveSoNo, effectiveSoDate, 'ceiling');
        }
      }
    }

    let lastSoRecord: SoTrackingRecord | null = null;
    for (const bucket of perSoSummary.values()) {
      lastSoRecord = recordSoTracking(db, {
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
      const logEntry = db.nppaLogs.find((d) => d.id === logId);
      if (logEntry) {
        logEntry.soImportedAt = nowIso;
        logEntry.importedEntryCount =
          (logEntry.importedEntryCount || 0) + ceilingAdded + ceilingRevised + retailAdded;
      }
    }

    db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
    saveDb(db);
    res.json({ ceilingAdded, ceilingRevised, retailAdded, soRecord: lastSoRecord });
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
  app.get('/api/calendar', requireAuth, (_req, res) => {
    const db = loadDb();
    res.json(buildComplianceCalendar(db));
  });

  app.post('/api/calendar', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
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
    const db = loadDb();
    const item: CustomCalendarEvent = {
      id: `cal-custom-${Date.now()}`,
      title: title.trim(),
      date: date.trim(),
      category: category || 'custom_deadline',
      referenceNumber: (referenceNumber || 'Internal Notice').trim(),
      notes: (notes || '').trim(),
      createdBy: req.authUser?.loginId || 'admin',
      createdAt: new Date().toISOString(),
    };
    db.customCalendarEvents.unshift(item);
    saveDb(db);
    res.status(201).json({ item, calendar: buildComplianceCalendar(db) });
  });

  app.delete('/api/calendar/:id', requireAuth, requireAdmin, (req, res) => {
    const db = loadDb();
    const before = db.customCalendarEvents.length;
    db.customCalendarEvents = db.customCalendarEvents.filter((e) => e.id !== req.params.id);
    if (db.customCalendarEvents.length === before) {
      res.status(404).json({ error: 'Custom calendar event not found.' });
      return;
    }
    saveDb(db);
    res.json({ ok: true, calendar: buildComplianceCalendar(db) });
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
