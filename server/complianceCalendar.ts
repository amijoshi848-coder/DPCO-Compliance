import type {
  CalendarEventCategory,
  ComplianceCalendarEvent,
  ComplianceCalendarResponse,
} from '../src/types/compliance.ts';
import { getIstDateAndTimeParts } from './nppaScraper.ts';
import type { DatabaseState } from './storage.ts';

function addDaysIso(isoDate: string, days: number): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addYearsIso(isoDate: string, years: number): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCFullYear(dt.getUTCFullYear() + years);
  return dt.toISOString().slice(0, 10);
}

function diffDaysIso(targetIso: string, todayIso: string): number {
  const t = new Date(`${targetIso}T00:00:00Z`).getTime();
  const base = new Date(`${todayIso}T00:00:00Z`).getTime();
  return Math.round((t - base) / (1000 * 60 * 60 * 24));
}

function extractNextOrdinal(text: string): string | null {
  const m = text.match(/\b(\d+)(?:st|nd|rd|th)\b/i);
  if (!m) return null;
  const next = Number(m[1]) + 1;
  if (!Number.isFinite(next)) return null;
  const mod100 = next % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : next % 10 === 1
        ? 'st'
        : next % 10 === 2
          ? 'nd'
          : next % 10 === 3
            ? 'rd'
            : 'th';
  return `${next}${suffix}`;
}

function computeStatus(
  daysFromToday: number,
  confidence: ComplianceCalendarEvent['confidence'],
  category: CalendarEventCategory
): ComplianceCalendarEvent['status'] {
  if (daysFromToday < 0) {
    if (
      confidence === 'confirmed_log' &&
      (category === 'authority_meeting' || category === 'expert_committee')
    ) {
      return 'logged';
    }
    return 'overdue';
  }
  if (daysFromToday <= 14) return 'due_soon';
  return 'upcoming';
}

function extractExplicitDatesFromText(text: string): string[] {
  const found: string[] = [];
  const isoMatches = text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g);
  for (const m of isoMatches) {
    found.push(m[0]);
  }
  const dmyMatches = text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g);
  for (const m of dmyMatches) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    found.push(`${m[3]}-${mm}-${dd}`);
  }
  return Array.from(new Set(found));
}

