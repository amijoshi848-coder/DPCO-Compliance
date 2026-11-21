import * as cheerio from 'cheerio';
import { aiConvertPdfToComplianceData } from './aiCompliance.ts';
import type {
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  NppaDocumentLog,
  NppaSourceType,
  RetailPriceEntry,
  SoTrackingRecord,
  SyncLogEntry,
} from '../src/types/compliance.ts';
import { type DatabaseState, loadDb, saveDb } from './storage.ts';

export const NPPA_URLS = {
  circular: 'https://nppa.gov.in/en/view_more?id=4',
  authority_minutes: 'https://nppa.gov.in/en/year2026-2027',
  expert_committee: 'https://nppa.gov.in/en/expertscommittee',
} as const;

const MONTH_MAP: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

function parseIndianDateToIso(raw: string): string | null {
  const cleaned = raw.trim();
  const iso = cleaned.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const dmy = cleaned.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    const yyyy = dmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  const textMonth = cleaned.match(
    /\b(\d{1,2})[\s-]+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december),?[\s-]+(20\d{2})\b/i
  );
  if (textMonth) {
    const dd = textMonth[1].padStart(2, '0');
    const mm = MONTH_MAP[textMonth[2].toLowerCase()];
    const yyyy = textMonth[3];
    if (mm) return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function isPdfBadgeText(text: string): boolean {
  return /^[\d.]+\s*(?:KB|MB|GB)\s*(?:\/|\s)+PDF/i.test(text.trim());
}

function extractRefNumber(text: string, dateHint?: string): string {
  const soMatch = text.match(/\bS\.O\.?\s*\d+\s*\(E\)/i);
  if (soMatch) return soMatch[0].replace(/\s+/g, ' ').trim();
  const authMatch = text.match(/(\d+(?:st|nd|rd|th))[^.\n]{0,40}\bAuthority\b/i);
  if (authMatch) return `${authMatch[1]} Authority Meeting`;
  const mdcMatch = text.match(/(\d+(?:st|nd|rd|th))[^.\n]{0,45}\b(Multidisciplinary Committee|MDC|Expert)\b/i);
  if (mdcMatch) return `${mdcMatch[1]} MDC Meeting`;
  const fnoMatch = text.match(/\bF\.?\s*No\.?\s*[A-Za-z0-9\-/]+/i);
  if (fnoMatch) return fnoMatch[0].trim();
  if (dateHint) return `Notice (${dateHint})`;
  return 'NPPA Notice';
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

export interface ParsedNotificationSummary {
  ceilingAdded: number;
  ceilingRevised: number;
  retailAdded: number;
  parsedItems: Array<{
    kind: 'ceiling' | 'retail';
    medicineOrFormulation: string;
    strength: string;
    dosageFormat: string;
    price: number;
    previousPrice?: number | null;
    notificationNumber: string;
    notificationDate: string;
  }>;
}

const DOSAGE_FORMATS = [
  'Powder for Injection',
  'Respirator Solution',
  'Dispersible Tablet',
  'SR Tablet',
  'ER Tablet',
  'Oral Solution',
  'Oral Liquid',
  'Eye Drops',
  'Tablet',
  'Capsule',
  'Injection',
  'Inhaler',
  'Syrup',
  'Suspension',
  'Ointment',
  'Cream',
  'Drops',
  'Suppository',
];

export function recordSoTracking(
  db: DatabaseState,
  params: {
    soNumber: string;
    soDate: string;
    sourceType: SoTrackingRecord['sourceType'];
    sourceFileName?: string;
    sourceUrl?: string;
    ceilingCount?: number;
    retailCount?: number;
    importedBy: string;
    notes?: string;
  }
): SoTrackingRecord {
  const soNumber = params.soNumber.trim() || 'S.O. Unspecified';
  const soDate = params.soDate.trim() || new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const cAdd = Math.max(0, params.ceilingCount || 0);
  const rAdd = Math.max(0, params.retailCount || 0);

  if (!Array.isArray(db.soTrackingRecords)) {
    db.soTrackingRecords = [];
  }

  const existingIdx = db.soTrackingRecords.findIndex(
    (rec) =>
      rec.soNumber.toLowerCase() === soNumber.toLowerCase() &&
      rec.soDate === soDate
  );

  if (existingIdx !== -1) {
    const prev = db.soTrackingRecords[existingIdx];
    const updated: SoTrackingRecord = {
      ...prev,
      sourceType: params.sourceType || prev.sourceType,
      sourceFileName: params.sourceFileName || prev.sourceFileName,
      sourceUrl: params.sourceUrl || prev.sourceUrl,
      ceilingCount: prev.ceilingCount + cAdd,
      retailCount: prev.retailCount + rAdd,
      importedBy: params.importedBy,
      importedAt: nowIso,
      notes: params.notes || prev.notes,
    };
    db.soTrackingRecords[existingIdx] = updated;
    db.soTrackingRecords.sort((a, b) => b.soDate.localeCompare(a.soDate));
    return updated;
  }

  const created: SoTrackingRecord = {
    id: `so-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    soNumber,
    soDate,
    sourceType: params.sourceType,
    sourceFileName: params.sourceFileName,
    sourceUrl: params.sourceUrl,
    ceilingCount: cAdd,
    retailCount: rAdd,
    importedBy: params.importedBy,
    importedAt: nowIso,
    notes: params.notes,
  };
  db.soTrackingRecords.unshift(created);
  db.soTrackingRecords.sort((a, b) => b.soDate.localeCompare(a.soDate));
  return created;
}

export function parseAndApplyNotificationText(
  rawText: string,
  options: {
    notificationNumber?: string;
    notificationDate?: string;
    defaultKind?: 'auto' | 'ceiling' | 'retail';
    source: CeilingPriceHistoryEntry['source'];
    changedBy: string;
    sourceUrl?: string;
  }
): ParsedNotificationSummary {
  const db = loadDb();
  const notifNo =
    options.notificationNumber?.trim() || extractRefNumber(rawText) || `S.O. ${Math.floor(4900 + Math.random() * 90)}(E)`;
  const notifDate =
    options.notificationDate?.trim() ||
    parseIndianDateToIso(rawText) ||
    new Date().toISOString().slice(0, 10);

  const lines = rawText
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter((l) => l.length > 6);

  const summary: ParsedNotificationSummary = {
    ceilingAdded: 0,
    ceilingRevised: 0,
    retailAdded: 0,
    parsedItems: [],
  };

  for (const line of lines) {
    // Match price e.g. Rs. 19.45, ₹19.45, INR 19.45, or trailing decimal price
    const priceMatch = line.match(
      /(?:Rs\.?|₹|INR)\s*(\d+(?:\.\d{1,2})?)|\bprice[:\s-]+(\d+(?:\.\d{1,2})?)/i
    );
    if (!priceMatch) continue;
    const price = Number(priceMatch[1] || priceMatch[2]);
    if (!Number.isFinite(price) || price <= 0) continue;

    // Detect dosage format
    let dosageFormat = 'Tablet';
    for (const fmt of DOSAGE_FORMATS) {
      if (new RegExp(`\\b${fmt.replace(/\s+/g, '\\s+')}\\b`, 'i').test(line)) {
        dosageFormat = fmt;
        break;
      }
    }

    // Extract strength (e.g. 10mg, 500mg + 125mg, 40 IU/ml, 0.3%)
    const strengthMatches = line.match(
      /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|g|gm|ml|iu|%)(?:\s*\/\s*\d*\s*(?:ml|dose))?/gi
    );
    const strength = strengthMatches ? strengthMatches.join(' + ') : 'Standard';

    // Determine whether this is Retail Price or Ceiling Price
    const isRetail =
      options.defaultKind === 'retail' ||
      (options.defaultKind !== 'ceiling' &&
        (/retail\s*price|form\s*1a|\+/i.test(line) || (strengthMatches && strengthMatches.length > 1)));

    // Extract clean formulation / medicine name by stripping price & trailing tags
    const cleanedDesc = line
      .replace(/(?:Rs\.?|₹|INR)\s*\d+(?:\.\d{1,2})?.*$/i, '')
      .replace(/\bprice[:\s-]+\d+(?:\.\d{1,2})?.*$/i, '')
      .replace(/^[\d.)\s-]+/, '')
      .trim();

    if (!cleanedDesc) continue;

    if (isRetail) {
      if (notifDate <= '2026-07-16') continue;
      const exists = db.retailPrices.some(
        (r) =>
          r.notificationNumber.toLowerCase() === notifNo.toLowerCase() &&
          r.formulation.toLowerCase() === cleanedDesc.toLowerCase()
      );
      if (!exists) {
        const rpEntry: RetailPriceEntry = {
          id: `rp-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          notificationNumber: notifNo,
          notificationDate: notifDate,
          formulation: cleanedDesc,
          composition: cleanedDesc,
          strength,
          dosageFormat,
          unitLabel: `1 ${dosageFormat}`,
          retailPrice: price,
          applicantCompany: 'NPPA Notified Retail Price (Form 1A)',
          sourceUrl: options.sourceUrl || NPPA_URLS.circular,
          createdAt: new Date().toISOString(),
        };
        db.retailPrices.unshift(rpEntry);
        summary.retailAdded += 1;
        summary.parsedItems.push({
          kind: 'retail',
          medicineOrFormulation: cleanedDesc,
          strength,
          dosageFormat,
          price,
          notificationNumber: notifNo,
          notificationDate: notifDate,
        });
      }
      continue;
    }

    // Ceiling Price matching by medicine name + strength + dosage format
    const medicineName = cleanedDesc
      .replace(new RegExp(`\\b${dosageFormat}\\b`, 'gi'), '')
      .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|g|gm|ml|iu|%)(?:\s*\/\s*\d*\s*(?:ml|dose))?/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || cleanedDesc;

    const existingIdx = db.ceilingPrices.findIndex(
      (c) =>
        c.medicineName.toLowerCase() === medicineName.toLowerCase() &&
        c.strength.toLowerCase().replace(/\s+/g, '') === strength.toLowerCase().replace(/\s+/g, '') &&
        c.dosageFormat.toLowerCase() === dosageFormat.toLowerCase()
    );

    const nowIso = new Date().toISOString();
    if (existingIdx !== -1) {
      const prev = db.ceilingPrices[existingIdx];
      const prevPrice = prev.ceilingPrice;
      db.ceilingPrices[existingIdx] = {
        ...prev,
        ceilingPrice: price,
        notificationNumber: notifNo,
        notificationDate: notifDate,
        effectiveDate: notifDate,
        updatedAt: nowIso,
      };
      const hist: CeilingPriceHistoryEntry = {
        id: `cph-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        ceilingPriceId: prev.id,
        medicineName: prev.medicineName,
        strength: prev.strength,
        dosageFormat: prev.dosageFormat,
        changeType: 'revised',
        previousCeilingPrice: prevPrice,
        newCeilingPrice: price,
        notificationNumber: notifNo,
        notificationDate: notifDate,
        source: options.source,
        changedBy: options.changedBy,
        notes: `Ceiling price updated from ₹${prevPrice.toFixed(2)} to ₹${price.toFixed(2)} via ${notifNo}.`,
        timestamp: nowIso,
      };
      db.ceilingPriceHistory.unshift(hist);
      summary.ceilingRevised += 1;
      summary.parsedItems.push({
        kind: 'ceiling',
        medicineOrFormulation: prev.medicineName,
        strength: prev.strength,
        dosageFormat: prev.dosageFormat,
        price,
        previousPrice: prevPrice,
        notificationNumber: notifNo,
        notificationDate: notifDate,
      });
    } else {
      const newEntry: CeilingPriceEntry = {
        id: `cp-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        medicineName,
        composition: cleanedDesc,
        strength,
        dosageFormat,
        unitLabel: `1 ${dosageFormat}`,
        ceilingPrice: price,
        notificationNumber: notifNo,
        notificationDate: notifDate,
        effectiveDate: notifDate,
        nlemSection: 'NLEM 2022',
        gstDefault: 12,
        sourceUrl: options.sourceUrl || NPPA_URLS.circular,
        updatedAt: nowIso,
      };
      db.ceilingPrices.unshift(newEntry);
      const hist: CeilingPriceHistoryEntry = {
        id: `cph-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        ceilingPriceId: newEntry.id,
        medicineName: newEntry.medicineName,
        strength: newEntry.strength,
        dosageFormat: newEntry.dosageFormat,
        changeType: 'created',
        previousCeilingPrice: null,
        newCeilingPrice: price,
        notificationNumber: notifNo,
        notificationDate: notifDate,
        source: options.source,
        changedBy: options.changedBy,
        notes: `New ceiling price ₹${price.toFixed(2)} added from ${notifNo}.`,
        timestamp: nowIso,
      };
      db.ceilingPriceHistory.unshift(hist);
      summary.ceilingAdded += 1;
      summary.parsedItems.push({
        kind: 'ceiling',
        medicineOrFormulation: newEntry.medicineName,
        strength: newEntry.strength,
        dosageFormat: newEntry.dosageFormat,
        price,
        previousPrice: null,
        notificationNumber: notifNo,
        notificationDate: notifDate,
      });
    }
  }

  if (summary.ceilingAdded + summary.ceilingRevised + summary.retailAdded > 0) {
    recordSoTracking(db, {
      soNumber: notifNo,
      soDate: notifDate,
      sourceType:
        options.source === 'scheduled_10am_ist' || options.source === 'manual_sync'
          ? 'daily_nppa_sync'
          : 'manual_entry',
      sourceUrl: options.sourceUrl,
      ceilingCount: summary.ceilingAdded + summary.ceilingRevised,
      retailCount: summary.retailAdded,
      importedBy: options.changedBy,
      notes: `Notification parsed (${summary.ceilingAdded} ceiling added, ${summary.ceilingRevised} revised, ${summary.retailAdded} retail).`,
    });
  }

  db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
  saveDb(db);
  return summary;
}

async function fetchNppaPage(
  url: string,
  sourceType: NppaSourceType
): Promise<{ ok: boolean; docs: NppaDocumentLog[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return { ok: false, docs: [], error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const docs: NppaDocumentLog[] = [];
    const seenKeys = new Set<string>();
    const nowIso = new Date().toISOString();

    // Primary structured table parser (matches all 3 official NPPA portal table layouts)
    $('table tr').each((_idx, tr) => {
      if (docs.length >= 25) return;
      const $tr = $(tr);
      const $tds = $tr.find('td');
      if ($tds.length === 0) return;

      const cells = $tds
        .map((_, td) => $(td).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);

      if (cells.length === 0) return;

      const pdfAnchorHref = $tr.find('a[href*=".pdf" i]').first().attr('href') || '';
      const firstHref = $tr.find('a').first().attr('href') || '';
      const resolvedPdfUrl = pdfAnchorHref
        ? resolveUrl(pdfAnchorHref, url)
        : firstHref.toLowerCase().includes('.pdf')
          ? resolveUrl(firstHref, url)
          : undefined;
      const resolvedPrimary = resolvedPdfUrl || (firstHref ? resolveUrl(firstHref, url) : url);

      let parsedDate: string | null = null;
      for (const cell of cells) {
        const d = parseIndianDateToIso(cell);
        if (d) {
          parsedDate = d;
          break;
        }
      }

      // Pick the descriptive Title / Document Name cell (exclude serial numbers, pure dates, and PDF size badges)
      const titleCandidates = cells.filter(
        (c) =>
          !/^\d{1,4}$/.test(c) &&
          !isPdfBadgeText(c) &&
          !(parseIndianDateToIso(c) && c.length <= 16)
      );

      const title =
        titleCandidates.sort((a, b) => b.length - a.length)[0] ||
        cells.join(' — ');

      if (!title || title.length < 8 || title.length > 350 || isPdfBadgeText(title)) return;
      if (/^(sr\.?\s*no|date|title|document name|download|attachment)/i.test(title)) return;

      const rowText = cells.join(' ');
      if (!parsedDate) {
        parsedDate = parseIndianDateToIso(rowText) || nowIso.slice(0, 10);
      }

      const dedupKey = (resolvedPdfUrl || `${title}|${parsedDate}`).toLowerCase();
      if (seenKeys.has(dedupKey)) return;
      seenKeys.add(dedupKey);

      docs.push({
        id: `live-${sourceType}-${Buffer.from(dedupKey).toString('base64url').slice(0, 18)}`,
        sourceType,
        title,
        referenceNumber: extractRefNumber(rowText, parsedDate),
        publishedDate: parsedDate,
        summary: resolvedPdfUrl
          ? `Live NPPA notification (${parsedDate}) with direct PDF attachment.`
          : `Fetched live from NPPA portal (${url}).`,
        url: resolvedPrimary,
        pdfUrl: resolvedPdfUrl,
        fetchedAt: nowIso,
        isLiveFetched: true,
      });
    });

    // Fallback for non-table CMS list layouts if no table rows existed
    if (docs.length === 0) {
      $('.views-row, .item-list li, main a, .view-content a').each((_idx, el) => {
        if (docs.length >= 20) return;
        const $el = $(el);
        const isAnchor = el.tagName === 'a';
        const anchor = isAnchor ? $el : $el.find('a').first();
        const href = anchor.attr('href') || '';
        const rowText = $el.text().replace(/\s+/g, ' ').trim();
        const linkText = anchor.text().replace(/\s+/g, ' ').trim();
        const title =
          linkText.length >= 14 && !isPdfBadgeText(linkText) ? linkText : rowText;

        if (!title || title.length < 14 || title.length > 280 || isPdfBadgeText(title)) return;
        if (/^(home|about|contact|skip to|screen reader|archive|login|search)/i.test(title)) return;

        const looksRelevant =
          /ceiling|retail|price|s\.o\.|minutes|meeting|committee|nlem|dpco|notification|circular|form/i.test(
            title + ' ' + href
          ) || href.toLowerCase().includes('.pdf');

        if (!looksRelevant) return;
        const dedupKey = title.toLowerCase();
        if (seenKeys.has(dedupKey)) return;
        seenKeys.add(dedupKey);

        const parsedDate =
          parseIndianDateToIso(rowText) ||
          parseIndianDateToIso(title) ||
          nowIso.slice(0, 10);

        const resolvedPrimary = href ? resolveUrl(href, url) : url;
        const resolvedPdfUrl = href.toLowerCase().includes('.pdf') ? resolvedPrimary : undefined;

        docs.push({
          id: `live-${sourceType}-${Buffer.from(title).toString('base64url').slice(0, 18)}`,
          sourceType,
          title,
          referenceNumber: extractRefNumber(rowText, parsedDate),
          publishedDate: parsedDate,
          summary: `Fetched live from NPPA portal (${url}).`,
          url: resolvedPrimary,
          pdfUrl: resolvedPdfUrl,
          fetchedAt: nowIso,
          isLiveFetched: true,
        });
      });
    }

    return { ok: true, docs };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { ok: false, docs: [], error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function runNppaSync(
  triggeredBy: 'scheduled_10am_ist' | 'manual'
): Promise<SyncLogEntry> {
  const db = loadDb();

  const [circRes, authRes, expRes] = await Promise.all([
    fetchNppaPage(NPPA_URLS.circular, 'circular'),
    fetchNppaPage(NPPA_URLS.authority_minutes, 'authority_minutes'),
    fetchNppaPage(NPPA_URLS.expert_committee, 'expert_committee'),
  ]);

  const fetchedAll = [...circRes.docs, ...authRes.docs, ...expRes.docs];
  const existingKeys = new Set(
    db.nppaLogs.map((d) => (d.pdfUrl || `${d.title}|${d.publishedDate}`).toLowerCase())
  );
  const existingTitles = new Set(db.nppaLogs.map((d) => d.title.toLowerCase()));
  let newlyAdded = 0;
  let newCeilingPricesFound = 0;
  let newRetailPricesFound = 0;
  let pdfsAutoConverted = 0;
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());

  for (const doc of fetchedAll) {
    const key = (doc.pdfUrl || `${doc.title}|${doc.publishedDate}`).toLowerCase();
    if (!existingKeys.has(key) && !existingTitles.has(doc.title.toLowerCase())) {
      db.nppaLogs.unshift(doc);
      existingKeys.add(key);
      existingTitles.add(doc.title.toLowerCase());
      newlyAdded += 1;

      if (doc.sourceType === 'circular') {
        const parsed = parseAndApplyNotificationText(doc.title, {
          notificationNumber: doc.referenceNumber,
          notificationDate: doc.publishedDate,
          source: triggeredBy === 'scheduled_10am_ist' ? 'scheduled_10am_ist' : 'manual_sync',
          changedBy:
            triggeredBy === 'scheduled_10am_ist'
              ? 'NPPA 10:00 AM IST Scheduler'
              : 'Manual NPPA Sync',
          sourceUrl: doc.pdfUrl || doc.url,
        });
        newCeilingPricesFound += parsed.ceilingAdded + parsed.ceilingRevised;
        newRetailPricesFound += parsed.retailAdded;

        // If pricing notification has a PDF and Gemini is configured, auto-extract up to 3 pricing PDFs per sync
        const looksLikePriceNotification =
          /ceiling\s*price|retail\s*price|price\s*fixation|\bs\.o\.\b|new\s*drug/i.test(
            doc.title
          );
        if (hasGeminiKey && doc.pdfUrl && looksLikePriceNotification && pdfsAutoConverted < 3) {
          try {
            const { buffer, fileName } = await downloadNppaPdfBuffer(
              doc.pdfUrl,
              doc.referenceNumber
            );
            const pdfData = await aiConvertPdfToComplianceData({
              pdfBase64: buffer.toString('base64'),
              fileName,
              fallbackSoNumber: doc.referenceNumber,
              fallbackSoDate: doc.publishedDate,
              defaultKind: /retail\s*price/i.test(doc.title) ? 'retail' : 'auto',
            });
            if (pdfData.rows.length > 0) {
              const nowIso = new Date().toISOString();
              const actor =
                triggeredBy === 'scheduled_10am_ist'
                  ? 'NPPA 10:00 AM IST Scheduler (Auto PDF)'
                  : 'Manual NPPA Sync (Auto PDF)';
              let cAdd = 0;
              let cRev = 0;
              let rAdd = 0;
              for (const row of pdfData.rows) {
                const effSo = pdfData.soNumber || row.notificationNumber || doc.referenceNumber;
                const effDate = pdfData.soDate || row.notificationDate || doc.publishedDate;
                if (row.kind === 'retail') {
                  if (effDate <= '2026-07-16') continue;
                  const dup = db.retailPrices.some(
                    (r) =>
                      r.notificationNumber.toLowerCase() === effSo.toLowerCase() &&
                      r.formulation.toLowerCase().includes(row.medicineName.toLowerCase())
                  );
                  if (!dup) {
                    db.retailPrices.unshift({
                      id: `rp-auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                      notificationNumber: effSo,
                      notificationDate: effDate,
                      formulation: `${row.medicineName} ${row.strength} ${row.dosageFormat}`.trim(),
                      composition: row.composition || row.medicineName,
                      strength: row.strength,
                      dosageFormat: row.dosageFormat,
                      unitLabel: row.unitLabel || `1 ${row.dosageFormat}`,
                      retailPrice: row.price,
                      applicantCompany: 'NPPA Auto-Extracted Notification PDF',
                      sourceUrl: doc.pdfUrl,
                      createdAt: nowIso,
                    });
                    rAdd += 1;
                  }
                } else {
                  const exIdx = db.ceilingPrices.findIndex(
                    (c) =>
                      c.medicineName.toLowerCase() === row.medicineName.toLowerCase() &&
                      c.strength.toLowerCase().replace(/\s+/g, '') ===
                        row.strength.toLowerCase().replace(/\s+/g, '') &&
                      c.dosageFormat.toLowerCase() === row.dosageFormat.toLowerCase()
                  );
                  if (exIdx >= 0) {
                    const prev = db.ceilingPrices[exIdx];
                    db.ceilingPrices[exIdx] = {
                      ...prev,
                      ceilingPrice: row.price,
                      notificationNumber: effSo,
                      notificationDate: effDate,
                      effectiveDate: effDate,
                      sourceUrl: doc.pdfUrl,
                      updatedAt: nowIso,
                    };
                    db.ceilingPriceHistory.unshift({
                      id: `cph-auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                      ceilingPriceId: prev.id,
                      medicineName: prev.medicineName,
                      strength: prev.strength,
                      dosageFormat: prev.dosageFormat,
                      changeType: 'revised',
                      previousCeilingPrice: prev.ceilingPrice,
                      newCeilingPrice: row.price,
                      notificationNumber: effSo,
                      notificationDate: effDate,
                      source: triggeredBy === 'scheduled_10am_ist' ? 'scheduled_10am_ist' : 'manual_sync',
                      changedBy: actor,
                      notes: `Auto-converted from NPPA PDF (${fileName}): ₹${prev.ceilingPrice.toFixed(2)} → ₹${row.price.toFixed(2)}.`,
                      timestamp: nowIso,
                    });
                    cRev += 1;
                  } else {
                    const created: CeilingPriceEntry = {
                      id: `cp-auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                      medicineName: row.medicineName,
                      composition: row.composition || row.medicineName,
                      strength: row.strength,
                      dosageFormat: row.dosageFormat,
                      unitLabel: row.unitLabel || `1 ${row.dosageFormat}`,
                      ceilingPrice: row.price,
                      notificationNumber: effSo,
                      notificationDate: effDate,
                      effectiveDate: effDate,
                      nlemSection: row.nlemSection || 'NLEM 2022',
                      gstDefault: 12,
                      sourceUrl: doc.pdfUrl,
                      updatedAt: nowIso,
                    };
                    db.ceilingPrices.unshift(created);
                    db.ceilingPriceHistory.unshift({
                      id: `cph-auto-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                      ceilingPriceId: created.id,
                      medicineName: created.medicineName,
                      strength: created.strength,
                      dosageFormat: created.dosageFormat,
                      changeType: 'created',
                      previousCeilingPrice: null,
                      newCeilingPrice: created.ceilingPrice,
                      notificationNumber: created.notificationNumber,
                      notificationDate: created.notificationDate,
                      source: triggeredBy === 'scheduled_10am_ist' ? 'scheduled_10am_ist' : 'manual_sync',
                      changedBy: actor,
                      notes: `Auto-converted from NPPA PDF (${fileName}): ₹${created.ceilingPrice.toFixed(2)}.`,
                      timestamp: nowIso,
                    });
                    cAdd += 1;
                  }
                }
              }
              if (cAdd + cRev + rAdd > 0) {
                recordSoTracking(db, {
                  soNumber: pdfData.soNumber || doc.referenceNumber,
                  soDate: pdfData.soDate || doc.publishedDate,
                  sourceType: 'daily_nppa_sync',
                  sourceFileName: fileName,
                  sourceUrl: doc.pdfUrl,
                  ceilingCount: cAdd + cRev,
                  retailCount: rAdd,
                  importedBy: actor,
                  notes: `Auto-extracted during NPPA portal sync from ${fileName}.`,
                });
                doc.soImportedAt = nowIso;
                doc.importedEntryCount = cAdd + cRev + rAdd;
                newCeilingPricesFound += cAdd + cRev;
                newRetailPricesFound += rAdd;
                pdfsAutoConverted += 1;
              }
            }
          } catch {
            // Keep log entry even if single PDF auto-extraction fails
          }
        }
      }
    }
  }

  const successes = [circRes.ok, authRes.ok, expRes.ok].filter(Boolean).length;
  const status: SyncLogEntry['status'] =
    successes === 3 ? 'success' : successes > 0 ? 'partial' : 'fallback';

  const errorDetails = [
    !circRes.ok ? `Circulars: ${circRes.error}` : null,
    !authRes.ok ? `Authority Minutes: ${authRes.error}` : null,
    !expRes.ok ? `Expert Committee: ${expRes.error}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  const message =
    status === 'success'
      ? `Synced all 3 NPPA portals. ${newlyAdded} new log(s), ${newCeilingPricesFound} ceiling update(s), ${newRetailPricesFound} retail circular(s)${pdfsAutoConverted > 0 ? ` (${pdfsAutoConverted} PDF(s) auto-converted)` : ''}.`
      : status === 'partial'
        ? `Partial sync (${successes}/3 portals reachable). ${newlyAdded} new log(s). ${errorDetails}`
        : `NPPA portal unreachable from sandbox (${errorDetails}). Retained verified local regulatory registry.`;

  const syncEntry: SyncLogEntry = {
    id: `sync-${Date.now()}`,
    triggeredBy,
    timestamp: new Date().toISOString(),
    status,
    circularsFetched: circRes.docs.length,
    authorityMinutesFetched: authRes.docs.length,
    expertNotesFetched: expRes.docs.length,
    newCeilingPricesFound,
    newRetailPricesFound,
    message,
  };

  db.ceilingPriceHistory = db.ceilingPriceHistory.slice(0, 100);
  db.syncLogs.unshift(syncEntry);
  db.syncLogs = db.syncLogs.slice(0, 30);
  saveDb(db);

  return syncEntry;
}

function extractFileNameFromResponse(res: Response, targetUrl: string, fallbackRef?: string): string {
  const disp = res.headers.get('content-disposition') || '';
  const match = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
  if (match && match[1]) {
    return match[1].trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  }
  try {
    const pathname = new URL(targetUrl).pathname;
    const base = pathname.split('/').filter(Boolean).pop();
    if (base && base.toLowerCase().endsWith('.pdf')) {
      return base.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
  } catch {
    // ignore URL parse error
  }
  const safeRef = (fallbackRef || 'nppa-notification')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safeRef || 'nppa-notification'}.pdf`;
}

export async function downloadNppaPdfBuffer(
  targetUrl: string,
  fallbackRef?: string
): Promise<{ buffer: Buffer; fileName: string; resolvedUrl: string }> {
  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new Error('Only HTTP/HTTPS NPPA document URLs can be downloaded.');
  }

  const fetchWithTimeout = async (urlToFetch: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(urlToFetch, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'application/pdf,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const res = await fetchWithTimeout(targetUrl);
  if (!res.ok) {
    throw new Error(`NPPA portal returned HTTP ${res.status} while downloading PDF.`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const rawBuf = Buffer.from(await res.arrayBuffer());
  const isPdfHeader = rawBuf.subarray(0, 5).toString('ascii') === '%PDF-';

  if (contentType.includes('application/pdf') || isPdfHeader) {
    return {
      buffer: rawBuf,
      fileName: extractFileNameFromResponse(res, targetUrl, fallbackRef),
      resolvedUrl: targetUrl,
    };
  }

  // If portal returned an HTML listing/detail page, inspect for embedded .pdf links
  const html = rawBuf.toString('utf8');
  const $ = cheerio.load(html);
  const pdfCandidates: Array<{ href: string; text: string }> = [];

  $('a[href]').each((_idx, el) => {
    const href = $(el).attr('href') || '';
    if (href.toLowerCase().includes('.pdf')) {
      pdfCandidates.push({
        href: resolveUrl(href, targetUrl),
        text: $(el).text().replace(/\s+/g, ' ').trim(),
      });
    }
  });

  if (pdfCandidates.length === 0) {
    throw new Error(
      `No direct PDF attachment was exposed at ${targetUrl}. Please download the PDF from NPPA manually and upload it using "Upload & Convert PDF".`
    );
  }

  const refTokens = (fallbackRef || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

  pdfCandidates.sort((a, b) => {
    const hayA = `${a.href} ${a.text}`.toLowerCase();
    const hayB = `${b.href} ${b.text}`.toLowerCase();
    const scoreA = refTokens.reduce((s, t) => (hayA.includes(t) ? s + 1 : s), 0);
    const scoreB = refTokens.reduce((s, t) => (hayB.includes(t) ? s + 1 : s), 0);
    return scoreB - scoreA;
  });

  const chosenUrl = pdfCandidates[0].href;
  const pdfRes = await fetchWithTimeout(chosenUrl);
  if (!pdfRes.ok) {
    throw new Error(`Failed to fetch linked NPPA PDF (${pdfRes.status}) at ${chosenUrl}.`);
  }
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  const chosenType = (pdfRes.headers.get('content-type') || '').toLowerCase();
  const chosenIsPdf =
    chosenType.includes('application/pdf') || pdfBuf.subarray(0, 5).toString('ascii') === '%PDF-';

  if (!chosenIsPdf) {
    throw new Error(
      `Linked NPPA file (${chosenUrl}) did not return a valid PDF document. Please upload the PDF directly.`
    );
  }

  return {
    buffer: pdfBuf,
    fileName: extractFileNameFromResponse(pdfRes, chosenUrl, fallbackRef),
    resolvedUrl: chosenUrl,
  };
}

export function getIstDateAndTimeParts(date = new Date()): {
  istDate: string;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const rawHour = Number(get('hour'));
  return {
    istDate: `${get('year')}-${get('month')}-${get('day')}`,
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get('minute')),
  };
}

let dailySyncInProgress = false;

export async function checkAndRunDailySync(): Promise<boolean> {
  if (dailySyncInProgress) return false;
  try {
    const { istDate, hour } = getIstDateAndTimeParts();
    const db = loadDb();
    // Run at 10:00 AM IST or catch up anytime after 10:00 AM IST if missed due to server restart/sleep
    if (hour >= 10 && db.lastDailyRunDateIst !== istDate) {
      dailySyncInProgress = true;
      db.lastDailyRunDateIst = istDate;
      saveDb(db);
      await runNppaSync('scheduled_10am_ist');
      return true;
    }
  } catch {
    // keep scheduler alive silently
  } finally {
    dailySyncInProgress = false;
  }
  return false;
}

export function startDaily10AmScheduler(): void {
  setTimeout(() => {
    void checkAndRunDailySync();
  }, 5000);
  setInterval(() => {
    void checkAndRunDailySync();
  }, 60 * 1000);
}
