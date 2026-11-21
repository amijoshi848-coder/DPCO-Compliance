import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileDown, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { exportRetailPricesPdf } from '../lib/pdfExport';
import type { AuthUser, RetailPriceEntry } from '../types/compliance';

export interface EnrichedRetailPrice extends RetailPriceEntry {
  retentionExpiresOn: string;
  daysRemaining: number;
  isActiveRetention: boolean;
}

interface RetailPricesTabProps {
  user: AuthUser;
  retailPrices: EnrichedRetailPrice[];
  initialSearchQuery?: string;
  onRefresh: () => Promise<void>;
}

export default function RetailPricesTab({
  user,
  retailPrices,
  initialSearchQuery,
  onRefresh,
}: RetailPricesTabProps) {
  const isAdmin = user.role === 'admin';
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');

  useEffect(() => {
    if (initialSearchQuery !== undefined) {
      setSearchQuery(initialSearchQuery);
    }
  }, [initialSearchQuery]);
  const [retentionFilter, setRetentionFilter] = useState<'active' | 'all'>('active');
  const [gstRate, setGstRate] = useState<number>(12);
  const [packSize, setPackSize] = useState<number>(10);

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<EnrichedRetailPrice | null>(null);
  const [formState, setFormState] = useState({
    notificationNumber: 'S.O. ',
    notificationDate: new Date().toISOString().slice(0, 10),
    formulation: '',
    composition: '',
    strength: '',
    dosageFormat: 'Tablet',
    unitLabel: '1 Tablet',
    retailPrice: '',
    applicantCompany: '',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return retailPrices.filter((item) => {
      if (retentionFilter === 'active' && !item.isActiveRetention) return false;
      if (!q) return true;
      return (
        item.notificationNumber.toLowerCase().includes(q) ||
        item.formulation.toLowerCase().includes(q) ||
        item.composition.toLowerCase().includes(q) ||
        item.applicantCompany.toLowerCase().includes(q)
      );
    });
  }, [retailPrices, retentionFilter, searchQuery]);

  function openAdd() {
    setEditing(null);
    setFormState({
      notificationNumber: 'S.O. ',
      notificationDate: new Date().toISOString().slice(0, 10),
      formulation: '',
      composition: '',
      strength: '',
      dosageFormat: 'Tablet',
      unitLabel: '1 Tablet',
      retailPrice: '',
      applicantCompany: 'Form 1A Notified Benchmark',
    });
    setFormError(null);
    setShowModal(true);
  }

  function openEdit(item: EnrichedRetailPrice) {
    setEditing(item);
    setFormState({
      notificationNumber: item.notificationNumber,
      notificationDate: item.notificationDate,
      formulation: item.formulation,
      composition: item.composition,
      strength: item.strength,
      dosageFormat: item.dosageFormat,
      unitLabel: item.unitLabel,
      retailPrice: String(item.retailPrice),
      applicantCompany: item.applicantCompany,
    });
    setFormError(null);
    setShowModal(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        ...formState,
        retailPrice: Number(formState.retailPrice),
      };
      if (editing) {
        await apiFetch(`/api/retail-prices/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/retail-prices', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setShowModal(false);
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save retail price.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/retail-prices/${id}`, { method: 'DELETE' });
    await onRefresh();
  }

  async function handlePurgeExpired() {
    await apiFetch('/api/retail-prices/purge-expired', { method: 'POST' });
    await onRefresh();
  }

  function handleExportCsv() {
    const header = [
      'Notification Number',
      'Notification Date',
      'Formulation',
      'Unit',
      'Retail Price (INR)',
      `Pack MRP (${packSize}u @ ${gstRate}% GST)`,
      'Retention Expires On',
    ];
    const rows = filteredItems.map((item) => [
      `"${item.notificationNumber.replace(/"/g, '""')}"`,
      item.notificationDate,
      `"${item.formulation.replace(/"/g, '""')}"`,
      `"${item.unitLabel.replace(/"/g, '""')}"`,
      item.retailPrice.toFixed(2),
      packWithGst(item.retailPrice).toFixed(2),
      item.retentionExpiresOn,
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'form1a-retail-prices-post-16jul2026.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const unitWithGst = (rp: number) => rp + rp * (gstRate / 100);
  const packWithGst = (rp: number) => unitWithGst(rp) * Math.max(1, packSize);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Retail Prices — Form 1A Ready Reference (Post 16 July 2026)
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Notified retail prices issued after <span className="font-mono font-medium">16 July 2026</span> for Form 1A new product adoption. Each log remains active in the registry for <span className="font-semibold text-slate-800">1 year from notification date</span>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() =>
                exportRetailPricesPdf({
                  items: filteredItems,
                  gstRate,
                  packSize,
                  retentionFilter,
                  searchQuery,
                })
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-950 bg-[#ECFDF5] border border-emerald-200 rounded-lg hover:bg-emerald-100 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileDown className="w-3.5 h-3.5" />
              Export PDF
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            {isAdmin && (
              <>
                <button
                  type="button"
                  onClick={handlePurgeExpired}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Purge Expired (&gt;1 Yr)
                </button>
                <button
                  type="button"
                  onClick={openAdd}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Add Retail Price Circular
                </button>
              </>
            )}
          </div>
        </div>

        {/* Filters + Pack MRP Calculator */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 pt-5 items-end">
          <div className="md:col-span-5">
            <label htmlFor="rp-search" className="block text-xs font-medium text-slate-600 mb-1.5">
              Search Formulation or Notification Number
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="rp-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g. Sitagliptin, Telmisartan, S.O. 3812..."
                className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              1-Year Log Window
            </label>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setRetentionFilter('active')}
                className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  retentionFilter === 'active'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Active (1-Yr)
              </button>
              <button
                type="button"
                onClick={() => setRetentionFilter('all')}
                className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  retentionFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Logs
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <label htmlFor="rp-gst" className="block text-xs font-medium text-slate-600 mb-1.5">
              GST (%)
            </label>
            <select
              id="rp-gst"
              value={gstRate}
              onChange={(e) => setGstRate(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
            >
              <option value={0}>0%</option>
              <option value={5}>5%</option>
              <option value={12}>12%</option>
              <option value={18}>18%</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label htmlFor="rp-pack" className="block text-xs font-medium text-slate-600 mb-1.5">
              Pack Size
            </label>
            <input
              id="rp-pack"
              type="number"
              min={1}
              max={1000}
              value={packSize}
              onChange={(e) => setPackSize(Math.max(1, Number(e.target.value) || 1))}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono tabular-nums"
            />
          </div>
        </div>

        {/* Table */}
        <div className="mt-5 overflow-x-auto border border-emerald-100 rounded-lg">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#ECFDF5] border-b border-emerald-100 text-xs font-semibold text-emerald-950">
                <th className="py-3 px-4">Notification No. &amp; Date</th>
                <th className="py-3 px-3">Formulation (Form 1A Reference)</th>
                <th className="py-3 px-3 text-right">Retail Price (₹)</th>
                <th className="py-3 px-3 text-right">Pack MRP ({packSize}u · {gstRate}% GST)</th>
                <th className="py-3 px-4">1-Year Retention</th>
                {isAdmin && <th className="py-3 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} className="py-8 text-center text-slate-500">
                    No post-16 July 2026 retail price circulars found for the current filter.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                        {item.notificationNumber}
                      </div>
                      <div className="font-mono text-xs text-slate-500 tabular-nums">
                        {item.notificationDate}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-slate-900">{item.formulation}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {item.unitLabel} · {item.applicantCompany}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                      ₹{item.retailPrice.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-semibold tabular-nums text-blue-900">
                      ₹{packWithGst(item.retailPrice).toFixed(2)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="font-mono text-xs text-slate-800 tabular-nums">
                        Until {item.retentionExpiresOn}
                      </div>
                      <div
                        className={`text-xs font-medium mt-0.5 ${
                          item.isActiveRetention ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {item.isActiveRetention
                          ? `${item.daysRemaining} days left`
                          : 'Expired (>1 yr)'}
                      </div>
                    </td>
                    {isAdmin && (
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openEdit(item)}
                          title="Edit retail price"
                          className="p-1.5 text-slate-500 hover:text-blue-800 rounded cursor-pointer"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          title="Delete retail price"
                          className="p-1.5 text-slate-500 hover:text-red-700 rounded cursor-pointer ml-1"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="font-display text-lg font-semibold text-slate-900">
                {editing ? 'Edit Retail Price Circular' : 'Add Retail Price Circular (Post 16 Jul 2026)'}
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

            <form onSubmit={handleSave} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Notification Number
                  </label>
                  <input
                    type="text"
                    required
                    value={formState.notificationNumber}
                    onChange={(e) =>
                      setFormState({ ...formState, notificationNumber: e.target.value })
                    }
                    placeholder="S.O. 4920(E)"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Notification Date (&gt; 2026-07-16)
                  </label>
                  <input
                    type="date"
                    min="2026-07-17"
                    required
                    value={formState.notificationDate}
                    onChange={(e) =>
                      setFormState({ ...formState, notificationDate: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Formulation Name &amp; Strength
                </label>
                <input
                  type="text"
                  required
                  value={formState.formulation}
                  onChange={(e) => setFormState({ ...formState, formulation: e.target.value })}
                  placeholder="e.g. Atorvastatin 10mg + Aspirin 75mg Capsule"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Retail Price (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={formState.retailPrice}
                    onChange={(e) => setFormState({ ...formState, retailPrice: e.target.value })}
                    placeholder="8.40"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Dosage Format
                  </label>
                  <input
                    type="text"
                    required
                    value={formState.dosageFormat}
                    onChange={(e) => setFormState({ ...formState, dosageFormat: e.target.value })}
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
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Applicant / Reference Note
                </label>
                <input
                  type="text"
                  value={formState.applicantCompany}
                  onChange={(e) =>
                    setFormState({ ...formState, applicantCompany: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
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
                  {saving ? 'Saving…' : editing ? 'Update Circular' : 'Save Circular'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
