import { GoogleGenAI, Type, type Content } from '@google/genai';
import type {
  AiChatHistoryTurn,
  AiForm1Brief,
  AiGroundingSource,
  AiParsedNotificationRow,
  Form1CheckResult,
  PdfConversionResult,
} from '../src/types/compliance.ts';
import { loadDb } from './storage.ts';

const GEMINI_MODEL = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'Gemini API key is not configured. Please add GEMINI_API_KEY in Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('GEMINI_API_KEY is not configured')) {
    return { status: 503, message: raw };
  }
  if (
    raw.includes('API_KEY_INVALID') ||
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('403')
  ) {
    return {
      status: 403,
      message:
        'Gemini API access denied or invalid key. Please verify your API key in the Settings > Secrets panel.',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message:
        'Gemini API rate limit reached. Please retry shortly or check quota in Settings > Secrets.',
    };
  }
  if (raw.includes('NOT_FOUND') || raw.includes('404')) {
    return {
      status: 404,
      message: `Requested Gemini model (${GEMINI_MODEL}) was not found.`,
    };
  }
  return {
    status: 500,
    message: raw || 'Unable to complete AI request.',
  };
}

function buildRegistryContext(userQuery: string): string {
  const db = loadDb();
  const tokens = userQuery
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const matchScore = (text: string) => {
    const lower = text.toLowerCase();
    return tokens.reduce((acc, tok) => (lower.includes(tok) ? acc + 1 : acc), 0);
  };

  const ceilingRanked = [...db.ceilingPrices]
    .sort((a, b) => matchScore(`${b.medicineName} ${b.composition}`) - matchScore(`${a.medicineName} ${a.composition}`))
    .slice(0, 15)
    .map(
      (c) =>
        `- ${c.medicineName} (${c.strength} ${c.dosageFormat}, ${c.unitLabel}): Ceiling ₹${c.ceilingPrice.toFixed(2)} | ${c.notificationNumber} (${c.notificationDate}) | NLEM ${c.nlemSection}`
    );

  const retailRanked = [...db.retailPrices]
    .filter((r) => r.notificationDate > '2026-07-16')
    .sort((a, b) => matchScore(b.formulation) - matchScore(a.formulation))
    .slice(0, 12)
    .map(
      (r) =>
        `- ${r.formulation} (${r.unitLabel}): Retail ₹${r.retailPrice.toFixed(2)} | ${r.notificationNumber} (${r.notificationDate}) | ${r.applicantCompany}`
    );

  const nlemMatches = db.nlem2022
    .filter((n) => matchScore(`${n.medicineName} ${n.therapeuticCategory}`) > 0)
    .slice(0, 15)
    .map(
      (n) =>
        `- ${n.medicineName} [Sec ${n.sectionCode}, ${n.therapeuticCategory}]: ${n.dosageForms
          .map((d) => `${d.dosageForm} ${d.strength}`)
          .join(', ')}`
    );

  const recentLogs = db.nppaLogs
    .slice(0, 8)
    .map(
      (l) =>
        `- [${l.sourceType}] ${l.referenceNumber} (${l.publishedDate}): ${l.title}`
    );

  const companySkus = db.companyProfile.existingFormulations
    .map((f) => {
      const compDetail =
        f.components && f.components.length > 0
          ? f.components.map((c) => `${c.ingredient} ${c.strength}`.trim()).join(' + ')
          : `${f.medicineName} ${f.strength}`;
      return `${f.medicineName} [${compDetail}] ${f.dosageForm} (${f.category || 'Standard'}, ${f.marketingStatus})`;
    })
    .join('; ');

  return [
    `COMPANY PROFILE: ${db.companyProfile.companyName} | Lic: ${db.companyProfile.manufacturingLicenseNo} | Existing Manufactured SKUs: ${companySkus || 'None'}`,
    `CEILING PRICE MASTER (${db.ceilingPrices.length} total, top relevant shown):\n${ceilingRanked.join('\n')}`,
    `RETAIL PRICES POST-16-JUL-2026 (${db.retailPrices.length} total, top relevant shown):\n${retailRanked.join('\n')}`,
    nlemMatches.length > 0
      ? `MATCHING NLEM 2022 ENTRIES:\n${nlemMatches.join('\n')}`
      : `NLEM 2022 DIRECTORY SIZE: ${db.nlem2022.length} essential medicines`,
    `RECENT NPPA CIRCULARS & MINUTES:\n${recentLogs.join('\n')}`,
  ].join('\n\n');
}

