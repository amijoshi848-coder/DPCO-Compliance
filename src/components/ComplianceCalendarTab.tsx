import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  AuthUser,
  CalendarEventCategory,
  ComplianceCalendarEvent,
  ComplianceCalendarResponse,
} from '../types/compliance';

interface ComplianceCalendarTabProps {
  user: AuthUser;
  onRefreshWorkspace: () => Promise<void>;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CATEGORY_META: Record<
  CalendarEventCategory,
  { label: string; chipClass: string; badgeClass: string }
> = {
  authority_meeting: {
    label: 'Authority Meeting',
    chipClass: 'bg-[#EEF2FF] text-indigo-950 border-indigo-200',
    badgeClass: 'bg-[#EEF2FF] text-indigo-900 border-indigo-200',
  },
  expert_committee: {
    label: 'Expert Committee',
    chipClass: 'bg-[#F5F3FF] text-violet-950 border-violet-200',
    badgeClass: 'bg-[#F5F3FF] text-violet-900 border-violet-200',
  },
  ceiling_deadline: {
    label: '45-Day MRP / Form V',
    chipClass: 'bg-[#FFF7ED] text-orange-950 border-orange-200',
    badgeClass: 'bg-[#FFF7ED] text-orange-900 border-orange-200',
  },
  form1a_expiry: {
    label: 'Form 1A Retention',
    chipClass: 'bg-[#ECFDF5] text-emerald-950 border-emerald-200',
    badgeClass: 'bg-[#ECFDF5] text-emerald-900 border-emerald-200',
  },
  custom_deadline: {
    label: 'Internal / Custom',
    chipClass: 'bg-[#FFF1F2] text-rose-950 border-rose-200',
    badgeClass: 'bg-[#FFF1F2] text-rose-900 border-rose-200',
  },
};

function confidenceLabel(conf: ComplianceCalendarEvent['confidence']): string {
  switch (conf) {
    case 'confirmed_log':
      return 'Confirmed from NPPA Log';
    case 'projected_cadence':
      return 'Projected Meeting Cadence';
    case 'derived_dpco_rule':
      return 'DPCO 2013 Rule';
    case 'manual':
      return 'Scheduled by Admin';
  }
}

function formatDeltaLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'In 1 day';
  if (days > 1) return `In ${days} days`;
  if (days === -1) return '1 day ago';
  return `${Math.abs(days)} days ago`;
}

