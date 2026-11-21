import type {
  CompanyProfile,
  Form1CheckResult,
  Form1IngredientMatch,
  Nlem2022Entry,
} from '../src/types/compliance.ts';
import { OMITTED_FROM_NLEM_2022 } from './nlem2022Data.ts';

function normalizeIngredientText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(
      /\b(each|film[\s-]?coated|uncoated|tablet|capsule|injection|syrup|vial|contains|ip|bp|usp|eq\.?\s*to|equivalent\s*to|hydrochloride|hcl|sodium|potassium|calcium|besylate|maleate|trihydrate|dihydrate|phosphate|monohydrate|succinate|tartrate|bisulphate|propanediol|anhydrous|sr|er)\b/gi,
      ' '
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|g|gm|ml|l|iu|%)\b(?:\/\s*\d*\s*(?:ml|dose))?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(val: string): string {
  return val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPortfolioFormulation(
  ex: CompanyProfile['existingFormulations'][number],
  entry: Nlem2022Entry
): boolean {
  const exMed = ex.medicineName.toLowerCase().trim();
  const exComp = (ex.composition || '').toLowerCase();
  const componentText = (ex.components || [])
    .map((c) => c.ingredient.toLowerCase().trim())
    .filter(Boolean);
  const targetMed = entry.medicineName.toLowerCase();
  const allTerms = [targetMed, ...(entry.aliases || []).map((a) => a.toLowerCase())];

  return (
    exMed === targetMed ||
    (exMed.length >= 3 && targetMed.includes(exMed)) ||
    allTerms.some((term) => {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
      return (
        term === exMed ||
        re.test(exMed) ||
        re.test(exComp) ||
        componentText.some((ing) => ing === term || re.test(ing))
      );
    })
  );
}

export function evaluateForm1Applicability(
  params: {
    productName: string;
    dosageForm: string;
    compositionText: string;
  },
  nlemMaster: Nlem2022Entry[],
  company: CompanyProfile
): Form1CheckResult {
  const { productName, dosageForm, compositionText } = params;
  const rawSegments = compositionText
    .split(/[,+\n&;]|\band\b/gi)
    .map((s) => s.trim())
    .filter(Boolean);

  const matches: Form1IngredientMatch[] = [];
  const matchedNlemIds = new Set<string>();

  for (const segment of rawSegments) {
    const cleaned = normalizeIngredientText(segment);
    if (!cleaned || cleaned.length < 2) continue;

    // 1. Check NLEM 2022 entries (prefer exact/multi-word match first)
    let matchedEntry: Nlem2022Entry | undefined;
    for (const entry of nlemMaster) {
      const candidates = [entry.medicineName, ...(entry.aliases || [])];
      const found = candidates.some((cand) => {
        const cLow = cand.toLowerCase();
        const re = new RegExp(`\\b${escapeRegExp(cLow)}\\b`, 'i');
        return re.test(segment.toLowerCase()) || cleaned === cLow || cleaned.includes(cLow);
      });
      if (found) {
        matchedEntry = entry;
        break;
      }
    }

    if (matchedEntry) {
      if (matchedNlemIds.has(matchedEntry.id)) continue;
      matchedNlemIds.add(matchedEntry.id);

      const companyMatches = company.existingFormulations.filter((ex) =>
        matchesPortfolioFormulation(ex, matchedEntry!)
      );

      matches.push({
        extractedToken: segment,
        matchedMedicine: matchedEntry.medicineName,
        isNlem2022: true,
        nlemEntry: matchedEntry,
        companyMatches,
      });
      continue;
    }

    // 2. Check known omitted NLEM 2015 drugs (e.g. Ranitidine)
    let omittedKey: string | undefined;
    for (const key of Object.keys(OMITTED_FROM_NLEM_2022)) {
      const re = new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i');
      if (re.test(segment.toLowerCase()) || cleaned.includes(key)) {
        omittedKey = key;
        break;
      }
    }

    if (omittedKey) {
      matches.push({
        extractedToken: segment,
        matchedMedicine: omittedKey.charAt(0).toUpperCase() + omittedKey.slice(1),
        isNlem2022: false,
        isOmittedFromNlem2022: true,
        omissionNote: OMITTED_FROM_NLEM_2022[omittedKey],
        companyMatches: [],
      });
    } else {
      matches.push({
        extractedToken: segment,
        matchedMedicine: cleaned
          .split(' ')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' '),
        isNlem2022: false,
        companyMatches: [],
      });
    }
  }

  // Fallback full-text scan in case user wrote a single sentence without delimiters
  if (matches.filter((m) => m.isNlem2022).length === 0) {
    const lowFull = compositionText.toLowerCase();
    for (const entry of nlemMaster) {
      if (matchedNlemIds.has(entry.id)) continue;
      const candidates = [entry.medicineName, ...(entry.aliases || [])];
      if (
        candidates.some((cand) =>
          new RegExp(`\\b${escapeRegExp(cand.toLowerCase())}\\b`, 'i').test(lowFull)
        )
      ) {
        matchedNlemIds.add(entry.id);
        const companyMatches = company.existingFormulations.filter((ex) =>
          matchesPortfolioFormulation(ex, entry)
        );
        matches.push({
          extractedToken: entry.medicineName,
          matchedMedicine: entry.medicineName,
          isNlem2022: true,
          nlemEntry: entry,
          companyMatches,
        });
      }
    }
  }

  const nlemMatches = matches.filter((m) => m.isNlem2022);
  const hasScheduledIngredient = nlemMatches.length > 0;
  const portfolioMatchedMeds = nlemMatches.filter((m) => m.companyMatches.length > 0);
  const isExistingManufacturerInPortfolio = portfolioMatchedMeds.length > 0;

  let summaryHeadline = '';
  let regulatoryGuidance = '';

  if (hasScheduledIngredient) {
    const medNames = nlemMatches.map((m) => m.matchedMedicine).join(', ');
    summaryHeadline = `Since the formulation contains ${medNames}, which is an NLEM 2022 scheduled formulation, check applicability of Existing Manufacturer.`;
    if (isExistingManufacturerInPortfolio) {
      const existingStr = portfolioMatchedMeds
        .flatMap((m) => m.companyMatches.map((c) => `${c.medicineName} ${c.dosageForm} ${c.strength}`))
        .join('; ');
      regulatoryGuidance = `Existing Manufacturer Match Found in Company Profile (${existingStr}). Under DPCO 2013 Para 2(u) & Para 15, your organisation qualifies as an Existing Manufacturer of the NLEM formulation — hence Form I MUST be applied to NPPA prior to launch (or verify Form 1A retail price notification if adopting a notified price post-16 July 2026).`;
    } else {
      regulatoryGuidance = `No matching SKU was found in your saved Company Portfolio, so please manually verify against the NLEM 2022 list below: if your organisation manufactures or markets any listed strength of ${medNames}, you are an Existing Manufacturer and Form I needs to be applied.`;
    }
  } else {
    summaryHeadline =
      'No NLEM 2022 scheduled active ingredient detected in the entered composition.';
    regulatoryGuidance =
      'Based on NLEM 2022 screening, this formulation appears to be a Non-Scheduled Formulation. Existing Manufacturer Form I retail price application under Para 15 is not triggered by NLEM 2022, though standard Form V / Para 20 (10% annual price increase cap) compliance still applies.';
  }

  const existingManufacturerConditions: string[] = hasScheduledIngredient
    ? [
        'DPCO 2013 Para 2(u) — "New Drug" Definition: Any formulation launched by an Existing Manufacturer of a scheduled formulation by combining it with another drug (scheduled or non-scheduled), or by changing strength/dosage form, is classified as a New Drug.',
        'Existing Manufacturer Status: If your organisation currently manufactures or markets any NLEM 2022 scheduled dosage form/strength of the matched molecule(s) listed below (or holds active CDSCO/State FDA manufacturing & marketing approval), you are deemed an Existing Manufacturer.',
        'Mandatory Form I Filing (Para 15): An Existing Manufacturer must apply to NPPA in Form I for retail price fixation before launching the new product—unless adopting a post-16 July 2026 notified Retail Price via Form 1A where eligible.',
      ]
    : [
        'No NLEM 2022 scheduled ingredient was matched in the entered composition.',
        'Confirm whether any salt/ester synonym applies before launch; non-scheduled formulations remain subject to DPCO 2013 Para 20 (10% annual price increase ceiling) and Form V reporting.',
      ];

  return {
    productName: productName || 'Proposed New Formulation',
    dosageForm: dosageForm || 'Tablet',
    compositionText,
    hasScheduledIngredient,
    isExistingManufacturerInPortfolio,
    form1RequiredBasedOnPortfolio: hasScheduledIngredient && isExistingManufacturerInPortfolio,
    summaryHeadline,
    regulatoryGuidance,
    existingManufacturerConditions,
    matches,
    checkedAt: new Date().toISOString(),
  };
}
