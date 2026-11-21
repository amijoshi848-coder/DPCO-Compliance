import React, { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  CalendarCheck2,
  Download,
  ExternalLink,
  FileDown,
  FileText,
  FileUp,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch, getStoredToken } from '../lib/api';
import { exportScheduleHistoryPdf, exportScheduleMasterPdf } from '../lib/pdfExport';
import type {
  AiParsedNotificationRow,
  AuthUser,
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  NppaDocumentLog,
  NppaLogCategory,
  NppaSourceType,
  PdfConversionResult,
  SoTrackingRecord,
  SyncLogEntry,
} from '../types/compliance';

interface ScheduleFormulationsTabProps {
  user: AuthUser;
  ceilingPrices: CeilingPriceEntry[];
  ceilingHistory: CeilingPriceHistoryEntry[];
  supersededCount?: number;
  nppaLogs: NppaDocumentLog[];
  ceilingLogs?: NppaDocumentLog[];
  retailLogs?: NppaDocumentLog[];
  meetingMinutesLogs?: NppaDocumentLog[];
  soTrackingRecords: SoTrackingRecord[];
  schedulerInfo: {
    scheduleTimeIst: string;
    currentIstDate: string;
    lastDailyRunDateIst: string | null;
  } | null;
  latestSync: SyncLogEntry | null;
  initialSearchQuery?: string;
  initialSubView?: 'master' | 'history' | 'so_tracker';
  onRefresh: () => Promise<void>;
}