export default function ComplianceCalendarTab({
  user,
  onRefreshWorkspace,
}: ComplianceCalendarTabProps) {
  const isAdmin = user.role === 'admin';
  const [calendarData, setCalendarData] = useState<ComplianceCalendarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | CalendarEventCategory>('all');

  const [currentMonth, setCurrentMonth] = useState<{ year: number; month: number }>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Admin custom event modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [newEvent, setNewEvent] = useState({
    title: '',
    date: new Date().toISOString().slice(0, 10),
    category: 'expert_committee' as CalendarEventCategory,
    referenceNumber: '',
    notes: '',
  });

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ComplianceCalendarResponse>('/api/calendar');
      setCalendarData(data);
      const [y, m] = data.todayIst.split('-').map(Number);
      if (y && m) {
        setCurrentMonth((prev) => (prev.year === y && prev.month === m - 1 ? prev : prev));
      }
      setSelectedDate((prev) => prev || data.todayIst);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCalendar();
  }, [loadCalendar]);

  async function handleSyncAndRefresh() {
    setSyncing(true);
    try {
      await apiFetch('/api/nppa-logs/sync', { method: 'POST' });
      await Promise.all([loadCalendar(), onRefreshWorkspace()]);
    } finally {
      setSyncing(false);
    }
  }

  async function handleAddCustomEvent(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ calendar: ComplianceCalendarResponse }>('/api/calendar', {
        method: 'POST',
        body: JSON.stringify(newEvent),
      });
      setCalendarData(res.calendar);
      setSelectedDate(newEvent.date);
      const [y, m] = newEvent.date.split('-').map(Number);
      if (y && m) setCurrentMonth({ year: y, month: m - 1 });
      setShowAddModal(false);
      setNewEvent({
        title: '',
        date: calendarData?.todayIst || new Date().toISOString().slice(0, 10),
        category: 'expert_committee',
        referenceNumber: '',
        notes: '',
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save calendar event.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCustom(id: string) {
    const res = await apiFetch<{ calendar: ComplianceCalendarResponse }>(`/api/calendar/${id}`, {
      method: 'DELETE',
    });
    setCalendarData(res.calendar);
  }

  const filteredEvents = useMemo(() => {
    if (!calendarData) return [];
    if (categoryFilter === 'all') return calendarData.events;
    return calendarData.events.filter((ev) => ev.category === categoryFilter);
  }, [calendarData, categoryFilter]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, ComplianceCalendarEvent[]>();
    for (const ev of filteredEvents) {
      const list = map.get(ev.date) || [];
      list.push(ev);
      map.set(ev.date, list);
    }
    return map;
  }, [filteredEvents]);

  const upcomingEvents = useMemo(() => {
    return filteredEvents.filter((ev) => ev.daysFromToday >= 0);
  }, [filteredEvents]);

  const selectedDayEvents = useMemo(() => {
    if (!selectedDate) return [];
    return eventsByDate.get(selectedDate) || [];
  }, [eventsByDate, selectedDate]);

  // Build 42-cell calendar matrix for currentMonth
  const calendarCells = useMemo(() => {
    const firstOfMonth = new Date(Date.UTC(currentMonth.year, currentMonth.month, 1));
    const startWeekday = firstOfMonth.getUTCDay();
    const daysInMonth = new Date(Date.UTC(currentMonth.year, currentMonth.month + 1, 0)).getUTCDate();

    const cells: Array<{ iso: string | null; dayNumber: number | null }> = [];
    for (let i = 0; i < startWeekday; i += 1) {
      cells.push({ iso: null, dayNumber: null });
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      const mm = String(currentMonth.month + 1).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      cells.push({ iso: `${currentMonth.year}-${mm}-${dd}`, dayNumber: d });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ iso: null, dayNumber: null });
    }
    return cells;
  }, [currentMonth]);

  const monthTitle = useMemo(() => {
    return new Date(Date.UTC(currentMonth.year, currentMonth.month, 1)).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }, [currentMonth]);

  function shiftMonth(delta: number) {
    setCurrentMonth((prev) => {
      const next = new Date(Date.UTC(prev.year, prev.month + delta, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });
  }

  function jumpToToday() {
    const base = calendarData?.todayIst || new Date().toISOString().slice(0, 10);
    const [y, m] = base.split('-').map(Number);
    if (y && m) {
      setCurrentMonth({ year: y, month: m - 1 });
    }
    setSelectedDate(base);
  }

  if (loading && !calendarData) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-500">
        Loading NPPA compliance deadlines &amp; meeting schedule…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-indigo-700" />
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Compliance Calendar — Regulatory Deadlines &amp; NPPA Meeting Schedule
              </h2>
            </div>
            <p className="text-sm text-slate-600 mt-1">
              Derived automatically from fetched NPPA Authority Minutes, Multidisciplinary Expert Committee logs, 45-day Form V / MRP deadlines, and 1-year Form 1A retention windows.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleSyncAndRefresh}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-60 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing NPPA…' : 'Sync NPPA Logs'}
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setShowAddModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Meeting / Deadline
              </button>
            )}
          </div>
        </div>

        {/* Pastel KPI Strip */}
        {calendarData && (
          <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="rounded-lg bg-[#EEF2FF] border border-indigo-100 px-3.5 py-3">
              <div className="text-indigo-900/80 font-medium">Upcoming Committee &amp; Authority</div>
              <div className="font-mono text-lg font-semibold text-indigo-950 tabular-nums mt-0.5">
                {calendarData.summary.upcomingMeetings}
              </div>
            </div>
            <div className="rounded-lg bg-[#FFF7ED] border border-orange-100 px-3.5 py-3">
              <div className="text-orange-900/80 font-medium">Deadlines Due Within 45 Days</div>
              <div className="font-mono text-lg font-semibold text-orange-950 tabular-nums mt-0.5">
                {calendarData.summary.dueWithin45Days}
              </div>
            </div>
            <div className="rounded-lg bg-[#ECFDF5] border border-emerald-100 px-3.5 py-3">
              <div className="text-emerald-900/80 font-medium">Active Form 1A Expiries Tracked</div>
              <div className="font-mono text-lg font-semibold text-emerald-950 tabular-nums mt-0.5">
                {calendarData.summary.form1aExpiries}
              </div>
            </div>
            <div className="rounded-lg bg-[#F5F3FF] border border-violet-100 px-3.5 py-3">
              <div className="text-violet-900/80 font-medium">Total Logged &amp; Derived Dates</div>
              <div className="font-mono text-lg font-semibold text-violet-950 tabular-nums mt-0.5">
                {calendarData.summary.totalEvents}
              </div>
            </div>
          </div>
        )}

        {/* Category Filter Strip */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
              categoryFilter === 'all'
                ? 'bg-indigo-700 text-white border-indigo-700'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            All Events
          </button>
          {(Object.keys(CATEGORY_META) as CalendarEventCategory[]).map((cat) => {
            const meta = CATEGORY_META[cat];
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  active
                    ? `${meta.badgeClass} font-semibold`
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {meta.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Main Split View: Monthly Calendar Grid + Upcoming Deadlines & Day Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Month Calendar Grid */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">{monthTitle}</h3>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                className="p-1.5 text-slate-600 hover:text-indigo-900 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={jumpToToday}
                className="px-3 py-1.5 text-xs font-semibold text-indigo-950 bg-[#EEF2FF] border border-indigo-200 rounded-lg hover:bg-indigo-100 cursor-pointer"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                className="p-1.5 text-slate-600 hover:text-indigo-900 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Weekday Headers */}
          <div className="grid grid-cols-7 gap-1 mt-4 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {WEEKDAYS.map((day) => (
              <div key={day} className="py-1.5">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Day Cells */}
          <div className="grid grid-cols-7 gap-1 mt-1">
            {calendarCells.map((cell, idx) => {
              if (!cell.iso || !cell.dayNumber) {
                return (
                  <div
                    key={`empty-${idx}`}
                    className="min-h-[84px] rounded-lg bg-slate-50/60 border border-transparent"
                  />
                );
              }

              const dayEvents = eventsByDate.get(cell.iso) || [];
              const isToday = cell.iso === calendarData?.todayIst;
              const isSelected = cell.iso === selectedDate;

              return (
                <button
                  key={cell.iso}
                  type="button"
                  onClick={() => setSelectedDate(cell.iso)}
                  className={`min-h-[84px] p-1.5 rounded-lg border text-left flex flex-col transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-indigo-500 bg-[#FBFBFF] ring-1 ring-indigo-500'
                      : isToday
                        ? 'border-indigo-200 bg-[#EEF2FF]/50'
                        : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50/70'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <span
                      className={`font-mono text-xs tabular-nums ${
                        isToday
                          ? 'font-bold text-indigo-800'
                          : isSelected
                            ? 'font-semibold text-indigo-950'
                            : 'font-medium text-slate-700'
                      }`}
                    >
                      {cell.dayNumber}
                    </span>
                    {dayEvents.length > 0 && (
                      <span className="text-[10px] font-mono text-slate-500">
                        {dayEvents.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1 w-full overflow-hidden">
                    {dayEvents.slice(0, 2).map((ev) => {
                      const meta = CATEGORY_META[ev.category];
                      return (
                        <div
                          key={ev.id}
                          className={`px-1.5 py-0.5 text-[10px] font-medium rounded border truncate ${meta.chipClass}`}
                          title={ev.title}
                        >
                          {ev.title}
                        </div>
                      );
                    })}
                    {dayEvents.length > 2 && (
                      <div className="text-[10px] font-medium text-indigo-700 pl-0.5">
                        +{dayEvents.length - 2} more
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Right: Selected Day Details + Upcoming Regulatory Timeline */}
        <div className="lg:col-span-5 space-y-6">
          {/* Selected Day Panel */}
          <section className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Selected Date:{' '}
                <span className="font-mono text-indigo-800">{selectedDate || 'None'}</span>
              </h3>
              <span className="text-xs text-slate-500">
                {selectedDayEvents.length} item(s)
              </span>
            </div>

            {selectedDayEvents.length === 0 ? (
              <p className="text-xs text-slate-500 py-5 text-center">
                No regulatory milestones or meeting logs on this date. Click a highlighted calendar day or browse upcoming deadlines below.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {selectedDayEvents.map((ev) => {
                  const meta = CATEGORY_META[ev.category];
                  return (
                    <div
                      key={ev.id}
                      className="p-3.5 rounded-lg border border-slate-200 bg-[#FBFBFF]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded border ${meta.badgeClass}`}
                        >
                          {meta.label}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-slate-500">
                            {formatDeltaLabel(ev.daysFromToday)}
                          </span>
                          {ev.isCustom && isAdmin && (
                            <button
                              type="button"
                              onClick={() => handleDeleteCustom(ev.id)}
                              title="Delete custom event"
                              className="p-1 text-slate-400 hover:text-rose-700 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 mt-1.5">{ev.title}</div>
                      <div className="text-xs text-slate-600 mt-1 leading-relaxed">{ev.notes}</div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="font-mono">{ev.referenceNumber}</span>
                        <span>{confidenceLabel(ev.confidence)}</span>
                      </div>
                      {ev.sourceUrl && (
                        <a
                          href={ev.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline"
                        >
                          Open NPPA Portal Reference <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Upcoming Timeline */}
          <section className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-indigo-700" />
                <h3 className="font-display text-sm font-semibold text-slate-900">
                  Upcoming Deadlines &amp; Projected Meetings
                </h3>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {upcomingEvents.length} upcoming
              </span>
            </div>

            <div className="mt-3 divide-y divide-slate-200 max-h-[420px] overflow-y-auto pr-1">
              {upcomingEvents.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-500">
                  No upcoming events match the current filter.
                </div>
              ) : (
                upcomingEvents.map((ev) => {
                  const meta = CATEGORY_META[ev.category];
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => {
                        setSelectedDate(ev.date);
                        const [y, m] = ev.date.split('-').map(Number);
                        if (y && m) setCurrentMonth({ year: y, month: m - 1 });
                      }}
                      className="w-full py-3 text-left hover:bg-[#FBFBFF] transition-colors cursor-pointer flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span
                            className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded border ${meta.badgeClass}`}
                          >
                            {meta.label}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {confidenceLabel(ev.confidence)}
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-slate-900">{ev.title}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                          {ev.referenceNumber} · {ev.sourceTitle}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-xs font-semibold text-indigo-950 tabular-nums">
                          {ev.date}
                        </div>
                        <div
                          className={`text-[11px] font-medium mt-0.5 tabular-nums ${
                            ev.daysFromToday <= 14 ? 'text-rose-700' : 'text-slate-500'
                          }`}
                        >
                          {formatDeltaLabel(ev.daysFromToday)}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Admin Add Meeting / Deadline Modal */}
      {showAddModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="font-display text-lg font-semibold text-slate-900">
                Add Regulatory Meeting or Deadline
              </h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 p-3 rounded-lg bg-[#FFF1F2] border border-rose-200 text-xs text-rose-900">
                {formError}
              </div>
            )}

            <form onSubmit={handleAddCustomEvent} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Event / Deadline Title
                </label>
                <input
                  type="text"
                  required
                  value={newEvent.title}
                  onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                  placeholder="e.g. 75th Expert Committee Confirmed Session / Form I Filing"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    required
                    value={newEvent.date}
                    onChange={(e) => setNewEvent({ ...newEvent, date: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={newEvent.category}
                    onChange={(e) =>
                      setNewEvent({
                        ...newEvent,
                        category: e.target.value as CalendarEventCategory,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="expert_committee">Expert Committee (MDC)</option>
                    <option value="authority_meeting">Authority Meeting</option>
                    <option value="ceiling_deadline">45-Day MRP / Form V Deadline</option>
                    <option value="form1a_expiry">Form 1A Retention Milestone</option>
                    <option value="custom_deadline">Internal Compliance Deadline</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Reference Number (Optional)
                </label>
                <input
                  type="text"
                  value={newEvent.referenceNumber}
                  onChange={(e) => setNewEvent({ ...newEvent, referenceNumber: e.target.value })}
                  placeholder="e.g. MDC/75/2026 or Form I Dossier"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                <textarea
                  rows={3}
                  value={newEvent.notes}
                  onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })}
                  placeholder="Submission requirements, affected products, or agenda notes..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer"
                >
                  {saving ? 'Saving…' : 'Save Calendar Event'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
