import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FileDown,
  FileSpreadsheet,
  FileUp,
  Layers,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  downloadPortfolioExcel,
  downloadPortfolioTemplateExcel,
  parseCompanyPortfolioExcel,
  type ParsedExcelPortfolioResult,
} from '../lib/portfolioExcel';
import type {
  CompanyProfile,
  ExistingCompanyFormulation,
  FdcComponent,
} from '../types/compliance';

interface CompanyDetailsTabProps {
  company: CompanyProfile;
  onRefresh: () => Promise<void>;
}

const PRODUCT_CATEGORIES = [
  'Scheduled (NLEM 2022)',
  'Non-Scheduled',
  'New Drug (Form I / 1A)',
  'Fixed Dose Combination (FDC)',
];

const EMPTY_PRODUCT_FORM = {
  medicineName: '',
  composition: '',
  strength: '',
  dosageForm: 'Tablet',
  category: 'Scheduled (NLEM 2022)',
  pack: '',
  mrp: '',
  brandName: '',
  marketingStatus: 'Active' as 'Active' | 'Discontinued',
};

const EMPTY_FDC_COMPONENTS: FdcComponent[] = [
  { ingredient: '', strength: '' },
  { ingredient: '', strength: '' },
];

export default function CompanyDetailsTab({
  company,
  onRefresh,
}: CompanyDetailsTabProps) {
  const [profile, setProfile] = useState<CompanyProfile>(company);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [skuSearch, setSkuSearch] = useState('');
  const [editingSkuId, setEditingSkuId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT_FORM);
  const [isFdcMode, setIsFdcMode] = useState(false);
  const [fdcComponents, setFdcComponents] = useState<FdcComponent[]>(EMPTY_FDC_COMPONENTS);

  // Excel import modal state
  const [showExcelModal, setShowExcelModal] = useState(false);
  const [excelFileName, setExcelFileName] = useState<string | null>(null);
  const [excelParsed, setExcelParsed] = useState<ParsedExcelPortfolioResult | null>(null);
  const [excelError, setExcelError] = useState<string | null>(null);
  const [excelImportMode, setExcelImportMode] = useState<'merge' | 'replace'>('merge');

  useEffect(() => {
    setProfile(company);
  }, [company]);

  async function saveProfile(updated: CompanyProfile, notice: string) {
    setSaving(true);
    setSavedToast(null);
    try {
      const res = await apiFetch<{ company: CompanyProfile }>('/api/company', {
        method: 'PUT',
        body: JSON.stringify(updated),
      });
      setProfile(res.company);
      setSavedToast(notice);
      await onRefresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDetails(e: React.FormEvent) {
    e.preventDefault();
    await saveProfile(profile, 'Company regulatory details updated.');
  }

  function openExcelModal() {
    setExcelFileName(null);
    setExcelParsed(null);
    setExcelError(null);
    setExcelImportMode('merge');
    setShowExcelModal(true);
  }

  async function handleExcelFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelError(null);
    setExcelParsed(null);
    setExcelFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseCompanyPortfolioExcel(buffer);
      setExcelParsed(parsed);
    } catch (err) {
      setExcelError(
        err instanceof Error ? err.message : 'Unable to parse uploaded Excel file.'
      );
    }
  }

  async function handleConfirmExcelImport() {
    if (!excelParsed || excelParsed.items.length === 0) return;

    let nextFormulations: ExistingCompanyFormulation[];
    if (excelImportMode === 'replace') {
      nextFormulations = excelParsed.items;
    } else {
      const merged = [...profile.existingFormulations];
      for (const incoming of excelParsed.items) {
        const idx = merged.findIndex(
          (ex) =>
            ex.medicineName.toLowerCase() === incoming.medicineName.toLowerCase() &&
            ex.strength.toLowerCase().replace(/\s+/g, '') ===
              incoming.strength.toLowerCase().replace(/\s+/g, '') &&
            ex.dosageForm.toLowerCase() === incoming.dosageForm.toLowerCase()
        );
        if (idx >= 0) {
          merged[idx] = { ...incoming, id: merged[idx].id };
        } else {
          merged.push(incoming);
        }
      }
      nextFormulations = merged;
    }

    await saveProfile(
      { ...profile, existingFormulations: nextFormulations },
      `Imported ${excelParsed.items.length} product(s) from ${excelFileName || 'Excel'} (${excelImportMode === 'replace' ? 'replaced portfolio' : 'merged with portfolio'}).`
    );
    setShowExcelModal(false);
    setExcelParsed(null);
    setExcelFileName(null);
  }

  function enableFdcMode(nextFdc: boolean) {
    setFormError(null);
    setIsFdcMode(nextFdc);
    if (nextFdc) {
      setProductForm((prev) => ({
        ...prev,
        category:
          prev.category === 'Scheduled (NLEM 2022)'
            ? 'Fixed Dose Combination (FDC)'
            : prev.category,
      }));
      setFdcComponents((prev) => {
        const hasAny = prev.some((c) => c.ingredient.trim() || c.strength.trim());
        if (hasAny) return prev.length >= 2 ? prev : [...prev, { ingredient: '', strength: '' }];
        return [
          {
            ingredient: productForm.composition.trim() || productForm.medicineName.trim(),
            strength: productForm.strength.trim(),
          },
          { ingredient: '', strength: '' },
        ];
      });
    }
  }

  function addFdcComponentRow() {
    setFdcComponents((prev) => [...prev, { ingredient: '', strength: '' }]);
  }

  function updateFdcComponentRow(index: number, field: keyof FdcComponent, value: string) {
    setFdcComponents((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  function removeFdcComponentRow(index: number) {
    setFdcComponents((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== index)));
  }

  function startEditSku(sku: ExistingCompanyFormulation) {
    setFormError(null);
    setEditingSkuId(sku.id);
    const shouldUseFdc =
      Boolean(sku.isFdc) ||
      (Array.isArray(sku.components) && sku.components.length > 1) ||
      sku.category === 'Fixed Dose Combination (FDC)';

    setProductForm({
      medicineName: sku.medicineName,
      composition: sku.composition || '',
      strength: sku.strength,
      dosageForm: sku.dosageForm,
      category: sku.category || 'Scheduled (NLEM 2022)',
      pack: sku.pack || '',
      mrp: sku.mrp != null ? String(sku.mrp) : '',
      brandName: sku.brandName || '',
      marketingStatus: sku.marketingStatus,
    });

    if (shouldUseFdc) {
      setIsFdcMode(true);
      if (Array.isArray(sku.components) && sku.components.length > 0) {
        setFdcComponents(
          sku.components.length >= 2
            ? sku.components
            : [...sku.components, { ingredient: '', strength: '' }]
        );
      } else {
        const splitComps = (sku.composition || sku.medicineName)
          .split('+')
          .map((s) => s.trim())
          .filter(Boolean);
        const splitStrengths = sku.strength.split('+').map((s) => s.trim());
        const mapped = splitComps.map((ing, i) => ({
          ingredient: ing,
          strength: splitStrengths[i] || '',
        }));
        setFdcComponents(
          mapped.length >= 2
            ? mapped
            : [...mapped, { ingredient: '', strength: '' }]
        );
      }
    } else {
      setIsFdcMode(false);
      setFdcComponents(EMPTY_FDC_COMPONENTS);
    }
  }

  function cancelEditSku() {
    setFormError(null);
    setEditingSkuId(null);
    setProductForm(EMPTY_PRODUCT_FORM);
    setIsFdcMode(false);
    setFdcComponents(EMPTY_FDC_COMPONENTS);
  }

  async function handleSaveProduct(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsedMrp = productForm.mrp.trim() ? Number(productForm.mrp) : undefined;
    let entry: ExistingCompanyFormulation;

    if (isFdcMode) {
      const validComponents = fdcComponents
        .map((c) => ({
          ingredient: c.ingredient.trim(),
          strength: c.strength.trim(),
        }))
        .filter((c) => c.ingredient.length > 0 && c.strength.length > 0);

      if (validComponents.length < 2) {
        setFormError(
          'Fixed Dose Combination requires at least 2 compositions with both Active Ingredient and Strength.'
        );
        return;
      }

      const derivedName =
        productForm.medicineName.trim() ||
        validComponents.map((c) => c.ingredient).join(' + ');
      const derivedComposition = validComponents
        .map((c) => `${c.ingredient} (${c.strength})`)
        .join(' + ');
      const derivedStrength = validComponents.map((c) => c.strength).join(' + ');

      entry = {
        id: editingSkuId || `ex-${Date.now()}`,
        medicineName: derivedName,
        composition: derivedComposition,
        isFdc: true,
        components: validComponents,
        dosageForm: productForm.dosageForm.trim() || 'Tablet',
        strength: derivedStrength,
        category: productForm.category.trim() || 'Fixed Dose Combination (FDC)',
        pack: productForm.pack.trim() || undefined,
        mrp: parsedMrp != null && Number.isFinite(parsedMrp) ? parsedMrp : undefined,
        brandName: productForm.brandName.trim() || undefined,
        marketingStatus: productForm.marketingStatus,
      };
    } else {
      if (!productForm.medicineName.trim() || !productForm.strength.trim()) {
        setFormError('Active Medicine Name and Strength are required.');
        return;
      }

      entry = {
        id: editingSkuId || `ex-${Date.now()}`,
        medicineName: productForm.medicineName.trim(),
        composition: productForm.composition.trim() || productForm.medicineName.trim(),
        isFdc: false,
        components: undefined,
        dosageForm: productForm.dosageForm.trim() || 'Tablet',
        strength: productForm.strength.trim(),
        category: productForm.category.trim() || 'Scheduled (NLEM 2022)',
        pack: productForm.pack.trim() || undefined,
        mrp: parsedMrp != null && Number.isFinite(parsedMrp) ? parsedMrp : undefined,
        brandName: productForm.brandName.trim() || undefined,
        marketingStatus: productForm.marketingStatus,
      };
    }

    const nextFormulations = editingSkuId
      ? profile.existingFormulations.map((item) => (item.id === editingSkuId ? entry : item))
      : [...profile.existingFormulations, entry];

    const notice = editingSkuId
      ? `Updated ${entry.medicineName} (${entry.strength} ${entry.dosageForm}).`
      : `Added ${entry.medicineName} ${entry.strength} ${entry.dosageForm} to company products.`;

    setEditingSkuId(null);
    setProductForm(EMPTY_PRODUCT_FORM);
    setIsFdcMode(false);
    setFdcComponents(EMPTY_FDC_COMPONENTS);
    await saveProfile({ ...profile, existingFormulations: nextFormulations }, notice);
  }

  async function handleRemoveSku(id: string) {
    if (editingSkuId === id) cancelEditSku();
    const nextProfile: CompanyProfile = {
      ...profile,
      existingFormulations: profile.existingFormulations.filter((item) => item.id !== id),
    };
    await saveProfile(nextProfile, 'Removed product from company portfolio.');
  }

  const filteredSkus = useMemo(() => {
    const q = skuSearch.trim().toLowerCase();
    if (!q) return profile.existingFormulations;
    return profile.existingFormulations.filter((sku) =>
      [
        sku.medicineName,
        sku.composition || '',
        ...(sku.components || []).map((c) => `${c.ingredient} ${c.strength}`),
        sku.strength,
        sku.dosageForm,
        sku.category || '',
        sku.pack || '',
        sku.brandName || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [profile.existingFormulations, skuSearch]);

  return (
    <div className="space-y-8">
      {/* Organization Details */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Company Details &amp; Regulatory Registrations
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Corporate details used on NPPA Form I / Form V submissions and Existing Manufacturer checks.
            </p>
          </div>
          {savedToast && (
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <Check className="w-4 h-4" />
              {savedToast}
            </div>
          )}
        </div>

        <form onSubmit={handleSaveDetails} className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Registered Company Name
            </label>
            <input
              type="text"
              required
              value={profile.companyName}
              onChange={(e) => setProfile({ ...profile, companyName: e.target.value })}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Manufacturing License No.
            </label>
            <input
              type="text"
              value={profile.manufacturingLicenseNo}
              onChange={(e) =>
                setProfile({ ...profile, manufacturingLicenseNo: e.target.value })
              }
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">CIN</label>
            <input
              type="text"
              value={profile.cin}
              onChange={(e) => setProfile({ ...profile, cin: e.target.value })}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">GSTIN</label>
            <input
              type="text"
              value={profile.gstin}
              onChange={(e) => setProfile({ ...profile, gstin: e.target.value })}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Authorized Regulatory Officer
            </label>
            <input
              type="text"
              value={profile.regulatoryOfficerName}
              onChange={(e) =>
                setProfile({ ...profile, regulatoryOfficerName: e.target.value })
              }
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Regulatory Affairs Email
            </label>
            <input
              type="email"
              value={profile.regulatoryOfficerEmail}
              onChange={(e) =>
                setProfile({ ...profile, regulatoryOfficerEmail: e.target.value })
              }
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Corporate &amp; Plant Address
            </label>
            <input
              type="text"
              value={profile.corporateAddress}
              onChange={(e) => setProfile({ ...profile, corporateAddress: e.target.value })}
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="md:col-span-2 flex justify-end pt-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving…' : 'Save Company Details'}
            </button>
          </div>
        </form>
      </section>

      {/* Company Product Details & Existing Manufactured Formulations */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Company Product Portfolio (Composition, Strength, Category, Pack &amp; MRP)
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Manage marketed SKUs and active compositions ({profile.existingFormulations.length} product(s)). Any NLEM 2022 ingredient registered here is automatically cross-checked during <span className="font-semibold text-slate-800">Form I Existing Manufacturer</span> screening.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => downloadPortfolioTemplateExcel()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Download Format (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => downloadPortfolioExcel(profile.companyName, filteredSkus)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-950 bg-[#ECFDF5] border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileDown className="w-3.5 h-3.5" />
              Download Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={openExcelModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 transition-colors whitespace-nowrap cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              Upload Excel
            </button>
          </div>
        </div>

        <form
          onSubmit={handleSaveProduct}
          className="mt-5 p-4 rounded-xl bg-[#FFF7ED]/50 border border-orange-100 space-y-4"
        >
          {/* Single Active vs Fixed Dose Combination Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-orange-100">
            <div className="inline-flex items-center gap-1 p-1 bg-white border border-orange-200 rounded-lg self-start">
              <button
                type="button"
                onClick={() => enableFdcMode(false)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  !isFdcMode
                    ? 'bg-indigo-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Single Active Formulation
              </button>
              <button
                type="button"
                onClick={() => enableFdcMode(true)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  isFdcMode
                    ? 'bg-indigo-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Fixed Dose Combination (Multiple Compositions)
              </button>
            </div>
            <span className="text-xs text-slate-600">
              {isFdcMode
                ? `Add 2 or more active ingredients & strengths (${fdcComponents.length} rows)`
                : 'Single active ingredient formulation'}
            </span>
          </div>

          {formError && (
            <div className="p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
              {formError}
            </div>
          )}

          {isFdcMode ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  FDC Product / Formulation Title (Optional — auto-built from compositions if blank)
                </label>
                <input
                  type="text"
                  value={productForm.medicineName}
                  onChange={(e) => setProductForm({ ...productForm, medicineName: e.target.value })}
                  placeholder="e.g. Telmisartan + Amlodipine (or leave blank to auto-generate)"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div className="p-3.5 rounded-lg bg-white border border-orange-200/80 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-amber-950">
                    Active Compositions ({fdcComponents.length})
                  </span>
                  <button
                    type="button"
                    onClick={addFdcComponentRow}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-800 bg-[#EEF2FF] border border-indigo-200 rounded-md hover:bg-indigo-100 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Composition
                  </button>
                </div>

                {fdcComponents.map((comp, idx) => (
                  <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                    <div className="sm:col-span-1 text-xs font-mono font-semibold text-slate-500">
                      #{idx + 1}
                    </div>
                    <div className="sm:col-span-7">
                      <input
                        type="text"
                        required
                        value={comp.ingredient}
                        onChange={(e) => updateFdcComponentRow(idx, 'ingredient', e.target.value)}
                        placeholder={`Active Composition ${idx + 1} (e.g. ${
                          idx === 0
                            ? 'Telmisartan IP'
                            : idx === 1
                              ? 'Amlodipine Besylate IP eq. to Amlodipine'
                              : 'Hydrochlorothiazide IP'
                        })`}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <input
                        type="text"
                        required
                        value={comp.strength}
                        onChange={(e) => updateFdcComponentRow(idx, 'strength', e.target.value)}
                        placeholder={idx === 0 ? '40mg' : idx === 1 ? '5mg' : '12.5mg'}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono"
                      />
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      <button
                        type="button"
                        disabled={fdcComponents.length <= 2}
                        onClick={() => removeFdcComponentRow(idx)}
                        title={
                          fdcComponents.length <= 2
                            ? 'Minimum 2 compositions required for FDC'
                            : 'Remove composition'
                        }
                        className="p-1.5 text-slate-400 hover:text-red-700 disabled:opacity-30 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Active Medicine Name *
                </label>
                <input
                  type="text"
                  required
                  value={productForm.medicineName}
                  onChange={(e) => setProductForm({ ...productForm, medicineName: e.target.value })}
                  placeholder="e.g. Atorvastatin"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div className="sm:col-span-6">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Composition *
                </label>
                <input
                  type="text"
                  required
                  value={productForm.composition}
                  onChange={(e) => setProductForm({ ...productForm, composition: e.target.value })}
                  placeholder="e.g. Atorvastatin Calcium IP eq. to Atorvastatin"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Strength *
                </label>
                <input
                  type="text"
                  required
                  value={productForm.strength}
                  onChange={(e) => setProductForm({ ...productForm, strength: e.target.value })}
                  placeholder="e.g. 10mg"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono"
                />
              </div>
            </div>
          )}

          {/* Shared Packaging, Category & Pricing Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Dosage Format
              </label>
              <input
                type="text"
                required
                value={productForm.dosageForm}
                onChange={(e) => setProductForm({ ...productForm, dosageForm: e.target.value })}
                placeholder="Tablet"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              />
            </div>

            <div className="sm:col-span-3">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Category
              </label>
              <select
                value={productForm.category}
                onChange={(e) => {
                  const nextCat = e.target.value;
                  setProductForm({ ...productForm, category: nextCat });
                  if (nextCat === 'Fixed Dose Combination (FDC)' && !isFdcMode) {
                    enableFdcMode(true);
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {PRODUCT_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Pack
              </label>
              <input
                type="text"
                required
                value={productForm.pack}
                onChange={(e) => setProductForm({ ...productForm, pack: e.target.value })}
                placeholder="e.g. 10 Tablets"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              />
            </div>

            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                MRP (₹)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={productForm.mrp}
                onChange={(e) => setProductForm({ ...productForm, mrp: e.target.value })}
                placeholder="65.20"
                className="w-full px-2.5 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Brand (Optional)
              </label>
              <input
                type="text"
                value={productForm.brandName}
                onChange={(e) => setProductForm({ ...productForm, brandName: e.target.value })}
                placeholder="TelmiAmlo-40"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              />
            </div>

            <div className="sm:col-span-2 flex items-center gap-2">
              {editingSkuId && (
                <button
                  type="button"
                  onClick={cancelEditSku}
                  className="inline-flex items-center justify-center gap-1 px-2.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={saving}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                {editingSkuId ? 'Update' : isFdcMode ? 'Add FDC' : 'Add Product'}
              </button>
            </div>
          </div>
        </form>

        <div className="mt-5 relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={skuSearch}
            onChange={(e) => setSkuSearch(e.target.value)}
            placeholder="Filter company products by medicine, composition, category, pack..."
            className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600"
          />
        </div>

        <div className="mt-4 overflow-x-auto border border-orange-100 rounded-lg">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#FFF7ED] border-b border-orange-100 text-xs font-semibold text-amber-950">
                <th className="py-3 px-4">Product &amp; Brand</th>
                <th className="py-3 px-3">Composition</th>
                <th className="py-3 px-3">Strength &amp; Format</th>
                <th className="py-3 px-3">Category</th>
                <th className="py-3 px-3">Pack</th>
                <th className="py-3 px-3 text-right">MRP (₹)</th>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filteredSkus.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-slate-500">
                    No company products match your filter.
                  </td>
                </tr>
              ) : (
                filteredSkus.map((sku) => (
                  <tr
                    key={sku.id}
                    className={
                      editingSkuId === sku.id ? 'bg-[#EEF2FF]/60' : 'hover:bg-slate-50'
                    }
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{sku.medicineName}</div>
                      <div className="flex flex-wrap items-center gap-2 mt-0.5 text-xs text-slate-500">
                        {sku.brandName && <span>{sku.brandName}</span>}
                        {(sku.isFdc || (sku.components && sku.components.length > 1)) && (
                          <span className="font-medium text-indigo-700">
                            FDC · {sku.components?.length || 2} compositions
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-700 max-w-xs">
                      {sku.components && sku.components.length > 0 ? (
                        <ul className="space-y-0.5">
                          {sku.components.map((comp, idx) => (
                            <li key={idx} className="flex items-baseline justify-between gap-2">
                              <span className="truncate">{comp.ingredient}</span>
                              <span className="font-mono text-slate-500 shrink-0 tabular-nums">
                                {comp.strength}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        sku.composition || sku.medicineName
                      )}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-800 whitespace-nowrap">
                      {sku.strength} · {sku.dosageForm}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-700 whitespace-nowrap">
                      {sku.category || 'Scheduled (NLEM 2022)'}
                    </td>
                    <td className="py-3 px-3 text-xs font-mono text-slate-700 whitespace-nowrap">
                      {sku.pack || '—'}
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-semibold text-indigo-950 tabular-nums whitespace-nowrap">
                      {sku.mrp != null ? `₹${sku.mrp.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-3 px-3 text-xs font-medium text-emerald-700 whitespace-nowrap">
                      {sku.marketingStatus}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEditSku(sku)}
                        title="Edit product details"
                        className="p-1.5 text-slate-500 hover:text-indigo-700 rounded cursor-pointer"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveSku(sku.id)}
                        title="Remove product"
                        className="p-1.5 text-slate-400 hover:text-red-700 rounded cursor-pointer ml-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Excel Upload & Format Modal */}
      {showExcelModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="font-display text-lg font-semibold text-slate-900">
                  Upload Company Product Portfolio from Excel
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Download the standard Excel format template, fill Single Active or multi-composition FDC rows (separated with &quot;+&quot;), and upload to preview and save.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowExcelModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {excelError && (
              <div className="mt-4 p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
                {excelError}
              </div>
            )}

            <div className="mt-4 p-4 rounded-xl bg-[#FBFBFF] border border-indigo-100 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs text-slate-700">
                  <span className="font-semibold text-indigo-950">Step 1:</span> Need the exact column layout &amp; FDC examples?
                </div>
                <button
                  type="button"
                  onClick={() => downloadPortfolioTemplateExcel()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 whitespace-nowrap self-start sm:self-auto cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Download Format (.xlsx)
                </button>
              </div>

              <div className="pt-3 border-t border-indigo-100 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                <div className="sm:col-span-7">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Step 2: Choose Excel / CSV File (.xlsx, .xls, .csv)
                  </label>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                    onChange={handleExcelFileChange}
                    className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-indigo-200 file:text-xs file:font-semibold file:bg-[#EEF2FF] file:text-indigo-950 hover:file:bg-indigo-100 cursor-pointer"
                  />
                </div>
                <div className="sm:col-span-5">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Import Mode
                  </label>
                  <select
                    value={excelImportMode}
                    onChange={(e) =>
                      setExcelImportMode(e.target.value as 'merge' | 'replace')
                    }
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="merge">Merge &amp; Update Matching SKUs (Recommended)</option>
                    <option value="replace">Replace Entire Company Portfolio</option>
                  </select>
                </div>
              </div>
            </div>

            {excelParsed && (
              <div className="mt-5 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="text-xs text-slate-700">
                    Parsed <span className="font-semibold text-slate-900">{excelParsed.items.length}</span> product(s) from sheet{' '}
                    <span className="font-mono text-indigo-800">{excelParsed.sheetName}</span>.
                  </div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleConfirmExcelImport}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-60 whitespace-nowrap cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {saving
                      ? 'Saving Portfolio…'
                      : `Save ${excelParsed.items.length} Imported Product(s)`}
                  </button>
                </div>

                {excelParsed.warnings.length > 0 && (
                  <div className="p-3 rounded-lg bg-[#FFF7ED] border border-orange-200 text-xs text-amber-950 space-y-1">
                    {excelParsed.warnings.map((w, i) => (
                      <div key={i}>{w}</div>
                    ))}
                  </div>
                )}

                <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-72 overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#EEF2FF] border-b border-indigo-100 text-indigo-950 font-semibold">
                        <th className="py-2 px-3">Product &amp; Type</th>
                        <th className="py-2 px-3">Composition(s)</th>
                        <th className="py-2 px-3">Strength &amp; Format</th>
                        <th className="py-2 px-3">Category &amp; Pack</th>
                        <th className="py-2 px-3 text-right">MRP (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {excelParsed.items.map((item) => (
                        <tr key={item.id}>
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-900">{item.medicineName}</div>
                            {item.isFdc && (
                              <div className="text-[11px] font-medium text-indigo-700">
                                FDC · {item.components?.length || 2} compositions
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-slate-700">
                            {item.components && item.components.length > 0 ? (
                              <div className="space-y-0.5">
                                {item.components.map((c, idx) => (
                                  <div key={idx}>
                                    {c.ingredient} <span className="font-mono text-slate-500">({c.strength})</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              item.composition
                            )}
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-700 whitespace-nowrap">
                            {item.strength} · {item.dosageForm}
                          </td>
                          <td className="py-2 px-3 text-slate-600">
                            <div>{item.category}</div>
                            {item.pack && <div className="font-mono text-[11px]">{item.pack}</div>}
                          </td>
                          <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                            {item.mrp != null ? `₹${item.mrp.toFixed(2)}` : '—'}
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
