import * as XLSX from 'xlsx';
import type { ExistingCompanyFormulation, FdcComponent } from '../types/compliance';

const TEMPLATE_HEADERS = [
  'Medicine Name',
  'Composition',
  'Strength',
  'Dosage Format',
  'Category',
  'Pack',
  'MRP (INR)',
  'Brand Name',
  'Marketing Status',
  'Is FDC (Yes/No)',
] as const;

function sanitizeSheetCell(val: unknown): string {
  return String(val ?? '').trim();
}

function parseFdcComponentsFromRow(
  medicineName: string,
  compositionRaw: string,
  strengthRaw: string,
  isFdcHint: boolean
): {
  isFdc: boolean;
  components?: FdcComponent[];
  normalizedComposition: string;
  normalizedStrength: string;
} {
  const compSegments = compositionRaw
    .split(/\+|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  const strengthSegments = strengthRaw
    .split(/\+|;/)
    .map((s) => s.trim())
    .filter(Boolean);

  const shouldTreatAsFdc =
    isFdcHint || compSegments.length >= 2 || strengthSegments.length >= 2;

  if (!shouldTreatAsFdc) {
    return {
      isFdc: false,
      normalizedComposition: compositionRaw || medicineName,
      normalizedStrength: strengthRaw,
    };
  }

  const count = Math.max(compSegments.length, strengthSegments.length);
  const components: FdcComponent[] = [];

  for (let i = 0; i < count; i++) {
    const seg = compSegments[i] || '';
    const strFallback = strengthSegments[i] || '';

    // Check pattern like "Telmisartan (40mg)"
    const parenMatch = seg.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (parenMatch) {
      components.push({
        ingredient: parenMatch[1].trim(),
        strength: parenMatch[2].trim() || strFallback || 'Std',
      });
      continue;
    }

    // Check pattern like "Telmisartan 40mg" when no separate strength segment was supplied
    const trailingStrengthMatch = seg.match(
      /^(.+?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|ug|g|gm|ml|iu|%)(?:\s*\/\s*\d*\s*(?:ml|dose))?)$/i
    );
    if (trailingStrengthMatch && !strFallback) {
      components.push({
        ingredient: trailingStrengthMatch[1].trim(),
        strength: trailingStrengthMatch[2].trim(),
      });
      continue;
    }

    if (seg || strFallback) {
      components.push({
        ingredient: seg || `Component ${i + 1}`,
        strength: strFallback || 'Std',
      });
    }
  }

  if (components.length >= 2) {
    return {
      isFdc: true,
      components,
      normalizedComposition: components
        .map((c) => `${c.ingredient} (${c.strength})`)
        .join(' + '),
      normalizedStrength: components.map((c) => c.strength).join(' + '),
    };
  }

  return {
    isFdc: isFdcHint,
    normalizedComposition: compositionRaw || medicineName,
    normalizedStrength: strengthRaw,
  };
}

