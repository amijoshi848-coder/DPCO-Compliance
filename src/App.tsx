import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  FileSpreadsheet,
  LogOut,
  Menu,
  Scale,
  Search,
  Shield,
  Sparkles,
  X,
} from 'lucide-react';
import AdminAccessTab from './components/AdminAccessTab';
import AiComplianceTab from './components/AiComplianceTab';
import CompanyDetailsTab from './components/CompanyDetailsTab';
import ComplianceCalendarTab from './components/ComplianceCalendarTab';
import LoginPage from './components/LoginPage';
import NewProductTab from './components/NewProductTab';
import RetailPricesTab, { type EnrichedRetailPrice } from './components/RetailPricesTab';
import ScheduleFormulationsTab from './components/ScheduleFormulationsTab';
import { apiFetch, getStoredToken, setStoredToken } from './lib/api';
import type {
  AuthUser,
  CeilingPriceEntry,
  CeilingPriceHistoryEntry,
  CompanyProfile,
  GlobalSearchResponse,
  GlobalSearchResultItem,
  Nlem2022Entry,
  NppaDocumentLog,
  SearchResultCategory,
  SoTrackingRecord,
  SyncLogEntry,
} from './types/compliance';

type WorkspaceTab =
  | 'schedule_formulations'
  | 'retail_prices'
  | 'company_details'
  | 'new_product'
  | 'compliance_calendar'
  | 'ai_search'
  | 'admin_access';