export function buildComplianceCalendar(db: DatabaseState): ComplianceCalendarResponse {
  const { istDate: todayIst } = getIstDateAndTimeParts();
  const events: ComplianceCalendarEvent[] = [];

  // 1. Authority & Expert Committee Meeting Logs + Explicit Dates in Text
  const authorityLogs = db.nppaLogs
    .filter((l) => l.sourceType === 'authority_minutes')
    .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));

  const expertLogs = db.nppaLogs
    .filter((l) => l.sourceType === 'expert_committee')
    .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));

  for (const log of authorityLogs) {
    const delta = diffDaysIso(log.publishedDate, todayIst);
    events.push({
      id: `cal-log-${log.id}`,
      title: log.title,
      date: log.publishedDate,
      category: 'authority_meeting',
      confidence: 'confirmed_log',
      status: computeStatus(delta, 'confirmed_log', 'authority_meeting'),
      daysFromToday: delta,
      referenceNumber: log.referenceNumber,
      sourceTitle: 'NPPA Authority Meeting Minutes (2026–2027)',
      sourceUrl: log.url,
      notes: log.summary,
    });
  }

  for (const log of expertLogs) {
    const delta = diffDaysIso(log.publishedDate, todayIst);
    events.push({
      id: `cal-log-${log.id}`,
      title: log.title,
      date: log.publishedDate,
      category: 'expert_committee',
      confidence: 'confirmed_log',
      status: computeStatus(delta, 'confirmed_log', 'expert_committee'),
      daysFromToday: delta,
      referenceNumber: log.referenceNumber,
      sourceTitle: 'Multidisciplinary Committee of Experts',
      sourceUrl: log.url,
      notes: log.summary,
    });
  }

  // Scan all NPPA log titles/summaries for explicit future dates
  for (const log of db.nppaLogs) {
    const embeddedDates = extractExplicitDatesFromText(`${log.title} ${log.summary}`);
    for (const dt of embeddedDates) {
      if (dt > log.publishedDate && dt >= todayIst) {
        const delta = diffDaysIso(dt, todayIst);
        const cat: CalendarEventCategory =
          log.sourceType === 'authority_minutes'
            ? 'authority_meeting'
            : log.sourceType === 'expert_committee'
              ? 'expert_committee'
              : 'ceiling_deadline';
        events.push({
          id: `cal-extracted-${log.id}-${dt}`,
          title: `Referenced Date: ${log.title}`,
          date: dt,
          category: cat,
          confidence: 'confirmed_log',
          status: computeStatus(delta, 'confirmed_log', cat),
          daysFromToday: delta,
          referenceNumber: log.referenceNumber,
          sourceTitle: log.title,
          sourceUrl: log.url,
          notes: log.summary,
        });
      }
    }
  }

  // Project upcoming Authority Meeting from observed cadence if none is upcoming in logs
  const hasFutureAuthority =
    authorityLogs.some((l) => l.publishedDate >= todayIst) ||
    db.customCalendarEvents.some(
      (e) => e.category === 'authority_meeting' && e.date >= todayIst
    );

  if (!hasFutureAuthority && authorityLogs.length > 0) {
    const latest = authorityLogs[0];
    let cadence = 38;
    if (authorityLogs.length >= 2) {
      const gap = Math.abs(diffDaysIso(latest.publishedDate, authorityLogs[1].publishedDate));
      if (gap >= 25 && gap <= 55) cadence = gap;
    }
    let projectedDate = addDaysIso(latest.publishedDate, cadence);
    while (projectedDate < todayIst) {
      projectedDate = addDaysIso(projectedDate, cadence);
    }
    const nextOrdinal = extractNextOrdinal(latest.title);
    const nextTitle = nextOrdinal
      ? `${nextOrdinal} NPPA Authority Meeting (Projected Cadence)`
      : 'Next NPPA Authority Meeting (Projected Cadence)';
    const delta = diffDaysIso(projectedDate, todayIst);

    events.push({
      id: `cal-proj-auth-${projectedDate}`,
      title: nextTitle,
      date: projectedDate,
      category: 'authority_meeting',
      confidence: 'projected_cadence',
      status: computeStatus(delta, 'projected_cadence', 'authority_meeting'),
      daysFromToday: delta,
      referenceNumber: `Cadence from ${latest.referenceNumber}`,
      sourceTitle: latest.title,
      sourceUrl: latest.url,
      notes: `Projected ${cadence}-day cycle following ${latest.referenceNumber} (${latest.publishedDate}). Verify Form I & Form 1A retail price agenda items ahead of Authority approval.`,
    });
  }

  // Project upcoming Expert Committee (MDC) Meeting + Form I Dossier Cutoff
  const hasFutureExpert =
    expertLogs.some((l) => l.publishedDate >= todayIst) ||
    db.customCalendarEvents.some(
      (e) => e.category === 'expert_committee' && e.date >= todayIst
    );

  if (!hasFutureExpert && expertLogs.length > 0) {
    const latest = expertLogs[0];
    let cadence = 45;
    if (expertLogs.length >= 2) {
      const gap = Math.abs(diffDaysIso(latest.publishedDate, expertLogs[1].publishedDate));
      if (gap >= 25 && gap <= 60) cadence = gap;
    }
    let projectedDate = addDaysIso(latest.publishedDate, cadence);
    while (projectedDate < todayIst) {
      projectedDate = addDaysIso(projectedDate, cadence);
    }
    const nextOrdinal = extractNextOrdinal(latest.title);
    const nextTitle = nextOrdinal
      ? `${nextOrdinal} Multidisciplinary Expert Committee Meeting (Projected)`
      : 'Next Multidisciplinary Expert Committee Meeting (Projected)';
    const delta = diffDaysIso(projectedDate, todayIst);

    events.push({
      id: `cal-proj-mdc-${projectedDate}`,
      title: nextTitle,
      date: projectedDate,
      category: 'expert_committee',
      confidence: 'projected_cadence',
      status: computeStatus(delta, 'projected_cadence', 'expert_committee'),
      daysFromToday: delta,
      referenceNumber: `Cadence from ${latest.referenceNumber}`,
      sourceTitle: latest.title,
      sourceUrl: latest.url,
      notes: `Projected ${cadence}-day cycle following ${latest.referenceNumber} (${latest.publishedDate}) for technical Form I FDC & pricing reviews.`,
    });

    const cutoffDate = addDaysIso(projectedDate, -10);
    if (cutoffDate >= addDaysIso(todayIst, -7)) {
      const cutoffDelta = diffDaysIso(cutoffDate, todayIst);
      events.push({
        id: `cal-proj-mdc-cutoff-${cutoffDate}`,
        title: `Form I Technical Dossier Submission Window (${nextOrdinal || 'Next'} MDC)`,
        date: cutoffDate,
        category: 'expert_committee',
        confidence: 'derived_dpco_rule',
        status: computeStatus(cutoffDelta, 'derived_dpco_rule', 'expert_committee'),
        daysFromToday: cutoffDelta,
        referenceNumber: `Pre-${latest.referenceNumber} Agenda`,
        sourceTitle: latest.title,
        sourceUrl: latest.url,
        notes:
          'Recommended internal cutoff (10 days prior to projected MDC session) to finalize Form I cost/clinical justification dossiers for scheduled combination launches.',
      });
    }
  }

  // 2. DPCO 2013 Para 24(2) 45-Day MRP Implementation & Form V Deadlines from Ceiling Prices
  const notifBuckets = new Map<
    string,
    { notificationNumber: string; notificationDate: string; medicines: string[]; sourceUrl: string }
  >();
  for (const cp of db.ceilingPrices) {
    const key = `${cp.notificationNumber}|${cp.notificationDate}`;
    const existing = notifBuckets.get(key);
    const label = `${cp.medicineName} ${cp.strength} ${cp.dosageFormat}`;
    if (existing) {
      if (!existing.medicines.includes(label)) existing.medicines.push(label);
    } else {
      notifBuckets.set(key, {
        notificationNumber: cp.notificationNumber,
        notificationDate: cp.notificationDate,
        medicines: [label],
        sourceUrl: cp.sourceUrl,
      });
    }
  }

  for (const bucket of notifBuckets.values()) {
    const deadlineDate = addDaysIso(bucket.notificationDate, 45);
    const delta = diffDaysIso(deadlineDate, todayIst);
    if (delta < -30) continue; // omit stale deadlines older than 30 days
    events.push({
      id: `cal-cp-45d-${bucket.notificationNumber}-${bucket.notificationDate}`,
      title: `45-Day Revised MRP & Form V Filing Deadline (${bucket.notificationNumber})`,
      date: deadlineDate,
      category: 'ceiling_deadline',
      confidence: 'derived_dpco_rule',
      status: computeStatus(delta, 'derived_dpco_rule', 'ceiling_deadline'),
      daysFromToday: delta,
      referenceNumber: bucket.notificationNumber,
      sourceTitle: `Issued ${bucket.notificationDate} · ${bucket.medicines.slice(0, 3).join(', ')}`,
      sourceUrl: bucket.sourceUrl,
      notes: `DPCO 2013 Para 24(2) mandates revised MRP implementation and Form V submission within 45 days of ${bucket.notificationNumber} (${bucket.notificationDate}). Covers: ${bucket.medicines.join(', ')}.`,
    });
  }

  // 3. Retail Price Circulars (Post 16 July 2026) — 45-Day Form V & 1-Year Retention Expiries
  for (const rp of db.retailPrices) {
    if (rp.notificationDate <= '2026-07-16') continue;

    const formVDate = addDaysIso(rp.notificationDate, 45);
    const formVDelta = diffDaysIso(formVDate, todayIst);
    if (formVDelta >= -15) {
      events.push({
        id: `cal-rp-45d-${rp.id}`,
        title: `Form 1A / Form V Adoption Window (${rp.notificationNumber})`,
        date: formVDate,
        category: 'ceiling_deadline',
        confidence: 'derived_dpco_rule',
        status: computeStatus(formVDelta, 'derived_dpco_rule', 'ceiling_deadline'),
        daysFromToday: formVDelta,
        referenceNumber: rp.notificationNumber,
        sourceTitle: rp.formulation,
        sourceUrl: rp.sourceUrl,
        notes: `45-day window from ${rp.notificationDate} retail price notification (₹${rp.retailPrice.toFixed(2)}/${rp.unitLabel}) for Form 1A adoption & Form V filing.`,
      });
    }

    const expiryDate = addYearsIso(rp.notificationDate, 1);
    const expiryDelta = diffDaysIso(expiryDate, todayIst);
    events.push({
      id: `cal-rp-exp-${rp.id}`,
      title: `Form 1A 1-Year Retention Expiry: ${rp.formulation}`,
      date: expiryDate,
      category: 'form1a_expiry',
      confidence: 'derived_dpco_rule',
      status: computeStatus(expiryDelta, 'derived_dpco_rule', 'form1a_expiry'),
      daysFromToday: expiryDelta,
      referenceNumber: rp.notificationNumber,
      sourceTitle: `Notified ${rp.notificationDate} · ₹${rp.retailPrice.toFixed(2)}/${rp.unitLabel}`,
      sourceUrl: rp.sourceUrl,
      notes: `1-year validity window for Form 1A benchmark retail price (${rp.notificationNumber}, issued ${rp.notificationDate}) expires on ${expiryDate}.`,
    });
  }

  // 4. Custom Admin Deadlines & Confirmed Meetings
  for (const custom of db.customCalendarEvents) {
    const delta = diffDaysIso(custom.date, todayIst);
    events.push({
      id: custom.id,
      title: custom.title,
      date: custom.date,
      category: custom.category,
      confidence: 'manual',
      status: computeStatus(delta, 'manual', custom.category),
      daysFromToday: delta,
      referenceNumber: custom.referenceNumber || 'Internal',
      sourceTitle: `Scheduled by ${custom.createdBy}`,
      notes: custom.notes,
      isCustom: true,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  const upcomingMeetings = events.filter(
    (e) =>
      (e.category === 'authority_meeting' || e.category === 'expert_committee') &&
      e.daysFromToday >= 0
  ).length;
  const dueWithin45Days = events.filter(
    (e) => e.daysFromToday >= 0 && e.daysFromToday <= 45
  ).length;
  const form1aExpiries = events.filter(
    (e) => e.category === 'form1a_expiry' && e.daysFromToday >= 0
  ).length;

  return {
    todayIst,
    events,
    summary: {
      upcomingMeetings,
      dueWithin45Days,
      form1aExpiries,
      totalEvents: events.length,
    },
  };
}