export function downloadPortfolioTemplateExcel(): void {
  const wb = XLSX.utils.book_new();

  const sampleRows = [
    {
      'Medicine Name': 'Atorvastatin',
      Composition: 'Atorvastatin Calcium IP eq. to Atorvastatin',
      Strength: '20mg',
      'Dosage Format': 'Tablet',
      Category: 'Scheduled (NLEM 2022)',
      Pack: '10 Tablets',
      'MRP (INR)': 135.4,
      'Brand Name': 'AtorvaCare-20',
      'Marketing Status': 'Active',
      'Is FDC (Yes/No)': 'No',
    },
    {
      'Medicine Name': 'Telmisartan + Amlodipine',
      Composition: 'Telmisartan IP (40mg) + Amlodipine Besylate IP eq. to Amlodipine (5mg)',
      Strength: '40mg + 5mg',
      'Dosage Format': 'Tablet',
      Category: 'Fixed Dose Combination (FDC)',
      Pack: '15 Tablets',
      'MRP (INR)': 145.5,
      'Brand Name': 'TelmiAmlo-40',
      'Marketing Status': 'Active',
      'Is FDC (Yes/No)': 'Yes',
    },
    {
      'Medicine Name': 'Telmisartan + Amlodipine + Hydrochlorothiazide',
      Composition: 'Telmisartan (40mg) + Amlodipine (5mg) + Hydrochlorothiazide (12.5mg)',
      Strength: '40mg + 5mg + 12.5mg',
      'Dosage Format': 'Tablet',
      Category: 'Fixed Dose Combination (FDC)',
      Pack: '10 Tablets',
      'MRP (INR)': 168.0,
      'Brand Name': 'TelmiTri-40',
      'Marketing Status': 'Active',
      'Is FDC (Yes/No)': 'Yes',
    },
  ];

  const wsData = XLSX.utils.json_to_sheet(sampleRows, {
    header: [...TEMPLATE_HEADERS],
  });
  wsData['!cols'] = [
    { wch: 32 },
    { wch: 52 },
    { wch: 20 },
    { wch: 15 },
    { wch: 28 },
    { wch: 14 },
    { wch: 12 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, wsData, 'Company Products');

  const instructions = [
    {
      Column: 'Medicine Name',
      Required: 'Yes',
      Format_and_Rules:
        'Single molecule name (e.g. Atorvastatin) or FDC title (e.g. Telmisartan + Amlodipine).',
    },
    {
      Column: 'Composition',
      Required: 'Recommended',
      Format_and_Rules:
        'Full active composition. For Fixed Dose Combinations (FDC), separate multiple active compositions with "+" (e.g. "Telmisartan (40mg) + Amlodipine (5mg)").',
    },
    {
      Column: 'Strength',
      Required: 'Yes',
      Format_and_Rules:
        'Single strength (e.g. 20mg) or "+" separated strengths matching FDC order (e.g. 40mg + 5mg).',
    },
    {
      Column: 'Dosage Format',
      Required: 'Yes',
      Format_and_Rules: 'Tablet, Capsule, SR Tablet, Injection, Syrup, Inhaler, Drops, etc.',
    },
    {
      Column: 'Category',
      Required: 'Optional',
      Format_and_Rules:
        'Use one of: Scheduled (NLEM 2022), Non-Scheduled, New Drug (Form I / 1A), Fixed Dose Combination (FDC).',
    },
    {
      Column: 'Pack',
      Required: 'Optional',
      Format_and_Rules: 'Pack size label such as "10 Tablets", "15 Capsules", "1 Vial (10ml)".',
    },
    {
      Column: 'MRP (INR)',
      Required: 'Optional',
      Format_and_Rules: 'Numeric MRP per pack in INR (numbers only, e.g. 145.50).',
    },
    {
      Column: 'Brand Name',
      Required: 'Optional',
      Format_and_Rules: 'Commercial brand name (optional).',
    },
    {
      Column: 'Marketing Status',
      Required: 'Optional',
      Format_and_Rules: 'Active or Discontinued (defaults to Active).',
    },
    {
      Column: 'Is FDC (Yes/No)',
      Required: 'Optional',
      Format_and_Rules:
        'Yes or No. Also auto-detected if Composition/Strength uses "+" or Category is Fixed Dose Combination (FDC).',
    },
  ];

  const wsGuide = XLSX.utils.json_to_sheet(instructions);
  wsGuide['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Upload Instructions');

  XLSX.writeFile(wb, 'company-product-portfolio-format.xlsx');
}

export function downloadPortfolioExcel(
  companyName: string,
  items: ExistingCompanyFormulation[]
): void {
  const wb = XLSX.utils.book_new();
  const rows = items.map((sku) => {
    const isFdc = Boolean(sku.isFdc || (sku.components && sku.components.length > 1));
    const compText =
      sku.components && sku.components.length > 0
        ? sku.components.map((c) => `${c.ingredient} (${c.strength})`).join(' + ')
        : sku.composition || sku.medicineName;
    const strengthText =
      sku.components && sku.components.length > 0
        ? sku.components.map((c) => c.strength).join(' + ')
        : sku.strength;

    return {
      'Medicine Name': sku.medicineName,
      Composition: compText,
      Strength: strengthText,
      'Dosage Format': sku.dosageForm,
      Category: sku.category || 'Scheduled (NLEM 2022)',
      Pack: sku.pack || '',
      'MRP (INR)': sku.mrp ?? '',
      'Brand Name': sku.brandName || '',
      'Marketing Status': sku.marketingStatus || 'Active',
      'Is FDC (Yes/No)': isFdc ? 'Yes' : 'No',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, { header: [...TEMPLATE_HEADERS] });
  ws['!cols'] = [
    { wch: 30 },
    { wch: 50 },
    { wch: 20 },
    { wch: 15 },
    { wch: 26 },
    { wch: 14 },
    { wch: 12 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Company Products');

  const safeSlug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  XLSX.writeFile(wb, `${safeSlug || 'company'}-product-portfolio.xlsx`);
}

function normalizeHeaderKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getField(
  normalizedRow: Record<string, unknown>,
  candidates: string[]
): string {
  for (const key of candidates) {
    if (normalizedRow[key] !== undefined && normalizedRow[key] !== null) {
      const val = sanitizeSheetCell(normalizedRow[key]);
      if (val) return val;
    }
  }
  return '';
}

export interface ParsedExcelPortfolioResult {
  items: ExistingCompanyFormulation[];
  warnings: string[];
  sheetName: string;
}

export function parseCompanyPortfolioExcel(
  buffer: ArrayBuffer
): ParsedExcelPortfolioResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const preferredSheet =
    wb.SheetNames.find((n) => n.toLowerCase().includes('product')) || wb.SheetNames[0];

  if (!preferredSheet) {
    throw new Error('No worksheet was found in the uploaded Excel file.');
  }

  const ws = wb.Sheets[preferredSheet];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
  });

  if (rawRows.length === 0) {
    throw new Error(`Worksheet "${preferredSheet}" is empty. Please use the format template.`);
  }

  const items: ExistingCompanyFormulation[] = [];
  const warnings: string[] = [];

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 2; // 1-based + header row
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      norm[normalizeHeaderKey(k)] = v;
    }

    const medicineName = getField(norm, [
      'medicinename',
      'activemedicinename',
      'productname',
      'product',
      'formulation',
    ]);
    const compositionRaw = getField(norm, ['composition', 'activecomposition', 'ingredients']);
    const strengthRaw = getField(norm, ['strength', 'strengths']);
    const dosageForm =
      getField(norm, ['dosageformat', 'dosageform', 'format', 'form']) || 'Tablet';
    const category =
      getField(norm, ['category', 'productcategory']) || 'Scheduled (NLEM 2022)';
    const pack = getField(norm, ['pack', 'packsize']);
    const mrpRaw = getField(norm, ['mrpinr', 'mrp', 'mrprs', 'price']);
    const brandName = getField(norm, ['brandname', 'brand']);
    const statusRaw = getField(norm, ['marketingstatus', 'status']);
    const isFdcRaw = getField(norm, ['isfdcyesno', 'isfdc', 'fdc']);

    if (!medicineName && !compositionRaw) {
      return; // skip blank trailing row
    }

    if (!medicineName || !strengthRaw) {
      warnings.push(
        `Row ${rowNum} skipped: Medicine Name and Strength are both required.`
      );
      return;
    }

    let mrp: number | undefined;
    if (mrpRaw) {
      const cleanedMrp = Number(mrpRaw.replace(/[₹,\sINRinr]/g, ''));
      if (Number.isFinite(cleanedMrp) && cleanedMrp >= 0) {
        mrp = cleanedMrp;
      } else {
        warnings.push(`Row ${rowNum} (${medicineName}): invalid MRP "${mrpRaw}" ignored.`);
      }
    }

    const isFdcHint =
      /^(yes|true|1|y)$/i.test(isFdcRaw) ||
      category.toLowerCase().includes('fdc') ||
      category.toLowerCase().includes('fixed dose');

    const parsedFdc = parseFdcComponentsFromRow(
      medicineName,
      compositionRaw,
      strengthRaw,
      isFdcHint
    );

    const marketingStatus: 'Active' | 'Discontinued' = /discontinued|inactive/i.test(
      statusRaw
    )
      ? 'Discontinued'
      : 'Active';

    items.push({
      id: `ex-xls-${Date.now()}-${idx}`,
      medicineName,
      composition: parsedFdc.normalizedComposition,
      isFdc: parsedFdc.isFdc,
      components: parsedFdc.components,
      dosageForm,
      strength: parsedFdc.normalizedStrength,
      category:
        parsedFdc.isFdc && category === 'Scheduled (NLEM 2022)'
          ? 'Fixed Dose Combination (FDC)'
          : category,
      pack: pack || undefined,
      mrp,
      brandName: brandName || undefined,
      marketingStatus,
    });
  });

  if (items.length === 0) {
    throw new Error(
      'No valid product rows could be read. Download the Format (.xlsx) template and ensure "Medicine Name" and "Strength" columns are filled.'
    );
  }

  return { items, warnings, sheetName: preferredSheet };
}
