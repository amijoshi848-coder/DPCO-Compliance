import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { AiParsedNotificationRow, PdfConversionResult } from '../src/types/compliance.ts';

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

const KNOWN_DOSAGE_PREFIXES = [
  'Powder for Injection',
  'Powder for Solution for Injection',
  'Powder for Oral Liquid',
  'Powder for Suspension',
  'Conventional/Effervescent/Dispersible/Enteric coated Tablets',
  'Enteric coated Tablet',
  'Dispersible Tablet',
  'Sustained Release Tablet',
  'Extended Release Tablet',
  'Chewable Tablet',
  'Film Coated Tablet',
  'SR Tablet',
  'ER Tablet',
  'MR Tablet',
  'PR Tablet',
  'CR Tablet',
  'Retention Enema',
  'Inhalation (MDI)',
  'Inhalation (DPI)',
  'Inhalation (Nebulizer)',
  'Respirator Solution',
  'Oral Liquid',
  'Oral Solution',
  'Oral Suspension',
  'Eye Drops',
  'Ear Drops',
  'Nasal Drops',
  'Pessary',
  'Suppository',
  'Syrup',
  'Suspension',
  'Solution',
  'Injection',
  'Capsule',
  'Tablet',
  'Drops',
  'Cream',
  'Ointment',
  'Lotion',
  'Gel',
  'Patch',
  'Spray',
  'Powder',
  'Liquid',
  'Lozenge',
  'Implant',
  'As licensed',
];

function parseEnglishGazetteDate(text: string): string | null {
  const ordMatch = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(20\d{2})\b/i
  );
  if (ordMatch) {
    const dd = ordMatch[1].padStart(2, '0');
    const mm = MONTH_MAP[ordMatch[2].toLowerCase()];
    const yyyy = ordMatch[3];
    if (mm) return `${yyyy}-${mm}-${dd}`;
  }
  const dmy = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