export async function askComplianceAssistant(params: {
  message: string;
  history: AiChatHistoryTurn[];
  useWebSearch: boolean;
}): Promise<{ reply: string; sources: AiGroundingSource[] }> {
  const ai = getGeminiClient();
  const context = buildRegistryContext(params.message);

  const systemInstruction = `You are an expert Indian pharmaceutical regulatory compliance advisor specializing in NPPA (National Pharmaceutical Pricing Authority), DPCO 2013 (Drugs Prices Control Order), NLEM 2022, Form I (new drug price fixation for existing manufacturers), Form 1A (retail price benchmark filing), and Form V price list compliance.
Answer clearly, accurately, and concisely using structured bullet points where helpful.
Always check the LIVE WORKSPACE REGISTRY CONTEXT below when citing internal ceiling prices, retail prices, company SKUs, or notifications. Distinguish clearly between facts from the user's registry and general DPCO 2013 rules or live web search findings.
Keep responses practical and focused (under ~350 words unless detailed breakdown is requested).

LIVE WORKSPACE REGISTRY CONTEXT:
${context}`;

  const contents: Content[] = [
    ...params.history.slice(-8).map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    })),
    {
      role: 'user',
      parts: [{ text: params.message }],
    },
  ];

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction,
      ...(params.useWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
    },
  });

  const reply = (response.text || '').trim();
  const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seenUris = new Set<string>();
  const sources: AiGroundingSource[] = [];

  for (const chunk of rawChunks) {
    const uri = chunk.web?.uri;
    const title = chunk.web?.title || uri;
    if (uri && !seenUris.has(uri)) {
      seenUris.add(uri);
      sources.push({ title: title || 'NPPA / Web Reference', uri });
    }
  }

  return {
    reply: reply || 'No regulatory response was returned.',
    sources,
  };
}