export default function ScheduleFormulationsTab({
  user,
  ceilingPrices,
  ceilingHistory,
  supersededCount = 0,
  nppaLogs,
  ceilingLogs,
  retailLogs,
  meetingMinutesLogs,
  soTrackingRecords,
  schedulerInfo,
  latestSync,
  initialSearchQuery,
  initialSubView,
  onRefresh,
}: ScheduleFormulationsTabProps) {
  const isAdmin = user.role === 'admin';

  // Converter controls
  const [priceSubView, setPriceSubView] = useState<'master' | 'history' | 'so_tracker'>(
    initialSubView || 'master'
  );
  const [gstRate, setGstRate] = useState<number>(12);
  const [packSize, setPackSize] = useState<number>(10);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');

  useEffect(() => {
    if (initialSearchQuery !== undefined) {
      setSearchQuery(initialSearchQuery);
    }
  }, [initialSearchQuery]);

  useEffect(() => {
    if (initialSubView) {
      setPriceSubView(initialSubView);
    }
  }, [initialSubView]);
  const [activeLogTab, setActiveLogTab] = useState<NppaLogCategory>('ceiling_price');
  const [minutesSubFilter, setMinutesSubFilter] = useState<
    'all' | 'authority_minutes' | 'expert_committee'
  >('all');
  const [syncing, setSyncing] = useState(false);
  const [syncBanner, setSyncBanner] = useState<string | null>(null);
  const [downloadingLogId, setDownloadingLogId] = useState<string | null>(null);
  const [convertingLogId, setConvertingLogId] = useState<string | null>(null);
  const [pdfFeedError, setPdfFeedError] = useState<string | null>(null);

  // PDF-to-Data Converter modal state
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfFile, setPdfFile] = useState<{ name: string; base64: string } | null>(null);
  const [pdfDefaultKind, setPdfDefaultKind] = useState<'auto' | 'ceiling' | 'retail'>('auto');
  const [pdfFallbackSoNo, setPdfFallbackSoNo] = useState('');
  const [pdfFallbackSoDate, setPdfFallbackSoDate] = useState(new Date().toISOString().slice(0, 10));
  const [pdfConverting, setPdfConverting] = useState(false);
  const [pdfApplying, setPdfApplying] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfSuccess, setPdfSuccess] = useState<string | null>(null);
  const [pdfResult, setPdfResult] = useState<PdfConversionResult | null>(null);
  const [pdfSourceMeta, setPdfSourceMeta] = useState<{
    sourceType: 'pdf_upload' | 'nppa_pdf_url';
    sourceFileName?: string;
    sourceUrl?: string;
    logId?: string;
  }>({ sourceType: 'pdf_upload' });

  // Notification parser modal state (Admin)
  const [showParserModal, setShowParserModal] = useState(false);
  const [parserText, setParserText] = useState(
    'Atorvastatin 10mg Tablet Rs. 5.82\nTelmisartan 40mg Tablet Rs. 6.95'
  );
  const [parserNotifNo, setParserNotifNo] = useState('S.O. 4950(E)');
  const [parserNotifDate, setParserNotifDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [parserResultMsg, setParserResultMsg] = useState<string | null>(null);
  const [parserErrorMsg, setParserErrorMsg] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [aiExtracting, setAiExtracting] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiRows, setAiRows] = useState<AiParsedNotificationRow[]>([]);

  // Admin modal state for Ceiling Price
  const [showModal, setShowModal] = useState(false);
  const [editingItem, setEditingItem] = useState<CeilingPriceEntry | null>(null);
  const [formState, setFormState] = useState({
    medicineName: '',
    composition: '',
    strength: '',
    dosageFormat: 'Tablet',
    unitLabel: '1 Tablet',
    ceilingPrice: '',
    notificationNumber: '',
    notificationDate: new Date().toISOString().slice(0, 10),
    effectiveDate: new Date().toISOString().slice(0, 10),
    nlemSection: '',
    gstDefault: '12',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Admin manual log add
  const [showLogForm, setShowLogForm] = useState(false);
  const [logForm, setLogForm] = useState({
    logCategory: 'ceiling_price' as NppaLogCategory,
    sourceType: 'circular' as NppaSourceType,
    title: '',
    referenceNumber: '',
    publishedDate: new Date().toISOString().slice(0, 10),
    summary: '',
  });

  const filteredPrices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ceilingPrices;
    return ceilingPrices.filter(
      (item) =>
        item.medicineName.toLowerCase().includes(q) ||
        item.composition.toLowerCase().includes(q) ||
        item.strength.toLowerCase().includes(q) ||
        item.dosageFormat.toLowerCase().includes(q) ||
        item.notificationNumber.toLowerCase().includes(q)
    );
  }, [ceilingPrices, searchQuery]);

  const [visiblePriceCount, setVisiblePriceCount] = useState(50);
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [visibleLogCount, setVisibleLogCount] = useState(25);
  const [backfilling, setBackfilling] = useState(false);

  const groupedLogs = useMemo(() => {
    if (
      ceilingLogs !== undefined &&
      retailLogs !== undefined &&
      meetingMinutesLogs !== undefined &&
      (ceilingLogs.length > 0 || retailLogs.length > 0 || meetingMinutesLogs.length > 0 || nppaLogs.length === 0)
    ) {
      return {
        ceiling_price: ceilingLogs,
        retail_price: retailLogs,
        meeting_minutes: meetingMinutesLogs,
      };
    }
    const cp: NppaDocumentLog[] = [];
    const rp: NppaDocumentLog[] = [];
    const mm: NppaDocumentLog[] = [];
    for (const l of nppaLogs) {
      if (l.logCategory === 'meeting_minutes' || l.sourceType === 'authority_minutes' || l.sourceType === 'expert_committee') {
        mm.push(l);
      } else if (
        l.logCategory === 'retail_price' ||
        (/(?:retail\s*price|form\s*1a|form\s*ia|new\s*drug)/i.test(`${l.title} ${l.summary}`) &&
          !/ceiling\s*price/i.test(`${l.title} ${l.summary}`))
      ) {
        rp.push(l);
      } else {
        cp.push(l);
      }
    }
    return {
      ceiling_price: cp,
      retail_price: rp,
      meeting_minutes: mm,
    };
  }, [ceilingLogs, retailLogs, meetingMinutesLogs, nppaLogs]);

  const filteredLogs = useMemo(() => {
    const q = logSearchQuery.trim().toLowerCase();
    const bucket = groupedLogs[activeLogTab] || [];
    return bucket.filter((l) => {
      if (
        activeLogTab === 'meeting_minutes' &&
        minutesSubFilter !== 'all' &&
        l.sourceType !== minutesSubFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        l.title.toLowerCase().includes(q) ||
        l.referenceNumber.toLowerCase().includes(q) ||
        l.publishedDate.toLowerCase().includes(q) ||
        (l.summary || '').toLowerCase().includes(q)
      );
    });
  }, [groupedLogs, activeLogTab, minutesSubFilter, logSearchQuery]);

  function openCreateModal() {
    const today = new Date().toISOString().slice(0, 10);
    setEditingItem(null);
    setFormState({
      medicineName: '',
      composition: '',
      strength: '',
      dosageFormat: 'Tablet',
      unitLabel: '1 Tablet',
      ceilingPrice: '',
      notificationNumber: 'S.O. ',
      notificationDate: today,
      effectiveDate: today,
      nlemSection: '12.4',
      gstDefault: '12',
    });
    setFormError(null);
    setShowModal(true);
  }

  function openEditModal(item: CeilingPriceEntry) {
    setEditingItem(item);
    setFormState({
      medicineName: item.medicineName,
      composition: item.composition,
      strength: item.strength,
      dosageFormat: item.dosageFormat,
      unitLabel: item.unitLabel,
      ceilingPrice: String(item.ceilingPrice),
      notificationNumber: item.notificationNumber,
      notificationDate: item.notificationDate,
      effectiveDate: item.effectiveDate || item.notificationDate,
      nlemSection: item.nlemSection,
      gstDefault: String(item.gstDefault),
    });
    setFormError(null);
    setShowModal(true);
  }

  async function handleSaveCeilingPrice(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        ...formState,
        ceilingPrice: Number(formState.ceilingPrice),
        gstDefault: Number(formState.gstDefault),
      };
      if (editingItem) {
        await apiFetch(`/api/ceiling-prices/${editingItem.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/ceiling-prices', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowModal(false);
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save ceiling price.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCeilingPrice(id: string) {
    await apiFetch(`/api/ceiling-prices/${id}`, { method: 'DELETE' });
    await onRefresh();
  }

  async function handleSyncNppa() {
    setSyncing(true);
    setSyncBanner(null);
    try {
      const res = await apiFetch<{ syncResult: SyncLogEntry }>('/api/nppa-logs/sync', {
        method: 'POST',
      });
      setSyncBanner(res.syncResult.message);
      await onRefresh();
    } catch (err) {
      setSyncBanner(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleAddLog(e: React.FormEvent) {
    e.preventDefault();
    const resolvedSourceType: NppaSourceType =
      logForm.logCategory === 'meeting_minutes'
        ? logForm.sourceType === 'expert_committee'
          ? 'expert_committee'
          : 'authority_minutes'
        : 'circular';
    await apiFetch('/api/nppa-logs', {
      method: 'POST',
      body: JSON.stringify({
        ...logForm,
        sourceType: resolvedSourceType,
      }),
    });
    setShowLogForm(false);
    setLogForm({
      logCategory: activeLogTab,
      sourceType: 'circular',
      title: '',
      referenceNumber: '',
      publishedDate: new Date().toISOString().slice(0, 10),
      summary: '',
    });
    await onRefresh();
  }

  async function handleBackfillSince2025() {
    setBackfilling(true);
    setSyncBanner(null);
    setPdfFeedError(null);
    try {
      const res = await apiFetch<{ syncEntry: SyncLogEntry }>('/api/nppa-logs/backfill', {
        method: 'POST',
        body: JSON.stringify({ sinceDate: '2025-01-01' }),
      });
      setSyncBanner(res.syncEntry.message);
      await onRefresh();
    } catch (err) {
      setPdfFeedError(err instanceof Error ? err.message : 'Unable to load 2025+ NPPA archive.');
    } finally {
      setBackfilling(false);
    }
  }

  async function handleDeleteLog(id: string) {
    await apiFetch(`/api/nppa-logs/${id}`, { method: 'DELETE' });
    await onRefresh();
  }

  async function handleDownloadLogPdf(doc: NppaDocumentLog) {
    setDownloadingLogId(doc.id);
    setPdfFeedError(null);
    try {
      const token = getStoredToken();
      const res = await fetch(`/api/nppa-logs/${doc.id}/download-pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status} downloading NPPA PDF.`);
      }
      const blob = await res.blob();
      const disp = res.headers.get('content-disposition') || '';
      const nameMatch = disp.match(/filename="?([^"]+)"?/i);
      const fileName =
        nameMatch?.[1] ||
        `${doc.referenceNumber.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'nppa-notice'}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPdfFeedError(err instanceof Error ? err.message : 'Unable to download NPPA PDF.');
    } finally {
      setDownloadingLogId(null);
    }
  }

  function openUploadPdfModal(prefillRef?: string, prefillDate?: string) {
    setPdfFile(null);
    setPdfResult(null);
    setPdfError(null);
    setPdfSuccess(null);
    setPdfFallbackSoNo(prefillRef || '');
    setPdfFallbackSoDate(prefillDate || new Date().toISOString().slice(0, 10));
    setPdfSourceMeta({ sourceType: 'pdf_upload' });
    setShowPdfModal(true);
  }

  async function handleConvertLogPdf(doc: NppaDocumentLog) {
    setConvertingLogId(doc.id);
    setPdfFeedError(null);
    try {
      const res = await apiFetch<{ result: PdfConversionResult; resolvedUrl: string }>(
        `/api/nppa-logs/${doc.id}/convert-pdf`,
        {
          method: 'POST',
          body: JSON.stringify({ defaultKind: 'auto' }),
        }
      );
      setPdfFile(null);
      setPdfResult(res.result);
      setPdfError(null);
      setPdfSuccess(null);
      setPdfFallbackSoNo(res.result.soNumber);
      setPdfFallbackSoDate(res.result.soDate);
      setPdfSourceMeta({
        sourceType: 'nppa_pdf_url',
        sourceFileName: res.result.fileName,
        sourceUrl: res.resolvedUrl || doc.pdfUrl || doc.url,
        logId: doc.id,
      });
      setShowPdfModal(true);
    } catch (err) {
      setPdfFeedError(
        err instanceof Error
          ? err.message
          : 'Could not convert remote NPPA PDF. Try "Upload & Convert PDF" with a local file.'
      );
    } finally {
      setConvertingLogId(null);
    }
  }

  function handlePdfFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setPdfError('Please select a valid .pdf file.');
      return;
    }
    setPdfError(null);
    setPdfSuccess(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      setPdfFile({ name: file.name, base64 });
      setPdfSourceMeta({
        sourceType: 'pdf_upload',
        sourceFileName: file.name,
      });
    };
    reader.onerror = () => {
      setPdfError('Failed to read selected PDF file.');
    };
    reader.readAsDataURL(file);
  }

  async function handleConvertUploadedPdf() {
    if (!pdfFile) {
      setPdfError('Please choose a PDF file first.');
      return;
    }
    setPdfConverting(true);
    setPdfError(null);
    setPdfSuccess(null);
    try {
      const res = await apiFetch<{ result: PdfConversionResult }>('/api/pdf/convert', {
        method: 'POST',
        body: JSON.stringify({
          pdfBase64: pdfFile.base64,
          fileName: pdfFile.name,
          fallbackSoNumber: pdfFallbackSoNo,
          fallbackSoDate: pdfFallbackSoDate,
          defaultKind: pdfDefaultKind,
        }),
      });
      setPdfResult(res.result);
      setPdfFallbackSoNo(res.result.soNumber);
      setPdfFallbackSoDate(res.result.soDate);
      if (res.result.rows.length === 0) {
        setPdfError('No formulation price rows were detected inside this PDF.');
      }
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'PDF conversion failed.');
    } finally {
      setPdfConverting(false);
    }
  }

  async function handleApplyPdfRows() {
    if (!pdfResult || pdfResult.rows.length === 0) return;
    setPdfApplying(true);
    setPdfError(null);
    setPdfSuccess(null);
    try {
      const finalSoNo = pdfResult.soNumber.trim() || pdfFallbackSoNo.trim() || 'S.O. Unspecified';
      const finalSoDate =
        pdfResult.soDate.trim() || pdfFallbackSoDate.trim() || new Date().toISOString().slice(0, 10);

      const res = await apiFetch<{
        ceilingAdded: number;
        ceilingRevised: number;
        retailAdded: number;
        soRecord: SoTrackingRecord | null;
      }>('/api/ai/apply-extracted-rows', {
        method: 'POST',
        body: JSON.stringify({
          rows: pdfResult.rows,
          soNumber: finalSoNo,
          soDate: finalSoDate,
          sourceType: pdfSourceMeta.sourceType,
          sourceFileName: pdfSourceMeta.sourceFileName || pdfResult.fileName,
          sourceUrl: pdfSourceMeta.sourceUrl,
          logId: pdfSourceMeta.logId,
        }),
      });

      setPdfSuccess(
        `Stored under ${finalSoNo} (${finalSoDate}): ${res.ceilingAdded} ceiling added, ${res.ceilingRevised} ceiling revised, ${res.retailAdded} retail price(s) added.`
      );
      setPdfResult(null);
      setPdfFile(null);
      await onRefresh();
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Failed to store converted PDF entries.');
    } finally {
      setPdfApplying(false);
    }
  }

  const calcUnitMrp = (cp: number) => cp + cp * (gstRate / 100);
  const calcPackMrp = (cp: number) => calcUnitMrp(cp) * Math.max(1, packSize);

  const sourceLabel = (doc: NppaDocumentLog) => {
    if (doc.logCategory === 'meeting_minutes' || doc.sourceType === 'authority_minutes' || doc.sourceType === 'expert_committee') {
      return doc.sourceType === 'expert_committee' ? 'Expert Committee Minutes' : 'Authority Meeting Minutes';
    }
    if (doc.logCategory === 'retail_price') return 'Retail Price Log (Form 1A)';
    return 'Ceiling Price Circular';
  };

  return (
    <div className="space-y-8">
      {/* Ceiling Price to MRP Conversion Toolbar */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Schedule Formulations — Ceiling Price Master &amp; MRP Calculator
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Showing latest notified ceiling price per formulation to be implemented ({ceilingPrices.length} active
              {supersededCount > 0 ? ` · ${supersededCount} superseded historical record(s) archived` : ''}).{' '}
              <span className="font-mono text-xs text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
                MRP = (Ceiling Price + GST%) × Pack Size
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (priceSubView === 'master') {
                  exportScheduleMasterPdf({
                    items: filteredPrices,
                    gstRate,
                    packSize,
                    searchQuery,
                  });
                } else {
                  exportScheduleHistoryPdf(ceilingHistory);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileDown className="w-3.5 h-3.5" />
              Export PDF
            </button>
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => openUploadPdfModal()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-950 bg-[#ECFDF5] border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileUp className="w-3.5 h-3.5" />
                  Upload &amp; Convert PDF
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setParserResultMsg(null);
                    setParserErrorMsg(null);
                    setAiRows([]);
                    setShowParserModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-violet-950 bg-[#F5F3FF] border border-violet-200 rounded-lg hover:bg-violet-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  AI / Parse Notification
                </button>
                <button
                  type="button"
                  onClick={openCreateModal}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Add Ceiling Price
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setPriceSubView('master')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                priceSubView === 'master'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Ceiling Price Master ({ceilingPrices.length})
            </button>
            <button
              type="button"
              onClick={() => setPriceSubView('history')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                priceSubView === 'history'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Update History &amp; Change Log ({ceilingHistory.length})
            </button>
            <button
              type="button"
              onClick={() => setPriceSubView('so_tracker')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                priceSubView === 'so_tracker'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              S.O. Notification Tracker ({soTrackingRecords.length})
            </button>
          </div>
          <span className="text-xs text-slate-500 font-mono">
            Daily Auto-Check: 10:00 AM IST{' '}
            {schedulerInfo?.lastDailyRunDateIst
              ? `· Last IST Run: ${schedulerInfo.lastDailyRunDateIst}`
              : ''}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 pt-5 items-end">
          <div className="md:col-span-6">
            <label htmlFor="cp-search" className="block text-xs font-medium text-slate-600 mb-1.5">
              Search Formulation, Strength, or S.O. Notification
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="cp-search"
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setVisiblePriceCount(50);
                }}
                placeholder="e.g. Atorvastatin, 40mg, Tablet, S.O. 1575..."
                className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label htmlFor="gst-select" className="block text-xs font-medium text-slate-600 mb-1.5">
              GST Rate (%)
            </label>
            <select
              id="gst-select"
              value={gstRate}
              onChange={(e) => setGstRate(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              <option value={0}>0% GST (Exempt)</option>
              <option value={5}>5% GST (Essential Schedule)</option>
              <option value={12}>12% GST (Standard Pharma)</option>
              <option value={18}>18% GST</option>
            </select>
          </div>

          <div className="md:col-span-3">
            <label htmlFor="pack-size" className="block text-xs font-medium text-slate-600 mb-1.5">
              Pack Size (Units / Strip / Vial)
            </label>
            <div className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                id="pack-size"
                type="number"
                min={1}
                max={1000}
                value={packSize}
                onChange={(e) => setPackSize(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>
        </div>

        {priceSubView === 'master' ? (
          <div className="mt-5 overflow-x-auto border border-indigo-100 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#EEF2FF] border-b border-indigo-100 text-xs font-semibold text-indigo-950">
                  <th className="py-3 px-4">Medicine &amp; Composition</th>
                  <th className="py-3 px-3">Strength &amp; Format</th>
                  <th className="py-3 px-3">Notification</th>
                  <th className="py-3 px-3 text-right">Ceiling Price (₹)</th>
                  <th className="py-3 px-3 text-right">Unit MRP w/ {gstRate}% GST</th>
                  <th className="py-3 px-4 text-right">Pack MRP ({packSize} units)</th>
                  {isAdmin && <th className="py-3 px-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredPrices.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 7 : 6} className="py-8 text-center text-slate-500">
                      No scheduled formulations match your search filter.
                    </td>
                  </tr>
                ) : (
                  filteredPrices.slice(0, visiblePriceCount).map((item) => {
                    const unitMrp = calcUnitMrp(item.ceilingPrice);
                    const packMrp = calcPackMrp(item.ceilingPrice);
                    return (
                      <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{item.medicineName}</div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {item.composition} · Sec {item.nlemSection}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-slate-700 whitespace-nowrap">
                          {item.strength} · {item.dosageFormat}
                          <div className="text-xs text-slate-500">Per {item.unitLabel}</div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-mono text-xs font-medium text-slate-900 tabular-nums">
                            {item.notificationNumber}
                          </div>
                          <div className="font-mono text-xs text-slate-500 tabular-nums">
                            {item.notificationDate}
                            {item.effectiveDate && item.effectiveDate !== item.notificationDate
                              ? ` · w.e.f. ${item.effectiveDate}`
                              : ''}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                          ₹{item.ceilingPrice.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                          ₹{unitMrp.toFixed(2)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-blue-900">
                          ₹{packMrp.toFixed(2)}
                        </td>
                        {isAdmin && (
                          <td className="py-3 px-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => openEditModal(item)}
                              title="Edit ceiling price"
                              className="p-1.5 text-slate-500 hover:text-blue-800 rounded cursor-pointer"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCeilingPrice(item.id)}
                              title="Delete ceiling price"
                              className="p-1.5 text-slate-500 hover:text-red-700 rounded cursor-pointer ml-1"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {filteredPrices.length > visiblePriceCount && (
              <div className="px-4 py-3 bg-slate-50 border-t border-indigo-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span>
                  Showing {Math.min(visiblePriceCount, filteredPrices.length)} of{' '}
                  {filteredPrices.length} scheduled formulations
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVisiblePriceCount((c) => c + 50)}
                    className="px-3.5 py-1.5 font-medium text-indigo-900 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
                  >
                    Load 50 More
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisiblePriceCount(filteredPrices.length)}
                    className="px-3.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Show All ({filteredPrices.length})
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : priceSubView === 'history' ? (
          <div className="mt-5 overflow-x-auto border border-violet-100 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F3FF] border-b border-violet-100 text-xs font-semibold text-violet-950">
                  <th className="py-3 px-4">Formulation</th>
                  <th className="py-3 px-3">Change</th>
                  <th className="py-3 px-3 text-right">Previous → New (₹)</th>
                  <th className="py-3 px-3">Notification</th>
                  <th className="py-3 px-4">Updated By &amp; Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {ceilingHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No ceiling price revisions logged yet.
                    </td>
                  </tr>
                ) : (
                  ceilingHistory.map((h) => (
                    <tr key={h.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">
                          {h.medicineName} · {h.strength} {h.dosageFormat}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{h.notes}</div>
                      </td>
                      <td className="py-3 px-3 text-xs font-semibold">
                        <span
                          className={
                            h.changeType === 'deleted'
                              ? 'text-red-700'
                              : h.changeType === 'revised'
                                ? 'text-amber-800'
                                : 'text-emerald-700'
                          }
                        >
                          {h.changeType === 'created'
                            ? 'New Notification'
                            : h.changeType === 'revised'
                              ? 'Price Revised'
                              : 'Deleted'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        {h.previousCeilingPrice != null
                          ? `₹${h.previousCeilingPrice.toFixed(2)}`
                          : '—'}{' '}
                        →{' '}
                        <span className="font-semibold text-slate-900">
                          {h.newCeilingPrice != null ? `₹${h.newCeilingPrice.toFixed(2)}` : 'Removed'}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-xs tabular-nums whitespace-nowrap">
                        <div>{h.notificationNumber}</div>
                        <div className="text-slate-500">{h.notificationDate}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        <div>{h.changedBy}</div>
                        <div className="font-mono text-slate-400 tabular-nums">
                          {new Date(h.timestamp).toLocaleString()}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto border border-emerald-100 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#ECFDF5] border-b border-emerald-100 text-xs font-semibold text-emerald-950">
                  <th className="py-3 px-4">S.O. Number &amp; Date</th>
                  <th className="py-3 px-3">Source &amp; Document</th>
                  <th className="py-3 px-3 text-right">Stored Entries</th>
                  <th className="py-3 px-3">Imported By &amp; Timestamp</th>
                  <th className="py-3 px-4 text-right">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {soTrackingRecords.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No S.O. notifications tracked yet. Upload or convert an NPPA PDF to log S.O. tracking.
                    </td>
                  </tr>
                ) : (
                  soTrackingRecords.map((rec) => (
                    <tr key={rec.id} className="hover:bg-slate-50">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="font-mono text-xs font-semibold text-slate-900">
                          {rec.soNumber}
                        </div>
                        <div className="font-mono text-xs text-slate-500 tabular-nums mt-0.5">
                          S.O. Date: {rec.soDate}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="text-xs font-semibold text-indigo-900">
                          {rec.sourceType === 'pdf_upload'
                            ? 'Uploaded PDF Conversion'
                            : rec.sourceType === 'nppa_pdf_url'
                              ? 'NPPA Portal PDF Conversion'
                              : rec.sourceType === 'daily_nppa_sync'
                                ? 'NPPA Sync / Registry'
                                : 'Manual / Parser Entry'}
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          {rec.sourceFileName || rec.notes || rec.sourceUrl || 'NPPA S.O. Notification'}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums whitespace-nowrap">
                        <div className="text-slate-900 font-semibold">
                          {rec.ceilingCount} ceiling
                        </div>
                        <div className="text-emerald-800">{rec.retailCount} retail</div>
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-600">
                        <div>{rec.importedBy}</div>
                        <div className="font-mono text-slate-400 tabular-nums">
                          {new Date(rec.importedAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery(rec.soNumber);
                            setPriceSubView('master');
                          }}
                          className="px-2.5 py-1 text-xs font-medium text-indigo-800 bg-[#EEF2FF] border border-indigo-200 rounded-md hover:bg-indigo-100 cursor-pointer"
                        >
                          Filter Master
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3 Separate NPPA Logs: Ceiling Price, Retail Price & Meeting Minutes */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              NPPA Website Notifications — 3 Separate Regulatory Logs
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Automatically classifies NPPA portal updates at{' '}
              <span className="font-mono font-medium">10:00 AM IST</span> into three separate logs:{' '}
              <span className="font-medium text-slate-800">Ceiling Price</span>,{' '}
              <span className="font-medium text-slate-800">Retail Price</span>, and{' '}
              <span className="font-medium text-slate-800">Meeting Minutes</span>.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setLogForm((prev) => ({ ...prev, logCategory: activeLogTab }));
                  setShowLogForm((v) => !v);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Log Entry
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={handleBackfillSince2025}
                disabled={backfilling || syncing}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-900 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {backfilling ? 'Loading 2025+ Archive…' : 'Load Since Jan 2025'}
              </button>
            )}
            <button
              type="button"
              onClick={handleSyncNppa}
              disabled={syncing || backfilling}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Checking NPPA Portals…' : 'Sync NPPA Portals Now'}
            </button>
          </div>
        </div>

        {(syncBanner || latestSync || schedulerInfo) && (
          <div className="mt-4 p-3.5 rounded-lg bg-[#EEF2FF]/70 border border-indigo-100 text-xs text-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="space-y-0.5">
              <div>
                <span className="font-semibold text-slate-900">Sync Status: </span>
                {syncBanner || latestSync?.message || 'Daily 10:00 AM IST monitor active.'}
              </div>
              {schedulerInfo && (
                <div className="text-indigo-900 flex items-center gap-1.5">
                  <CalendarCheck2 className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Daily IST Check Status:{' '}
                    {schedulerInfo.lastDailyRunDateIst === schedulerInfo.currentIstDate
                      ? `Completed for today (${schedulerInfo.currentIstDate})`
                      : `Pending / Scheduled at 10:00 AM IST (Last run: ${schedulerInfo.lastDailyRunDateIst || 'None'})`}
                  </span>
                </div>
              )}
            </div>
            {latestSync && (
              <span className="font-mono text-slate-500 whitespace-nowrap shrink-0">
                Last Run: {new Date(latestSync.timestamp).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {pdfFeedError && (
          <div className="mt-3 p-3.5 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900 flex items-center justify-between gap-3">
            <span>{pdfFeedError}</span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => openUploadPdfModal()}
                className="px-3 py-1 text-xs font-semibold text-rose-950 bg-white border border-rose-300 rounded-md hover:bg-rose-50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Upload Local PDF
              </button>
            )}
          </div>
        )}

        {showLogForm && isAdmin && (
          <form onSubmit={handleAddLog} className="mt-4 p-4 rounded-lg border border-slate-200 bg-slate-50 grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-3">
              <label className="block text-xs font-medium text-slate-600 mb-1">Log Category</label>
              <select
                value={logForm.logCategory}
                onChange={(e) => {
                  const nextCat = e.target.value as NppaLogCategory;
                  setLogForm({
                    ...logForm,
                    logCategory: nextCat,
                    sourceType:
                      nextCat === 'meeting_minutes'
                        ? logForm.sourceType === 'expert_committee'
                          ? 'expert_committee'
                          : 'authority_minutes'
                        : 'circular',
                  });
                }}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="ceiling_price">Ceiling Price Log</option>
                <option value="retail_price">Retail Price Log</option>
                <option value="meeting_minutes">Meeting Minutes Log</option>
              </select>
            </div>
            {logForm.logCategory === 'meeting_minutes' && (
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Minutes Type</label>
                <select
                  value={logForm.sourceType === 'expert_committee' ? 'expert_committee' : 'authority_minutes'}
                  onChange={(e) =>
                    setLogForm({ ...logForm, sourceType: e.target.value as NppaSourceType })
                  }
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="authority_minutes">Authority Minutes</option>
                  <option value="expert_committee">Expert Committee</option>
                </select>
              </div>
            )}
            <div className={logForm.logCategory === 'meeting_minutes' ? 'md:col-span-2' : 'md:col-span-3'}>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reference No.</label>
              <input
                type="text"
                required
                value={logForm.referenceNumber}
                onChange={(e) => setLogForm({ ...logForm, referenceNumber: e.target.value })}
                placeholder="S.O. 1575(E) or MDC/75"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
              <input
                type="date"
                required
                value={logForm.publishedDate}
                onChange={(e) => setLogForm({ ...logForm, publishedDate: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              />
            </div>
            <div className={logForm.logCategory === 'meeting_minutes' ? 'md:col-span-3' : 'md:col-span-4'}>
              <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
              <input
                type="text"
                required
                value={logForm.title}
                onChange={(e) => setLogForm({ ...logForm, title: e.target.value })}
                placeholder="Notification or minutes title"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              />
            </div>
            <div className="md:col-span-9">
              <input
                type="text"
                value={logForm.summary}
                onChange={(e) => setLogForm({ ...logForm, summary: e.target.value })}
                placeholder="Brief summary of ceiling/retail price or committee decision"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              />
            </div>
            <div className="md:col-span-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowLogForm(false)}
                className="px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 hover:bg-indigo-800 rounded-lg cursor-pointer"
              >
                Save Log
              </button>
            </div>
          </form>
        )}

        {/* 3 Separate Log Tabs + Feed Search */}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  {
                    id: 'ceiling_price',
                    label: `Ceiling Price Log (${groupedLogs.ceiling_price.length})`,
                  },
                  {
                    id: 'retail_price',
                    label: `Retail Price Log (${groupedLogs.retail_price.length})`,
                  },
                  {
                    id: 'meeting_minutes',
                    label: `Meeting Minutes Log (${groupedLogs.meeting_minutes.length})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveLogTab(tab.id);
                    setVisibleLogCount(25);
                  }}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeLogTab === tab.id
                      ? 'bg-white text-indigo-950 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeLogTab === 'meeting_minutes' && (
              <div className="inline-flex items-center gap-1 p-1 bg-[#F5F3FF] border border-violet-100 rounded-lg">
                {(
                  [
                    { id: 'all', label: 'All Minutes' },
                    { id: 'authority_minutes', label: 'Authority Meetings' },
                    { id: 'expert_committee', label: 'Expert Committee' },
                  ] as const
                ).map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => {
                      setMinutesSubFilter(sub.id);
                      setVisibleLogCount(25);
                    }}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      minutesSubFilter === sub.id
                        ? 'bg-white text-violet-950 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {sub.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={logSearchQuery}
              onChange={(e) => {
                setLogSearchQuery(e.target.value);
                setVisibleLogCount(25);
              }}
              placeholder="Filter logs by title, date (2025-), S.O..."
              className="w-64 max-w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <a
                href="https://nppa.gov.in/en/view_more?id=4"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-blue-800"
              >
                Circulars Source <ExternalLink className="w-3 h-3" />
              </a>
              <span aria-hidden="true">·</span>
              <a
                href="https://nppa.gov.in/en/archieve"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-blue-800"
              >
                2025 Archive <ExternalLink className="w-3 h-3" />
              </a>
              <span aria-hidden="true">·</span>
              <a
                href="https://nppa.gov.in/en/expertscommittee"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-blue-800"
              >
                Expert Committee <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>

        {/* Clean Unboxed List */}
        <div className="mt-4 divide-y divide-slate-200 border-t border-slate-200">
          {filteredLogs.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              No notifications found in this log matching your current filter.
            </div>
          ) : null}
          {filteredLogs.slice(0, visibleLogCount).map((doc, idx) => (
            <div key={`${doc.id}-${idx}`} className="py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mb-1">
                  <span className="font-semibold text-blue-900">{sourceLabel(doc)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{doc.referenceNumber}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{doc.publishedDate}</span>
                  {doc.soImportedAt && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-emerald-700">
                        Tracked ({doc.importedEntryCount || 0} entries stored)
                      </span>
                    </>
                  )}
                </div>
                <h3 className="text-sm font-semibold text-slate-900">{doc.title}</h3>
                {doc.summary && <p className="text-sm text-slate-600 mt-1">{doc.summary}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleDownloadLogPdf(doc)}
                  disabled={downloadingLogId === doc.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  {downloadingLogId === doc.id ? 'Fetching PDF…' : 'Download PDF'}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleConvertLogPdf(doc)}
                    disabled={convertingLogId === doc.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-950 bg-[#ECFDF5] border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    {convertingLogId === doc.id ? 'Converting…' : 'Convert PDF to Data'}
                  </button>
                )}
                <a
                  href={doc.pdfUrl || doc.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                >
                  Open NPPA <ExternalLink className="w-3 h-3" />
                </a>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleDeleteLog(doc.id)}
                    title="Delete log entry"
                    className="p-1.5 text-slate-400 hover:text-red-700 rounded cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {filteredLogs.length > visibleLogCount && (
          <div className="mt-4 pt-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <span>
              Showing {Math.min(visibleLogCount, filteredLogs.length)} of {filteredLogs.length} notifications
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setVisibleLogCount((c) => c + 50)}
                className="px-3.5 py-1.5 font-medium text-indigo-900 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
              >
                Load 50 More
              </button>
              <button
                type="button"
                onClick={() => setVisibleLogCount(filteredLogs.length)}
                className="px-3.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Show All ({filteredLogs.length})
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Admin Add/Edit Ceiling Price Modal */}
      {showModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="font-display text-lg font-semibold text-slate-900">
                {editingItem ? 'Edit Ceiling Price Entry' : 'Add Ceiling Price Notification'}
              </h3>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {formError}
              </div>
            )}

            <form onSubmit={handleSaveCeilingPrice} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Medicine Name</label>
                  <input
                    type="text"
                    required
                    value={formState.medicineName}
                    onChange={(e) => setFormState({ ...formState, medicineName: e.target.value })}
                    placeholder="e.g. Atorvastatin"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">NLEM Section</label>
                  <input
                    type="text"
                    value={formState.nlemSection}
                    onChange={(e) => setFormState({ ...formState, nlemSection: e.target.value })}
                    placeholder="e.g. 12.4"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Composition</label>
                <input
                  type="text"
                  required
                  value={formState.composition}
                  onChange={(e) => setFormState({ ...formState, composition: e.target.value })}
                  placeholder="e.g. Atorvastatin Calcium IP eq. to Atorvastatin"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Strength</label>
                  <input
                    type="text"
                    required
                    value={formState.strength}
                    onChange={(e) => setFormState({ ...formState, strength: e.target.value })}
                    placeholder="40mg"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dosage Format</label>
                  <input
                    type="text"
                    required
                    value={formState.dosageFormat}
                    onChange={(e) => setFormState({ ...formState, dosageFormat: e.target.value })}
                    placeholder="Tablet"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Unit</label>
                  <input
                    type="text"
                    required
                    value={formState.unitLabel}
                    onChange={(e) => setFormState({ ...formState, unitLabel: e.target.value })}
                    placeholder="1 Tablet"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Ceiling Price (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={formState.ceilingPrice}
                    onChange={(e) => setFormState({ ...formState, ceilingPrice: e.target.value })}
                    placeholder="18.88"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Notification No.</label>
                  <input
                    type="text"
                    required
                    value={formState.notificationNumber}
                    onChange={(e) =>
                      setFormState({ ...formState, notificationNumber: e.target.value })
                    }
                    placeholder="S.O. 1575(E)"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Notification Date</label>
                  <input
                    type="date"
                    required
                    value={formState.notificationDate}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        notificationDate: e.target.value,
                        effectiveDate:
                          formState.effectiveDate === formState.notificationDate
                            ? e.target.value
                            : formState.effectiveDate,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Effective Date</label>
                  <input
                    type="date"
                    required
                    value={formState.effectiveDate}
                    onChange={(e) =>
                      setFormState({ ...formState, effectiveDate: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
                >
                  {saving ? 'Saving…' : editingItem ? 'Update Entry' : 'Save Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Notification Text & AI Parser Modal */}
      {showParserModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="font-display text-lg font-semibold text-slate-900">
                  Parse NPPA Notification Text (Standard &amp; AI Extract)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Paste raw S.O. Gazette text or schedule lines — extract via Gemini AI or standard line parser, preview, and update master + change history.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowParserModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {parserResultMsg && (
              <div className="mt-4 p-3 rounded-lg bg-[#ECFDF5] border border-emerald-200 text-xs text-emerald-900">
                {parserResultMsg}
              </div>
            )}

            {parserErrorMsg && (
              <div className="mt-4 p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
                {parserErrorMsg}
              </div>
            )}

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setParsing(true);
                setParserResultMsg(null);
                setParserErrorMsg(null);
                try {
                  const res = await apiFetch<{
                    result: { ceilingAdded: number; ceilingRevised: number; retailAdded: number };
                  }>('/api/nppa-logs/parse-notification', {
                    method: 'POST',
                    body: JSON.stringify({
                      rawText: parserText,
                      notificationNumber: parserNotifNo,
                      notificationDate: parserNotifDate,
                      defaultKind: 'ceiling',
                    }),
                  });
                  setParserResultMsg(
                    `Parsed successfully: ${res.result.ceilingAdded} added, ${res.result.ceilingRevised} ceiling price(s) revised, ${res.result.retailAdded} retail circular(s) added.`
                  );
                  await onRefresh();
                } catch (err) {
                  setParserErrorMsg(err instanceof Error ? err.message : 'Parser failed.');
                } finally {
                  setParsing(false);
                }
              }}
              className="mt-4 space-y-3.5"
            >
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Notification Number
                  </label>
                  <input
                    type="text"
                    required
                    value={parserNotifNo}
                    onChange={(e) => setParserNotifNo(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Notification Date
                  </label>
                  <input
                    type="date"
                    required
                    value={parserNotifDate}
                    onChange={(e) => setParserNotifDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Notification Schedule Text (Gazette paragraphs or table lines)
                </label>
                <textarea
                  rows={5}
                  required
                  value={parserText}
                  onChange={(e) => setParserText(e.target.value)}
                  placeholder="Atorvastatin 10mg Tablet Rs. 5.82&#10;Or paste full NPPA S.O. Gazette paragraph..."
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
              </div>

              <div className="pt-2 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowParserModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={aiExtracting || !parserText.trim()}
                  onClick={async () => {
                    setAiExtracting(true);
                    setParserResultMsg(null);
                    setParserErrorMsg(null);
                    try {
                      const res = await apiFetch<{ rows: AiParsedNotificationRow[] }>(
                        '/api/ai/extract-notification',
                        {
                          method: 'POST',
                          body: JSON.stringify({
                            rawText: parserText,
                            notificationNumber: parserNotifNo,
                            notificationDate: parserNotifDate,
                            defaultKind: 'auto',
                          }),
                        }
                      );
                      setAiRows(res.rows);
                      if (res.rows.length === 0) {
                        setParserErrorMsg('AI could not find any valid medicine prices in the supplied text.');
                      }
                    } catch (err) {
                      setParserErrorMsg(
                        err instanceof Error ? err.message : 'AI extraction failed.'
                      );
                    } finally {
                      setAiExtracting(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-violet-950 bg-[#F5F3FF] border border-violet-200 rounded-lg hover:bg-violet-100 disabled:opacity-60 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {aiExtracting ? 'AI Extracting…' : 'AI Smart Extract (Gemini)'}
                </button>
                <button
                  type="submit"
                  disabled={parsing}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
                >
                  {parsing ? 'Parsing & Updating…' : 'Quick Line Parse & Apply'}
                </button>
              </div>
            </form>

            {aiRows.length > 0 && (
              <div className="mt-5 pt-4 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-violet-950 uppercase tracking-wider">
                    AI Extracted Preview ({aiRows.length} entries)
                  </h4>
                  <button
                    type="button"
                    disabled={aiApplying}
                    onClick={async () => {
                      setAiApplying(true);
                      setParserErrorMsg(null);
                      try {
                        const res = await apiFetch<{
                          ceilingAdded: number;
                          ceilingRevised: number;
                          retailAdded: number;
                        }>('/api/ai/apply-extracted-rows', {
                          method: 'POST',
                          body: JSON.stringify({ rows: aiRows }),
                        });
                        setParserResultMsg(
                          `Applied AI extract: ${res.ceilingAdded} ceiling added, ${res.ceilingRevised} ceiling revised, ${res.retailAdded} retail circular(s) added.`
                        );
                        setAiRows([]);
                        await onRefresh();
                      } catch (err) {
                        setParserErrorMsg(
                          err instanceof Error ? err.message : 'Failed to apply extracted rows.'
                        );
                      } finally {
                        setAiApplying(false);
                      }
                    }}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-60 cursor-pointer"
                  >
                    {aiApplying ? 'Applying…' : 'Apply Extracted Rows to Master'}
                  </button>
                </div>

                <div className="overflow-x-auto border border-violet-100 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F5F3FF] border-b border-violet-100 text-violet-950 font-semibold">
                        <th className="py-2 px-3">Type</th>
                        <th className="py-2 px-3">Medicine &amp; Strength</th>
                        <th className="py-2 px-3">Notification</th>
                        <th className="py-2 px-3 text-right">Price (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {aiRows.map((row, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3 font-semibold uppercase text-indigo-800">
                            {row.kind}
                          </td>
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-900">
                              {row.medicineName} {row.strength} {row.dosageFormat}
                            </div>
                            <div className="text-slate-500">{row.unitLabel}</div>
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-600 tabular-nums">
                            {row.notificationNumber} · {row.notificationDate}
                          </td>
                          <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                            ₹{row.price.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Admin PDF-to-Data Converter & S.O. Tracking Modal */}
      {showPdfModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="font-display text-lg font-semibold text-slate-900">
                  Convert NPPA Notification PDF to Master Data &amp; Track S.O.
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Upload any NPPA S.O. Gazette PDF (or convert directly from an NPPA log), review extracted formulations &amp; S.O. metadata, and store into master tables.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPdfModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {pdfSuccess && (
              <div className="mt-4 p-3 rounded-lg bg-[#ECFDF5] border border-emerald-200 text-xs text-emerald-950">
                {pdfSuccess}
              </div>
            )}

            {pdfError && (
              <div className="mt-4 p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
                {pdfError}
              </div>
            )}

            {/* Step 1: Upload PDF */}
            <div className="mt-4 p-4 rounded-xl bg-[#FBFBFF] border border-indigo-100 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-5">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Select NPPA Notification PDF (.pdf)
                  </label>
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={handlePdfFileSelected}
                    className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-indigo-200 file:text-xs file:font-semibold file:bg-[#EEF2FF] file:text-indigo-950 hover:file:bg-indigo-100 cursor-pointer"
                  />
                </div>
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Notification Type
                  </label>
                  <select
                    value={pdfDefaultKind}
                    onChange={(e) =>
                      setPdfDefaultKind(e.target.value as 'auto' | 'ceiling' | 'retail')
                    }
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="auto">Auto-detect (Ceiling / Retail)</option>
                    <option value="ceiling">Ceiling Price (Scheduled)</option>
                    <option value="retail">Retail Price (Form 1A)</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Fallback S.O. No.
                  </label>
                  <input
                    type="text"
                    value={pdfFallbackSoNo}
                    onChange={(e) => setPdfFallbackSoNo(e.target.value)}
                    placeholder="S.O. 4955(E)"
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Fallback Date
                  </label>
                  <input
                    type="date"
                    value={pdfFallbackSoDate}
                    onChange={(e) => setPdfFallbackSoDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-xs text-slate-500 font-mono truncate">
                  {pdfFile
                    ? `Ready: ${pdfFile.name}`
                    : pdfResult
                      ? `Loaded from: ${pdfResult.fileName}`
                      : 'Choose a local PDF or trigger "Convert PDF to Data" on an NPPA log.'}
                </span>
                <button
                  type="button"
                  disabled={!pdfFile || pdfConverting}
                  onClick={handleConvertUploadedPdf}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {pdfConverting ? 'Converting PDF…' : 'Convert PDF to Data'}
                </button>
              </div>
            </div>

            {/* Step 2: Review Extracted S.O. Header + Rows & Store */}
            {pdfResult && (
              <div className="mt-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-lg bg-[#ECFDF5]/60 border border-emerald-200">
                  <div>
                    <label className="block text-[11px] font-semibold text-emerald-950 mb-1">
                      Tracked S.O. Number
                    </label>
                    <input
                      type="text"
                      value={pdfResult.soNumber}
                      onChange={(e) =>
                        setPdfResult({ ...pdfResult, soNumber: e.target.value })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono border border-emerald-300 rounded-lg bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-emerald-950 mb-1">
                      Tracked S.O. Date
                    </label>
                    <input
                      type="date"
                      value={pdfResult.soDate}
                      onChange={(e) =>
                        setPdfResult({ ...pdfResult, soDate: e.target.value })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono border border-emerald-300 rounded-lg bg-white"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <button
                      type="button"
                      disabled={pdfApplying || pdfResult.rows.length === 0}
                      onClick={handleApplyPdfRows}
                      className="w-full px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-50 cursor-pointer"
                    >
                      {pdfApplying
                        ? 'Storing Entries…'
                        : `Store ${pdfResult.rows.length} Entries & Track S.O.`}
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#EEF2FF] border-b border-indigo-100 text-indigo-950 font-semibold">
                        <th className="py-2 px-3">Type</th>
                        <th className="py-2 px-3">Medicine / Formulation</th>
                        <th className="py-2 px-3">Strength &amp; Format</th>
                        <th className="py-2 px-3 text-right">Price (₹)</th>
                        <th className="py-2 px-2 text-right">Remove</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {pdfResult.rows.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="py-2 px-3">
                            <select
                              value={row.kind}
                              onChange={(e) => {
                                const next = [...pdfResult.rows];
                                next[idx] = {
                                  ...next[idx],
                                  kind: e.target.value === 'retail' ? 'retail' : 'ceiling',
                                };
                                setPdfResult({ ...pdfResult, rows: next });
                              }}
                              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white font-semibold text-indigo-900"
                            >
                              <option value="ceiling">Ceiling</option>
                              <option value="retail">Retail (1A)</option>
                            </select>
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              value={row.medicineName}
                              onChange={(e) => {
                                const next = [...pdfResult.rows];
                                next[idx] = { ...next[idx], medicineName: e.target.value };
                                setPdfResult({ ...pdfResult, rows: next });
                              }}
                              className="w-full px-2 py-1 text-xs border border-slate-200 rounded font-medium text-slate-900"
                            />
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate max-w-xs">
                              {row.composition}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                            {row.strength} · {row.dosageFormat}
                            <div className="text-[11px] text-slate-400">{row.unitLabel}</div>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={row.price}
                              onChange={(e) => {
                                const next = [...pdfResult.rows];
                                next[idx] = {
                                  ...next[idx],
                                  price: Number(e.target.value) || 0,
                                };
                                setPdfResult({ ...pdfResult, rows: next });
                              }}
                              className="w-24 px-2 py-1 text-xs text-right font-mono tabular-nums border border-slate-200 rounded"
                            />
                          </td>
                          <td className="py-2 px-2 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setPdfResult({
                                  ...pdfResult,
                                  rows: pdfResult.rows.filter((_, rIdx) => rIdx !== idx),
                                });
                              }}
                              className="p-1 text-slate-400 hover:text-red-700 cursor-pointer"
                              title="Remove row"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