interface OverviewResponse {
  counts: {
    ceilingPrices: number;
    activeRetailPrices: number;
    totalRetailPrices: number;
    nlemFormulations: number;
    circulars: number;
    authorityMinutes: number;
    expertMinutes: number;
    companySkus: number;
  };
  scheduler: {
    scheduleTimeIst: string;
    currentIstDate: string;
    lastDailyRunDateIst: string | null;
    latestSync: SyncLogEntry | null;
  };
  syncLogs: SyncLogEntry[];
}

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('schedule_formulations');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Workspace data
  const [loadingData, setLoadingData] = useState(false);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [ceilingPrices, setCeilingPrices] = useState<CeilingPriceEntry[]>([]);
  const [ceilingHistory, setCeilingHistory] = useState<CeilingPriceHistoryEntry[]>([]);
  const [retailPrices, setRetailPrices] = useState<EnrichedRetailPrice[]>([]);
  const [nppaLogs, setNppaLogs] = useState<NppaDocumentLog[]>([]);
  const [nlemList, setNlemList] = useState<Nlem2022Entry[]>([]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [soTrackingRecords, setSoTrackingRecords] = useState<SoTrackingRecord[]>([]);

  // Global Header Search & Deep-Navigation Hints
  const [globalQuery, setGlobalQuery] = useState('');
  const [globalHits, setGlobalHits] = useState<GlobalSearchResultItem[]>([]);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [scheduleSearchHint, setScheduleSearchHint] = useState<string | undefined>(undefined);
  const [scheduleSubViewHint, setScheduleSubViewHint] = useState<'master' | 'history' | undefined>(
    undefined
  );
  const [retailSearchHint, setRetailSearchHint] = useState<string | undefined>(undefined);
  const [nlemSearchHint, setNlemSearchHint] = useState<string | undefined>(undefined);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  const loadWorkspaceData = useCallback(async () => {
    setLoadingData(true);
    try {
      const [ovRes, cpRes, rpRes, logRes, nlemRes, compRes, soRes] = await Promise.all([
        apiFetch<OverviewResponse>('/api/dashboard/overview'),
        apiFetch<{ items: CeilingPriceEntry[]; history: CeilingPriceHistoryEntry[] }>(
          '/api/ceiling-prices'
        ),
        apiFetch<{ items: EnrichedRetailPrice[] }>('/api/retail-prices'),
        apiFetch<{ items: NppaDocumentLog[]; syncLogs: SyncLogEntry[] }>('/api/nppa-logs'),
        apiFetch<{ items: Nlem2022Entry[] }>('/api/nlem2022'),
        apiFetch<{ company: CompanyProfile }>('/api/company'),
        apiFetch<{ items: SoTrackingRecord[] }>('/api/so-tracking'),
      ]);
      setOverview(ovRes);
      setCeilingPrices(cpRes.items);
      setCeilingHistory(cpRes.history || []);
      setRetailPrices(rpRes.items);
      setNppaLogs(logRes.items);
      setNlemList(nlemRes.items);
      setCompany(compRes.company);
      setSoTrackingRecords(soRes.items || []);
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    async function checkSession() {
      const token = getStoredToken();
      if (!token) {
        setAuthChecking(false);
        return;
      }
      try {
        const res = await apiFetch<{ user: AuthUser }>('/api/auth/me');
        setUser(res.user);
        await loadWorkspaceData();
      } catch {
        setStoredToken(null);
        setUser(null);
      } finally {
        setAuthChecking(false);
      }
    }
    void checkSession();
  }, [loadWorkspaceData]);

  async function handleLoginSuccess(loggedUser: AuthUser) {
    setUser(loggedUser);
    setActiveTab('schedule_formulations');
    await loadWorkspaceData();
  }

  function handleLogout() {
    setStoredToken(null);
    setUser(null);
    setOverview(null);
  }

  async function handleTriggerSync() {
    await apiFetch('/api/nppa-logs/sync', { method: 'POST' });
    await loadWorkspaceData();
  }

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setGlobalSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    const q = globalQuery.trim();
    if (!q || !user) {
      setGlobalHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<GlobalSearchResponse>(
          `/api/search?q=${encodeURIComponent(q)}`
        );
        if (!cancelled) setGlobalHits(res.results.slice(0, 8));
      } catch {
        if (!cancelled) setGlobalHits([]);
      }
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [globalQuery, user]);

  function handleNavigateToSearchResult(
    tab: 'schedule_formulations' | 'retail_prices' | 'new_product',
    searchKeyword: string,
    category?: SearchResultCategory
  ) {
    setGlobalSearchOpen(false);
    if (tab === 'schedule_formulations') {
      setScheduleSearchHint(searchKeyword);
      setScheduleSubViewHint(category === 'history' ? 'history' : 'master');
    } else if (tab === 'retail_prices') {
      setRetailSearchHint(searchKeyword);
    } else if (tab === 'new_product') {
      setNlemSearchHint(searchKeyword);
    }
    setActiveTab(tab);
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Verifying DPCO Compliance session…
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  const navItems: Array<{
    id: WorkspaceTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    adminOnly?: boolean;
  }> = [
    { id: 'schedule_formulations', label: 'Schedule Formulations', icon: Scale },
    { id: 'retail_prices', label: 'Retail Prices', icon: FileSpreadsheet },
    { id: 'company_details', label: 'Company details', icon: Building2 },
    { id: 'new_product', label: 'New Product', icon: ClipboardCheck },
    { id: 'compliance_calendar', label: 'Compliance Calendar', icon: CalendarDays },
    { id: 'ai_search', label: 'AI & Smart Search', icon: Sparkles },
    {
      id: 'admin_access',
      label: 'Allowed Login IDs',
      icon: Shield,
      adminOnly: true,
    },
  ];

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || user.role === 'admin');
  const activeNavMeta = visibleNavItems.find((i) => i.id === activeTab) || visibleNavItems[0];

  return (
    <div className="min-h-screen bg-[#F7F8FC] text-slate-900 flex">
      {/* Desktop Sidebar (260px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-[260px] lg:shrink-0 bg-white border-r border-indigo-100">
        <div className="px-6 py-5 border-b border-indigo-100 bg-[#FBFBFF]">
          <div className="font-display text-lg font-bold tracking-tight text-indigo-950 whitespace-nowrap">
            DPCO Compliance
          </div>
          <div className="text-xs text-slate-500 mt-1">
            NPPA &amp; NLEM 2022 Portal
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors text-left cursor-pointer ${
                  isActive
                    ? 'bg-[#EEF2FF] text-indigo-950 font-semibold border border-indigo-200/80'
                    : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-indigo-700' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-indigo-100 bg-[#FBFBFF] text-xs text-slate-600 space-y-1">
          <div className="font-semibold text-slate-900">{user.fullName}</div>
          <div className="font-mono text-slate-500">
            {user.loginId} · {user.role === 'admin' ? 'Admin' : 'User'}
          </div>
          {overview && (
            <div className="pt-2 text-indigo-700 font-medium">
              Auto-check: {overview.scheduler.scheduleTimeIst}
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 bg-white h-full border-r border-indigo-100 flex flex-col z-10">
            <div className="px-5 py-4 border-b border-indigo-100 flex items-center justify-between">
              <span className="font-display text-base font-bold text-indigo-950">
                DPCO Compliance
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg text-left cursor-pointer ${
                      isActive
                        ? 'bg-[#EEF2FF] text-indigo-950 font-semibold border border-indigo-200/80'
                        : 'text-slate-700 hover:bg-slate-50 border border-transparent'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary action on right */}
        <header className="bg-white border-b border-indigo-100 px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-lg border border-slate-200 cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span>DPCO Compliance</span>
              <span aria-hidden="true" className="mx-2">/</span>
              <span className="font-semibold text-indigo-950">{activeNavMeta.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Global Registry Quick Search */}
            <div ref={searchBoxRef} className="relative hidden sm:block w-64 md:w-80">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={globalQuery}
                onFocus={() => setGlobalSearchOpen(true)}
                onChange={(e) => {
                  setGlobalQuery(e.target.value);
                  setGlobalSearchOpen(true);
                }}
                placeholder="Quick search medicines, S.O., NLEM..."
                className="w-full pl-8 pr-8 py-1.5 text-xs border border-indigo-200 rounded-lg bg-[#FBFBFF] focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              />
              {globalQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setGlobalQuery('');
                    setGlobalHits([]);
                  }}
                  aria-label="Clear quick search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {globalSearchOpen && globalQuery.trim() && (
                <div className="absolute right-0 mt-1.5 w-96 bg-white border border-indigo-100 rounded-xl shadow-lg z-40 overflow-hidden">
                  <div className="px-3.5 py-2 bg-[#EEF2FF] border-b border-indigo-100 flex items-center justify-between text-[11px] font-semibold text-indigo-950">
                    <span>Registry Search Results</span>
                    <button
                      type="button"
                      onClick={() => {
                        setGlobalSearchOpen(false);
                        setActiveTab('ai_search');
                      }}
                      className="text-indigo-700 hover:underline cursor-pointer"
                    >
                      Open AI &amp; Smart Search →
                    </button>
                  </div>
                  {globalHits.length === 0 ? (
                    <div className="p-4 text-xs text-slate-500 text-center">
                      No direct matches found. Try AI &amp; Smart Search for NPPA web lookup.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                      {globalHits.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          onClick={() =>
                            handleNavigateToSearchResult(
                              hit.tabTarget,
                              hit.searchKeyword,
                              hit.category
                            )
                          }
                          className="w-full text-left px-3.5 py-2.5 hover:bg-[#FBFBFF] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-900 truncate">
                              {hit.title}
                            </span>
                            <span className="text-[10px] font-mono uppercase text-indigo-700 shrink-0">
                              {hit.category}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 truncate mt-0.5">
                            {hit.meta}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </header>

        {/* Compact Summary Metrics Strip */}
        {overview && (
          <div className="bg-white/80 border-b border-indigo-100 px-6 py-3.5">
            <div className="max-w-6xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="rounded-lg bg-[#EEF2FF] border border-indigo-100 px-3.5 py-2.5">
                <span className="text-indigo-900/80 font-medium">Scheduled Ceiling Prices</span>
                <div className="font-mono text-base font-semibold text-indigo-950 tabular-nums mt-0.5">
                  {overview.counts.ceilingPrices}
                </div>
              </div>
              <div className="rounded-lg bg-[#ECFDF5] border border-emerald-100 px-3.5 py-2.5">
                <span className="text-emerald-900/80 font-medium">Retail Prices (Post 16 Jul 2026)</span>
                <div className="font-mono text-base font-semibold text-emerald-950 tabular-nums mt-0.5">
                  {overview.counts.activeRetailPrices} active
                </div>
              </div>
              <div className="rounded-lg bg-[#F5F3FF] border border-violet-100 px-3.5 py-2.5">
                <span className="text-violet-900/80 font-medium">NLEM 2022 Medicines</span>
                <div className="font-mono text-base font-semibold text-violet-950 tabular-nums mt-0.5">
                  {overview.counts.nlemFormulations}
                </div>
              </div>
              <div className="rounded-lg bg-[#FFF7ED] border border-orange-100 px-3.5 py-2.5">
                <span className="text-orange-900/80 font-medium">NPPA Circulars &amp; Minutes</span>
                <div className="font-mono text-base font-semibold text-orange-950 tabular-nums mt-0.5">
                  {overview.counts.circulars +
                    overview.counts.authorityMinutes +
                    overview.counts.expertMinutes}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Active Page Viewport */}
        <main className="flex-1 p-6">
          <div className="max-w-6xl mx-auto">
            {loadingData && !overview ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
                Loading NPPA compliance registry…
              </div>
            ) : (
              <>
                {activeTab === 'schedule_formulations' && (
                  <ScheduleFormulationsTab
                    user={user}
                    ceilingPrices={ceilingPrices}
                    ceilingHistory={ceilingHistory}
                    nppaLogs={nppaLogs}
                    soTrackingRecords={soTrackingRecords}
                    schedulerInfo={
                      overview
                        ? {
                            scheduleTimeIst: overview.scheduler.scheduleTimeIst,
                            currentIstDate: overview.scheduler.currentIstDate,
                            lastDailyRunDateIst: overview.scheduler.lastDailyRunDateIst,
                          }
                        : null
                    }
                    latestSync={overview?.scheduler.latestSync || null}
                    initialSearchQuery={scheduleSearchHint}
                    initialSubView={scheduleSubViewHint}
                    onRefresh={loadWorkspaceData}
                  />
                )}
                {activeTab === 'retail_prices' && (
                  <RetailPricesTab
                    user={user}
                    retailPrices={retailPrices}
                    initialSearchQuery={retailSearchHint}
                    onRefresh={loadWorkspaceData}
                  />
                )}
                {activeTab === 'company_details' && company && (
                  <CompanyDetailsTab company={company} onRefresh={loadWorkspaceData} />
                )}
                {activeTab === 'new_product' && company && (
                  <NewProductTab
                    user={user}
                    nlemList={nlemList}
                    company={company}
                    initialNlemSearch={nlemSearchHint}
                    onRefresh={loadWorkspaceData}
                  />
                )}
                {activeTab === 'compliance_calendar' && (
                  <ComplianceCalendarTab
                    user={user}
                    onRefreshWorkspace={loadWorkspaceData}
                  />
                )}
                {activeTab === 'ai_search' && (
                  <AiComplianceTab onNavigateToResult={handleNavigateToSearchResult} />
                )}
                {activeTab === 'admin_access' && user.role === 'admin' && (
                  <AdminAccessTab
                    currentUser={user}
                    syncLogs={overview?.syncLogs || []}
                    onTriggerSync={handleTriggerSync}
                  />
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
