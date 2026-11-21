import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  AiForm1Brief,
  AuthUser,
  CompanyProfile,
  Form1CheckResult,
  Nlem2022Entry,
} from '../types/compliance';

interface NewProductTabProps {
  user: AuthUser;
  nlemList: Nlem2022Entry[];
  company: CompanyProfile;
  initialNlemSearch?: string;
  onRefresh: () => Promise<void>;
}

export default function NewProductTab({
  user,
  nlemList,
  company,
  initialNlemSearch,
  onRefresh,
}: NewProductTabProps) {
  const isAdmin = user.role === 'admin';
  const [subTab, setSubTab] = useState<'checker' | 'nlem_list'>(
    initialNlemSearch ? 'nlem_list' : 'checker'
  );

  // Form I Checker state
  const [productName, setProductName] = useState('');
  const [dosageForm, setDosageForm] = useState('Tablet');
  const [compositionText, setCompositionText] = useState(
    'each tablet contains Atorvastatin 10mg, ranitidine 20mg'
  );
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Form1CheckResult | null>(null);
  const [manualManufacturedKeys, setManualManufacturedKeys] = useState<Record<string, boolean>>({});
  const [checkError, setCheckError] = useState<string | null>(null);
  const [aiBrief, setAiBrief] = useState<AiForm1Brief | null>(null);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  // NLEM 2022 directory state
  const [nlemSearch, setNlemSearch] = useState(initialNlemSearch || '');

  useEffect(() => {
    if (initialNlemSearch) {
      setSubTab('nlem_list');
      setNlemSearch(initialNlemSearch);
    }
  }, [initialNlemSearch]);
  const [showAddNlem, setShowAddNlem] = useState(false);
  const [newNlem, setNewNlem] = useState({
    medicineName: '',
    therapeuticCategory: '',
    sectionCode: '',
    dosageForm: 'Tablet',
    strengthsCsv: '',
  });

  async function runForm1Check(e?: React.FormEvent, customText?: string) {
    if (e) e.preventDefault();
    const targetText = customText ?? compositionText;
    setChecking(true);
    setCheckError(null);
    setAiBrief(null);
    setBriefError(null);
    try {
      const res = await apiFetch<{ result: Form1CheckResult }>('/api/form1-check', {
        method: 'POST',
        body: JSON.stringify({
          productName: productName || 'Proposed New Product',
          dosageForm,
          compositionText: targetText,
        }),
      });
      setResult(res.result);

      // Pre-tick any strengths that match the Company's existing portfolio
      const initialManual: Record<string, boolean> = {};
      for (const m of res.result.matches) {
        if (m.isNlem2022 && m.nlemEntry) {
          for (const df of m.nlemEntry.dosageForms) {
            const key = `${m.nlemEntry.medicineName}|${df.dosageForm}|${df.strength}`;
            const targetStrength = df.strength.toLowerCase().replace(/\s+/g, '');
            const targetMed = m.nlemEntry.medicineName.toLowerCase();
            const isMatched = m.companyMatches.some((c) => {
              if (c.dosageForm.toLowerCase() !== df.dosageForm.toLowerCase()) return false;
              if (c.strength.toLowerCase().replace(/\s+/g, '') === targetStrength) return true;
              return (c.components || []).some(
                (comp) =>
                  (comp.ingredient.toLowerCase().includes(targetMed) ||
                    (m.nlemEntry?.aliases || []).some((a) =>
                      comp.ingredient.toLowerCase().includes(a.toLowerCase())
                    )) &&
                  comp.strength.toLowerCase().replace(/\s+/g, '') === targetStrength
              );
            });
            if (isMatched) initialManual[key] = true;
          }
        }
      }
      setManualManufacturedKeys(initialManual);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Unable to evaluate formulation.');
    } finally {
      setChecking(false);
    }
  }

  async function generateAiBrief() {
    if (!result || loadingBrief) return;
    setLoadingBrief(true);
    setBriefError(null);
    try {
      const res = await apiFetch<{ brief: AiForm1Brief }>('/api/ai/form1-brief', {
        method: 'POST',
        body: JSON.stringify({ result }),
      });
      setAiBrief(res.brief);
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Unable to generate AI regulatory brief.');
    } finally {
      setLoadingBrief(false);
    }
  }

  function loadExample(name: string, form: string, comp: string) {
    setProductName(name);
    setDosageForm(form);
    setCompositionText(comp);
    void runForm1Check(undefined, comp);
  }

  const anyManualTicked = Object.values(manualManufacturedKeys).some(Boolean);
  const finalForm1Required =
    Boolean(result?.hasScheduledIngredient) &&
    (Boolean(result?.isExistingManufacturerInPortfolio) || anyManualTicked);

  const filteredNlem = useMemo(() => {
    const q = nlemSearch.trim().toLowerCase();
    if (!q) return nlemList;
    return nlemList.filter(
      (entry) =>
        entry.medicineName.toLowerCase().includes(q) ||
        entry.therapeuticCategory.toLowerCase().includes(q) ||
        entry.sectionCode.toLowerCase().includes(q) ||
        entry.dosageForms.some(
          (df) =>
            df.dosageForm.toLowerCase().includes(q) || df.strength.toLowerCase().includes(q)
        )
    );
  }, [nlemList, nlemSearch]);

  async function handleAddNlem(e: React.FormEvent) {
    e.preventDefault();
    const dosageForms = newNlem.strengthsCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((strength) => ({
        dosageForm: newNlem.dosageForm.trim() || 'Tablet',
        strength,
      }));
    await apiFetch('/api/nlem2022', {
      method: 'POST',
      body: JSON.stringify({
        medicineName: newNlem.medicineName,
        therapeuticCategory: newNlem.therapeuticCategory,
        sectionCode: newNlem.sectionCode,
        dosageForms,
      }),
    });
    setShowAddNlem(false);
    setNewNlem({
      medicineName: '',
      therapeuticCategory: '',
      sectionCode: '',
      dosageForm: 'Tablet',
      strengthsCsv: '',
    });
    await onRefresh();
  }

  async function handleDeleteNlem(id: string) {
    await apiFetch(`/api/nlem2022/${id}`, { method: 'DELETE' });
    await onRefresh();
  }

  return (
    <div className="space-y-6">
      {/* Sub-navigation inside New Product */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="inline-flex items-center gap-1 p-1 bg-indigo-50/90 border border-indigo-100 rounded-lg self-start">
          <button
            type="button"
            onClick={() => setSubTab('checker')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'checker'
                ? 'bg-white text-indigo-950 shadow-sm'
                : 'text-slate-600 hover:text-indigo-900'
            }`}
          >
            Form I &amp; Existing Manufacturer Check
          </button>
          <button
            type="button"
            onClick={() => setSubTab('nlem_list')}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'nlem_list'
                ? 'bg-white text-indigo-950 shadow-sm'
                : 'text-slate-600 hover:text-indigo-900'
            }`}
          >
            NLEM 2022 Master List ({nlemList.length})
          </button>
        </div>

        <span className="text-xs text-slate-500">
          Company Portfolio Linked: {company.existingFormulations.length} active SKU(s)
        </span>
      </div>

      {subTab === 'checker' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Formulation Input */}
          <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="font-display text-lg font-semibold text-slate-900">
              New Product Composition Screening
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Enter the proposed composition to check NLEM 2022 scheduled status and Existing Manufacturer applicability for Form I.
            </p>

            {checkError && (
              <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {checkError}
              </div>
            )}

            <form onSubmit={(e) => runForm1Check(e)} className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Proposed Product Name
                </label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="e.g. Atorva-Rani Combo Tablet"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Dosage Format
                </label>
                <select
                  value={dosageForm}
                  onChange={(e) => setDosageForm(e.target.value)}
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Tablet">Tablet</option>
                  <option value="Capsule">Capsule</option>
                  <option value="SR / ER Tablet">SR / ER Tablet</option>
                  <option value="Oral Liquid / Syrup">Oral Liquid / Syrup</option>
                  <option value="Injection">Injection</option>
                  <option value="Inhaler">Inhaler</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Active Composition &amp; Strengths
                </label>
                <textarea
                  rows={4}
                  required
                  value={compositionText}
                  onChange={(e) => setCompositionText(e.target.value)}
                  placeholder="e.g. each tablet contains Atorvastatin 10mg, ranitidine 20mg"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <button
                type="submit"
                disabled={checking}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
              >
                <ClipboardCheck className="w-4 h-4" />
                {checking ? 'Analyzing NLEM 2022…' : 'Check Form I Applicability'}
              </button>
            </form>

            <div className="mt-5 pt-4 border-t border-slate-200">
              <p className="text-xs font-medium text-slate-500 mb-2">Quick Test Scenarios</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    loadExample(
                      'Atorvastatin + Ranitidine FDC',
                      'Tablet',
                      'each tablet contains Atorvastatin 10mg, ranitidine 20mg'
                    )
                  }
                  className="px-3 py-1.5 text-xs font-medium text-indigo-900 bg-[#EEF2FF] hover:bg-indigo-100 border border-indigo-100 rounded-lg cursor-pointer"
                >
                  Atorvastatin 10mg + Ranitidine 20mg
                </button>
                <button
                  type="button"
                  onClick={() =>
                    loadExample(
                      'Sitagliptin + Metformin FDC',
                      'Tablet',
                      'Sitagliptin 50mg + Metformin 500mg'
                    )
                  }
                  className="px-3 py-1.5 text-xs font-medium text-violet-900 bg-[#F5F3FF] hover:bg-violet-100 border border-violet-100 rounded-lg cursor-pointer"
                >
                  Sitagliptin 50mg + Metformin 500mg
                </button>
              </div>
            </div>
          </section>

          {/* Right: Applicability Verdict & Existing Manufacturer Table */}
          <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
            {!result ? (
              <div className="py-12 text-center">
                <ClipboardCheck className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Ready to Evaluate Form I Applicability
                </h3>
                <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                  Enter your proposed composition on the left and click &ldquo;Check Form I Applicability&rdquo; to screen against NLEM 2022 and Existing Manufacturer rules.
                </p>
                <button
                  type="button"
                  onClick={() => runForm1Check()}
                  className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 cursor-pointer"
                >
                  Run Sample Check Now
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Screening Verdict Box */}
                <div
                  className={`p-4 rounded-xl border ${
                    finalForm1Required
                      ? 'bg-red-50 border-red-200'
                      : result.hasScheduledIngredient
                        ? 'bg-amber-50 border-amber-200'
                        : 'bg-emerald-50 border-emerald-200'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {finalForm1Required ? (
                      <ShieldAlert className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                    ) : result.hasScheduledIngredient ? (
                      <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                        {finalForm1Required
                          ? 'Form I Required — Existing Manufacturer Confirmed'
                          : result.hasScheduledIngredient
                            ? 'NLEM 2022 Match — Verify Existing Manufacturer Status'
                            : 'Non-Scheduled Composition — Form I Not Triggered'}
                      </div>
                      <h3 className="font-display text-base font-bold text-slate-900 mt-1">
                        {result.summaryHeadline}
                      </h3>
                      <p className="text-sm text-slate-700 mt-1.5 leading-relaxed">
                        {result.regulatoryGuidance}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={generateAiBrief}
                          disabled={loadingBrief}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-violet-950 bg-white hover:bg-[#F5F3FF] border border-violet-200 rounded-lg disabled:opacity-60 cursor-pointer"
                        >
                          {loadingBrief ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5 text-indigo-700" />
                          )}
                          {loadingBrief ? 'Generating AI Brief…' : 'Generate AI Regulatory Brief'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {briefError && (
                  <div className="p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
                    {briefError}
                  </div>
                )}

                {aiBrief && (
                  <div className="p-4 rounded-xl border border-indigo-200 bg-[#EEF2FF]/60 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-950 uppercase tracking-wider">
                        <Sparkles className="w-3.5 h-3.5 text-indigo-700" />
                        AI DPCO Compliance Brief
                      </div>
                      <span className="text-xs font-semibold text-indigo-900">
                        Risk Level: {aiBrief.riskLevel}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-900">{aiBrief.verdictSummary}</p>
                    <p className="text-xs text-slate-700 leading-relaxed">{aiBrief.legalBasis}</p>
                    {aiBrief.actionChecklist.length > 0 && (
                      <ul className="space-y-1 text-xs text-slate-800 list-disc pl-4 pt-1">
                        {aiBrief.actionChecklist.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ul>
                    )}
                    <div className="pt-1.5 text-xs text-emerald-900 font-medium">
                      Form 1A Benchmark Check: {aiBrief.form1aBenchmarkNote}
                    </div>
                  </div>
                )}

                {result.existingManufacturerConditions &&
                  result.existingManufacturerConditions.length > 0 && (
                    <div className="p-4 rounded-xl border border-violet-100 bg-[#F5F3FF]/70">
                      <h4 className="text-xs font-semibold text-violet-950 uppercase tracking-wider mb-2">
                        Conditions for Existing Manufacturers (DPCO 2013)
                      </h4>
                      <ul className="space-y-1.5 text-xs text-slate-700 list-disc pl-4">
                        {result.existingManufacturerConditions.map((cond, idx) => (
                          <li key={idx} className="leading-relaxed">
                            {cond}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {/* Ingredient Breakdown */}
                <div>
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2.5">
                    Ingredient-by-Ingredient NLEM 2022 Breakdown
                  </h4>
                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                    {result.matches.map((m, idx) => (
                      <div key={idx} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">
                            {m.matchedMedicine || m.extractedToken}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            Input: &ldquo;{m.extractedToken}&rdquo;
                            {m.isNlem2022 && m.nlemEntry
                              ? ` · NLEM 2022 Sec ${m.nlemEntry.sectionCode} (${m.nlemEntry.therapeuticCategory})`
                              : ''}
                          </div>
                          {m.omissionNote && (
                            <div className="text-xs text-slate-600 mt-1">{m.omissionNote}</div>
                          )}
                        </div>
                        <div className="text-xs font-semibold shrink-0">
                          {m.isNlem2022 ? (
                            <span className="text-amber-800">NLEM 2022 Scheduled</span>
                          ) : m.isOmittedFromNlem2022 ? (
                            <span className="text-slate-600">Omitted in NLEM 2022</span>
                          ) : (
                            <span className="text-emerald-700">Non-NLEM Ingredient</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Existing Manufacturer Applicability Table */}
                {result.matches.some((m) => m.isNlem2022 && m.nlemEntry) && (
                  <div>
                    <div className="mb-3">
                      <h4 className="font-display text-sm font-semibold text-slate-900">
                        Applicability of Existing Manufacturer — Scheduled NLEM 2022 List
                      </h4>
                      <p className="text-xs text-slate-600 mt-1">
                        Note: If your organisation currently manufactures or markets <span className="font-semibold text-slate-900">any of the below products</span>, you qualify as an Existing Manufacturer under DPCO 2013 — hence <span className="font-semibold text-red-700">Form I needs to be applied</span>.
                      </p>
                    </div>

                    <div className="overflow-x-auto border border-rose-100 rounded-lg">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-[#FFF1F2] border-b border-rose-100 text-xs font-semibold text-rose-950">
                            <th className="py-2.5 px-4">Medicines</th>
                            <th className="py-2.5 px-3">Dosage form and strength</th>
                            <th className="py-2.5 px-4 text-right">Manufactured by Company?</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-sm">
                          {result.matches
                            .filter((m) => m.isNlem2022 && m.nlemEntry)
                            .flatMap((m) =>
                              m.nlemEntry!.dosageForms.map((df) => {
                                const key = `${m.nlemEntry!.medicineName}|${df.dosageForm}|${df.strength}`;
                                const autoMatched = m.companyMatches.some(
                                  (c) =>
                                    c.dosageForm.toLowerCase() === df.dosageForm.toLowerCase() &&
                                    c.strength.toLowerCase().replace(/\s+/g, '') ===
                                      df.strength.toLowerCase().replace(/\s+/g, '')
                                );
                                const checked = Boolean(manualManufacturedKeys[key]);
                                return (
                                  <tr
                                    key={key}
                                    className={checked ? 'bg-rose-50/70' : 'hover:bg-slate-50'}
                                  >
                                    <td className="py-2.5 px-4 font-medium text-slate-900">
                                      {m.nlemEntry!.medicineName}
                                    </td>
                                    <td className="py-2.5 px-3 font-mono text-xs text-slate-800">
                                      {df.dosageForm} {df.strength}
                                      {autoMatched && (
                                        <span className="ml-2 text-red-700 font-sans font-semibold">
                                          (Matched in Company Portfolio)
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2.5 px-4 text-right">
                                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(e) =>
                                            setManualManufacturedKeys((prev) => ({
                                              ...prev,
                                              [key]: e.target.checked,
                                            }))
                                          }
                                          className="rounded border-slate-300 text-blue-900 focus:ring-blue-700"
                                        />
                                        {checked ? 'Yes (Existing Mfg)' : 'No'}
                                      </label>
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      ) : (
        /* NLEM 2022 Master List */
        <section className="bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">
                NLEM 2022 Scheduled Formulations Master Directory
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Reference schedule of medicines, sections, and approved dosage forms &amp; strengths under NLEM 2022.
              </p>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setShowAddNlem((v) => !v)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add NLEM Entry
              </button>
            )}
          </div>

          {showAddNlem && isAdmin && (
            <form onSubmit={handleAddNlem} className="mt-4 p-4 rounded-lg bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-600 mb-1">Medicine</label>
                <input
                  type="text"
                  required
                  value={newNlem.medicineName}
                  onChange={(e) => setNewNlem({ ...newNlem, medicineName: e.target.value })}
                  placeholder="e.g. Dapagliflozin"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Section</label>
                <input
                  type="text"
                  value={newNlem.sectionCode}
                  onChange={(e) => setNewNlem({ ...newNlem, sectionCode: e.target.value })}
                  placeholder="18.5.1"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Dosage Form</label>
                <input
                  type="text"
                  value={newNlem.dosageForm}
                  onChange={(e) => setNewNlem({ ...newNlem, dosageForm: e.target.value })}
                  placeholder="Tablet"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Strengths (comma-separated)
                </label>
                <input
                  type="text"
                  required
                  value={newNlem.strengthsCsv}
                  onChange={(e) => setNewNlem({ ...newNlem, strengthsCsv: e.target.value })}
                  placeholder="5mg, 10mg"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white font-mono"
                />
              </div>
              <div className="sm:col-span-2 flex justify-end gap-2">
                <button
                  type="submit"
                  className="w-full px-3 py-2 text-xs font-semibold text-white bg-indigo-700 hover:bg-indigo-800 rounded-lg cursor-pointer"
                >
                  Save Entry
                </button>
              </div>
            </form>
          )}

          <div className="mt-5 relative max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={nlemSearch}
              onChange={(e) => setNlemSearch(e.target.value)}
              placeholder="Filter NLEM 2022 by medicine, category, strength..."
              className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600"
            />
          </div>

          <div className="mt-4 overflow-x-auto border border-violet-100 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F3FF] border-b border-violet-100 text-xs font-semibold text-violet-950">
                  <th className="py-3 px-4">Medicine</th>
                  <th className="py-3 px-3">Section &amp; Category</th>
                  <th className="py-3 px-4">Scheduled Dosage Forms &amp; Strengths</th>
                  {isAdmin && <th className="py-3 px-3 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredNlem.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 font-semibold text-slate-900 align-top">
                      {entry.medicineName}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600 align-top">
                      <div className="font-mono font-medium text-slate-800">
                        Section {entry.sectionCode}
                      </div>
                      <div className="mt-0.5">{entry.therapeuticCategory}</div>
                    </td>
                    <td className="py-3 px-4 text-xs font-mono text-slate-700">
                      {entry.dosageForms.map((df) => `${df.dosageForm} ${df.strength}`).join(' · ')}
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-3 text-right align-top">
                        <button
                          type="button"
                          onClick={() => handleDeleteNlem(entry.id)}
                          title="Delete NLEM entry"
                          className="p-1.5 text-slate-400 hover:text-red-700 rounded cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