export async function aiExtractNotificationRows(params: {
  rawText: string;
  notificationNumber?: string;
  notificationDate?: string;
  defaultKind?: 'auto' | 'ceiling' | 'retail';
}): Promise<AiParsedNotificationRow[]> {
  const ai = getGeminiClient();
  const fallbackNo = params.notificationNumber?.trim() || 'S.O. Pending';
  const fallbackDate =
    params.notificationDate?.trim() || new Date().toISOString().slice(0, 10);

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Extract all medicine pricing entries from the following NPPA Gazette / S.O. Notification text.
Default notification number if missing in text: ${fallbackNo}
Default notification date (YYYY-MM-DD) if missing in text: ${fallbackDate}
Mode hint: ${params.defaultKind || 'auto'} ("ceiling" = scheduled NLEM ceiling price, "retail" = non-scheduled / FDC retail price under Form 1A, "auto" = infer per line: FDCs or mentions of retail price/Form 1A are "retail", single NLEM scheduled formulations or ceiling prices are "ceiling").

TEXT TO PARSE:
${params.rawText}`,
    config: {
      systemInstruction:
        'You are an NPPA Gazette pricing parser. Extract exact prices in INR (numbers only), medicine names, active composition, strengths (e.g. 10mg, 500mg + 50mg), dosage formats (Tablet, Capsule, Injection, Syrup, Inhaler), and unit labels (e.g. 1 Tablet, 1 Vial). Only return entries that actually contain a valid price in the input text.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            kind: {
              type: Type.STRING,
              description: 'Either "ceiling" or "retail".',
            },
            medicineName: {
              type: Type.STRING,
              description: 'Short medicine or formulation name.',
            },
            composition: {
              type: Type.STRING,
              description: 'Full chemical composition and strengths.',
            },
            strength: {
              type: Type.STRING,
              description: 'Strength string such as 40mg or 10mg+75mg.',
            },
            dosageFormat: {
              type: Type.STRING,
              description: 'Dosage form such as Tablet, Capsule, Injection, Syrup.',
            },
            unitLabel: {
              type: Type.STRING,
              description: 'Pack/unit basis such as 1 Tablet, 1 Capsule, 1 Vial.',
            },
            price: {
              type: Type.NUMBER,
              description: 'Notified ceiling or retail price in INR.',
            },
            notificationNumber: {
              type: Type.STRING,
              description: 'S.O. notification number.',
            },
            notificationDate: {
              type: Type.STRING,
              description: 'Notification date in YYYY-MM-DD format.',
            },
            nlemSection: {
              type: Type.STRING,
              description: 'NLEM 2022 section code if mentioned, else NLEM 2022.',
            },
          },
          required: [
            'kind',
            'medicineName',
            'composition',
            'strength',
            'dosageFormat',
            'unitLabel',
            'price',
            'notificationNumber',
            'notificationDate',
            'nlemSection',
          ],
        },
      },
    },
  });

  const text = (response.text || '[]').trim();
  const parsed = JSON.parse(text) as Array<Partial<AiParsedNotificationRow>>;
  return parsed
    .filter((row) => row.medicineName && typeof row.price === 'number' && row.price > 0)
    .map((row) => ({
      kind: row.kind === 'retail' ? 'retail' : 'ceiling',
      medicineName: String(row.medicineName).trim(),
      composition: String(row.composition || row.medicineName).trim(),
      strength: String(row.strength || 'As notified').trim(),
      dosageFormat: String(row.dosageFormat || 'Tablet').trim(),
      unitLabel: String(row.unitLabel || `1 ${row.dosageFormat || 'Tablet'}`).trim(),
      price: Number(row.price),
      notificationNumber: String(row.notificationNumber || fallbackNo).trim(),
      notificationDate: String(row.notificationDate || fallbackDate).trim(),
      nlemSection: String(row.nlemSection || 'NLEM 2022').trim(),
    }));
}

export async function aiGenerateForm1Brief(
  checkResult: Form1CheckResult
): Promise<AiForm1Brief> {
  const ai = getGeminiClient();
  const db = loadDb();

  const matchingRetail = db.retailPrices
    .filter((r) =>
      checkResult.matches.some(
        (m) =>
          m.matchedMedicine &&
          r.formulation.toLowerCase().includes(m.matchedMedicine.toLowerCase())
      )
    )
    .slice(0, 5)
    .map(
      (r) =>
        `${r.formulation}: ₹${r.retailPrice.toFixed(2)}/${r.unitLabel} (${r.notificationNumber}, ${r.notificationDate})`
    );

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Analyze this Form I screening result for ${db.companyProfile.companyName} and produce a structured regulatory action brief:

Proposed Product: ${checkResult.productName} (${checkResult.dosageForm})
Composition: ${checkResult.compositionText}
Scheduled Ingredient Detected: ${checkResult.hasScheduledIngredient}
Existing Manufacturer in Company Portfolio: ${checkResult.isExistingManufacturerInPortfolio}
Form I Triggered by Portfolio: ${checkResult.form1RequiredBasedOnPortfolio}
Summary: ${checkResult.summaryHeadline}
Matched Ingredients: ${JSON.stringify(
      checkResult.matches.map((m) => ({
        token: m.extractedToken,
        matchedMedicine: m.matchedMedicine,
        isNlem2022: m.isNlem2022,
        isOmitted: m.isOmittedFromNlem2022,
        companyMatches: m.companyMatches.map((c) => `${c.dosageForm} ${c.strength}`),
      }))
    )}
Matching Post-16-Jul-2026 Retail Price Circulars (Form 1A reference): ${
      matchingRetail.length > 0 ? matchingRetail.join('; ') : 'None found in registry yet'
    }`,
    config: {
      systemInstruction:
        'You are an NPPA DPCO 2013 compliance specialist. Generate concise, actionable regulatory guidance citing Para 2(u), Para 11/15, Form I, and Form 1A obligations accurately.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          riskLevel: {
            type: Type.STRING,
            description: 'High, Medium, or Low.',
          },
          verdictSummary: {
            type: Type.STRING,
            description: '2-sentence executive summary of Form I / Form 1A obligations.',
          },
          legalBasis: {
            type: Type.STRING,
            description: 'Relevant DPCO 2013 and NLEM 2022 legal rationale.',
          },
          actionChecklist: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '3 to 5 concise compliance action items before launch.',
          },
          form1aBenchmarkNote: {
            type: Type.STRING,
            description: 'Note on any matching post-16 Jul 2026 Form 1A retail price benchmarks.',
          },
        },
        required: [
          'riskLevel',
          'verdictSummary',
          'legalBasis',
          'actionChecklist',
          'form1aBenchmarkNote',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as Partial<AiForm1Brief>;
  const risk =
    parsed.riskLevel === 'High' || parsed.riskLevel === 'Low' ? parsed.riskLevel : 'Medium';

  return {
    riskLevel: risk,
    verdictSummary: String(parsed.verdictSummary || checkResult.summaryHeadline),
    legalBasis: String(parsed.legalBasis || checkResult.regulatoryGuidance),
    actionChecklist: Array.isArray(parsed.actionChecklist) ? parsed.actionChecklist : [],
    form1aBenchmarkNote: String(
      parsed.form1aBenchmarkNote ||
        (matchingRetail.length > 0
          ? `Found matching Form 1A circulars: ${matchingRetail.join('; ')}`
          : 'No matching Form 1A retail price benchmark currently logged.')
    ),
  };
}