export function splitDosageAndStrength(rawDosage: string): {
  dosageFormat: string;
  strength: string;
} {
  const cleaned = rawDosage
    .replace(/\s+/g, ' ')
    .replace(/D\s+ispersible/g, 'Dispersible')
    .replace(
      /\b(Tablets?|Capsules?|Injections?|Syrups?|Drops?|Creams?|Gels?|Ointments?|Powders?|Solutions?|Suspensions?|Inhalers?|Suppository|Suppositories|Pessary|Pessaries|Sprays?|Patches|Lotions?|Liquids?)(\d)/gi,
      '$1 $2'
    )
    .trim();

  if (!cleaned) {
    return { dosageFormat: 'Tablet', strength: 'Standard' };
  }

  // Handle "As licensed (250IU)" or "As licensed"
  const asLic = cleaned.match(/^As\s+licensed(?:\s*\(([^)]+)\))?(.*)$/i);
  if (asLic) {
    const s = (asLic[1] || asLic[2] || '').trim() || 'As licensed';
    return { dosageFormat: 'As licensed', strength: s };
  }

  // Try matching numeric strength boundary e.g. "Tablet 500 mg", "Injection 250 mg/5 ml", "Drops 0.5 %"
  const numIdx = cleaned.search(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|gm|g|ml|l|iu|%|million|k\s*iu|mi\.?u|cfu)/i);
  if (numIdx > 0) {
    let rawForm = cleaned.slice(0, numIdx).trim().replace(/[-:]+$/, '').trim();
    const strength = cleaned.slice(numIdx).trim();

    if (/^conventional\/effervescent\/.*tablets?$/i.test(rawForm)) {
      rawForm = 'Tablet (Conventional/Dispersible/EC)';
    } else if (/^tablets$/i.test(rawForm)) {
      rawForm = 'Tablet';
    } else if (/^capsules$/i.test(rawForm)) {
      rawForm = 'Capsule';
    } else if (/tablets$/i.test(rawForm)) {
      rawForm = rawForm.replace(/tablets$/i, 'Tablet');
    } else if (/capsules$/i.test(rawForm)) {
      rawForm = rawForm.replace(/capsules$/i, 'Capsule');
    }

    return {
      dosageFormat: rawForm || 'Tablet',
      strength: strength || 'Standard',
    };
  }

  for (const prefix of KNOWN_DOSAGE_PREFIXES) {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b(.*)$`, 'i');
    const m = cleaned.match(re);
    if (m) {
      const rest = m[1].replace(/^\(([^)]+)\)$/, '$1').trim();
      return {
        dosageFormat: prefix,
        strength: rest || 'Standard',
      };
    }
  }

  return {
    dosageFormat: cleaned,
    strength: 'Standard',
  };
}

interface TextItemPos {
  str: string;
  x: number;
  y: number;
}

export interface ParsedGazetteTableResult extends PdfConversionResult {
  effectiveDate?: string;
  parsedBy: 'pdfjs_gazette';
}

export async function parseNppaGazettePdf(params: {
  pdfBase64?: string;
  pdfBuffer?: Uint8Array | Buffer;
  fileName?: string;
  fallbackSoNumber?: string;
  fallbackSoDate?: string;
  defaultKind?: 'auto' | 'ceiling' | 'retail';
}): Promise<ParsedGazetteTableResult | null> {
  let bytes: Uint8Array;
  if (params.pdfBuffer) {
    bytes = params.pdfBuffer instanceof Uint8Array
      ? new Uint8Array(params.pdfBuffer)
      : new Uint8Array(params.pdfBuffer);
  } else if (params.pdfBase64) {
    const cleaned = params.pdfBase64.replace(/^data:application\/pdf;base64,/i, '').trim();
    bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
  } else {
    return null;
  }

  if (bytes.length === 0) return null;

  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const numPages = doc.numPages;

  let detectedSoNumber = '';
  let detectedSoDate = '';
  let detectedEffectiveDate = '';
  let detectedTitle = '';
  let isRetailNotice = params.defaultKind === 'retail';

  const pageItems: Array<{ pageNum: number; items: TextItemPos[] }> = [];

  for (let p = 1; p <= numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items: TextItemPos[] = tc.items
      .map((it: any) => ({
        str: String(it.str || ''),
        x: Number(it.transform?.[4] ?? 0),
        y: Number(it.transform?.[5] ?? 0),
      }))
      .filter((i) => i.str.trim().length > 0);

    pageItems.push({ pageNum: p, items });

    const pageText = items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
    if (!detectedSoNumber) {
      const soMatch = pageText.match(/\bS\.O\.?\s*(\d+\s*\(E\))/i);
      if (soMatch) {
        detectedSoNumber = `S.O. ${soMatch[1].replace(/\s+/g, '')}`;
      }
    }
    if (!detectedSoDate && /New Delhi,\s*the/i.test(pageText)) {
      const d = parseEnglishGazetteDate(
        pageText.slice(Math.max(0, pageText.search(/New Delhi,\s*the/i)), Math.max(0, pageText.search(/New Delhi,\s*the/i)) + 120)
      );
      if (d) detectedSoDate = d;
    }
    if (!detectedEffectiveDate && /w\.e\.f\.|with effect from/i.test(pageText)) {
      const idx = pageText.search(/w\.e\.f\.|with effect from/i);
      const eff = parseEnglishGazetteDate(pageText.slice(idx, idx + 80));
      if (eff) detectedEffectiveDate = eff;
    }
    if (!detectedTitle && /MINISTRY OF CHEMICALS AND FERTILIZERS/i.test(pageText)) {
      if (/ceiling price/i.test(pageText)) {
        detectedTitle = 'NPPA Gazette Ceiling Price Notification';
      } else if (/retail price/i.test(pageText)) {
        detectedTitle = 'NPPA Gazette Retail Price Notification';
        if (params.defaultKind !== 'ceiling') isRetailNotice = true;
      }
    }
  }

  const finalSoNumber = detectedSoNumber || params.fallbackSoNumber?.trim() || 'S.O. Unspecified';
  const finalSoDate = detectedSoDate || params.fallbackSoDate?.trim() || new Date().toISOString().slice(0, 10);

  const extractedRows: AiParsedNotificationRow[] = [];
  let tableStarted = false;

  for (const { items } of pageItems) {
    const pageText = items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
    const hasTableHeader =
      /Sl\.?\s*No\.?/i.test(pageText) &&
      (/Ceiling\s*price/i.test(pageText) || /Retail\s*price/i.test(pageText)) &&
      /Medicines|Formulation|Schedule/i.test(pageText);

    if (/Retail\s*price\s*\(/i.test(pageText) && params.defaultKind !== 'ceiling') {
      isRetailNotice = true;
    }

    // Ignore header/footer chrome
    let filtered = items.filter((i) => i.y < 785 && i.y > 40);

    if (hasTableHeader) {
      tableStarted = true;
      // Find lowest Y of "(1)" / "(2)" / "Sl. No." column header row so we start cleanly below it
      const colMarker = filtered.find(
        (i) => i.x >= 45 && i.x < 85 && /^\(1\)$/.test(i.str.trim())
      );
      const slHeader = filtered.find(
        (i) => i.x >= 45 && i.x < 100 && /^Sl\.?/i.test(i.str.trim())
      );
      const headerCutoffY = colMarker ? colMarker.y - 6 : slHeader ? slHeader.y - 22 : 690;
      filtered = filtered.filter((i) => i.y < headerCutoffY);
    }

    if (!tableStarted) continue;

    // Stop if this page enters the "Notes:" section before any rows, or trim items below "Notes:"
    const notesHeading = filtered.find(
      (i) => i.x >= 45 && i.x < 120 && /^Notes?\s*:?-?$/i.test(i.str.trim())
    );
    if (notesHeading) {
      filtered = filtered.filter((i) => i.y > notesHeading.y + 2);
    }

    const anchors = filtered
      .filter((i) => i.x >= 45 && i.x < 84 && /^\d{1,4}$/.test(i.str.trim()))
      .map((i) => ({ sl: Number(i.str.trim()), y: i.y }))
      .filter((a) => a.sl >= 1 && a.sl <= 5000)
      .sort((a, b) => b.y - a.y);

    if (anchors.length === 0) continue;

    // Assign each item on the page to its nearest vertical anchor row
    const buckets: TextItemPos[][] = anchors.map(() => []);
    for (const item of filtered) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let idx = 0; idx < anchors.length; idx++) {
        const d = Math.abs(item.y - anchors[idx].y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }
      if (bestDist <= 28) {
        buckets[bestIdx].push(item);
      }
    }

    for (let idx = 0; idx < anchors.length; idx++) {
      const band = buckets[idx];
      const col = (minX: number, maxX: number) =>
        band
          .filter((i) => i.x >= minX && i.x < maxX)
          .sort((a, b) => b.y - a.y || a.x - b.x)
          .map((i) => i.str.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      const medicineName = col(80, 185);
      const rawDosage = col(185, 294);
      const unitLabel = col(294, 370);
      const priceText = col(370, 434).replace(/,/g, '');
      const priceMatch = priceText.match(/\d+(?:\.\d{1,2})?/);
      const price = priceMatch ? Number(priceMatch[0]) : NaN;

      if (!medicineName || !Number.isFinite(price) || price <= 0) continue;

      const { dosageFormat, strength } = splitDosageAndStrength(rawDosage);

      extractedRows.push({
        kind: isRetailNotice ? 'retail' : 'ceiling',
        medicineName,
        composition: rawDosage ? `${medicineName} (${rawDosage})` : medicineName,
        strength,
        dosageFormat,
        unitLabel: unitLabel || `1 ${dosageFormat}`,
        price,
        notificationNumber: finalSoNumber,
        notificationDate: finalSoDate,
        nlemSection: 'NLEM 2022',
      });
    }
  }

  if (extractedRows.length === 0) {
    return null;
  }

  return {
    soNumber: finalSoNumber,
    soDate: finalSoDate,
    effectiveDate: detectedEffectiveDate || finalSoDate,
    documentTitle:
      detectedTitle ||
      `${finalSoNumber} (${finalSoDate}) — ${extractedRows.length} formulations`,
    fileName: params.fileName?.trim() || `${finalSoNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`,
    rows: extractedRows,
    parsedBy: 'pdfjs_gazette',
  };
}