export async function aiConvertPdfToComplianceData(params: {
  pdfBase64: string;
  fileName?: string;
  fallbackSoNumber?: string;
  fallbackSoDate?: string;
  defaultKind?: 'auto' | 'ceiling' | 'retail';
}): Promise<PdfConversionResult> {
  const ai = getGeminiClient();
  const cleanedBase64 = params.pdfBase64.replace(/^data:application\/pdf;base64,/i, '').trim();
  if (!cleanedBase64) {
    throw new Error('Uploaded PDF content is empty.');
  }

  const fallbackSo = params.fallbackSoNumber?.trim() || 'S.O. Unspecified';
  const fallbackDate = params.fallbackSoDate?.trim() || new Date().toISOString().slice(0, 10);
  const fileName = params.fileName?.trim() || 'nppa-notification.pdf';

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: cleanedBase64,
        },
      },
      {
        text: `Parse this NPPA (National Pharmaceutical Pricing Authority) Gazette / S.O. Notification PDF and convert its pricing schedule table into structured data.
1. Identify the Gazette S.O. Notification Number (e.g. "S.O. 4812(E)") and Notification Date in YYYY-MM-DD format. If not explicitly printed in the PDF, use "${fallbackSo}" and "${fallbackDate}".
2. Identify a concise document title.
3. Extract every medicine / formulation row from the pricing table with:
   - kind: "ceiling" for scheduled NLEM ceiling price notifications, or "retail" for Form 1A / FDC / non-scheduled retail price notifications (mode hint: "${params.defaultKind || 'auto'}").
   - medicineName, composition, strength, dosageFormat, unitLabel, price (numeric INR), notificationNumber, notificationDate (YYYY-MM-DD), and nlemSection.`,
      },
    ],
    config: {
      systemInstruction:
        'You are an NPPA DPCO 2013 Gazette PDF-to-table extractor. Read PDF tables carefully, preserve exact INR prices as numbers, convert any DD.MM.YYYY or text dates to YYYY-MM-DD, and never fabricate medicine entries not present in the PDF.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          soNumber: {
            type: Type.STRING,
            description: 'S.O. Notification Number found in the PDF header (e.g. S.O. 4812(E)).',
          },
          soDate: {
            type: Type.STRING,
            description: 'Notification issue date in YYYY-MM-DD format.',
          },
          documentTitle: {
            type: Type.STRING,
            description: 'Concise title describing this NPPA notification PDF.',
          },
          rows: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING },
                medicineName: { type: Type.STRING },
                composition: { type: Type.STRING },
                strength: { type: Type.STRING },
                dosageFormat: { type: Type.STRING },
                unitLabel: { type: Type.STRING },
                price: { type: Type.NUMBER },
                notificationNumber: { type: Type.STRING },
                notificationDate: { type: Type.STRING },
                nlemSection: { type: Type.STRING },
              },
              required: [
                'kind',
                'medicineName',
                'composition',
                'strength',
                'dosageFormat',
                'unitLabel',
                'price',
                'notificationNumber',
                'notificationDate',
                'nlemSection',
              ],
            },
          },
        },
        required: ['soNumber', 'soDate', 'documentTitle', 'rows'],
      },
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim()) as {
    soNumber?: string;
    soDate?: string;
    documentTitle?: string;
    rows?: Array<Partial<AiParsedNotificationRow>>;
  };

  const resolvedSo = String(parsed.soNumber || fallbackSo).trim() || fallbackSo;
  const resolvedDate = String(parsed.soDate || fallbackDate).trim() || fallbackDate;
  const rows: AiParsedNotificationRow[] = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter((row) => row.medicineName && typeof row.price === 'number' && row.price > 0)
    .map((row) => ({
      kind: row.kind === 'retail' ? 'retail' : 'ceiling',
      medicineName: String(row.medicineName).trim(),
      composition: String(row.composition || row.medicineName).trim(),
      strength: String(row.strength || 'As notified').trim(),
      dosageFormat: String(row.dosageFormat || 'Tablet').trim(),
      unitLabel: String(row.unitLabel || `1 ${row.dosageFormat || 'Tablet'}`).trim(),
      price: Number(row.price),
      notificationNumber: String(row.notificationNumber || resolvedSo).trim(),
      notificationDate: String(row.notificationDate || resolvedDate).trim(),
      nlemSection: String(row.nlemSection || 'NLEM 2022').trim(),
    }));

  return {
    soNumber: resolvedSo,
    soDate: resolvedDate,
    documentTitle: String(parsed.documentTitle || fileName).trim(),
    fileName,
    rows,
  };
}
