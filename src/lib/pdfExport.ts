import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { EnrichedRetailPrice } from '../components/RetailPricesTab';
import type { CeilingPriceEntry, CeilingPriceHistoryEntry } from '../types/compliance';

function addPdfHeader(doc: jsPDF, title: string, subtitle: string) {
  doc.setFillColor(238, 242, 255); // soft pastel periwinkle header band
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, 'F');

  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('DPCO Compliance — ' + title, 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(subtitle, 14, 19);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
}

export function exportScheduleMasterPdf(params: {
  items: CeilingPriceEntry[];
  gstRate: number;
  packSize: number;
  searchQuery: string;
}) {
  const { items, gstRate, packSize, searchQuery } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const filterNote = searchQuery.trim()
    ? `Filter: "${searchQuery.trim()}" | `
    : 'All Scheduled Formulations | ';
  addPdfHeader(
    doc,
    'Schedule Formulations (Ceiling Price Master)',
    `${filterNote}GST: ${gstRate}% | Pack Size: ${packSize} unit(s) | Records: ${items.length}`
  );

  const calcUnit = (cp: number) => cp + cp * (gstRate / 100);
  const calcPack = (cp: number) => calcUnit(cp) * Math.max(1, packSize);

  autoTable(doc, {
    startY: 34,
    head: [
      [
        'Medicine & Composition',
        'Strength & Format',
        'NLEM Sec',
        'Notification No.',
        'Date',
        'Ceiling Price (INR)',
        `Unit MRP (${gstRate}% GST)`,
        `Pack MRP (${packSize}u)`,
      ],
    ],
    body: items.map((item) => [
      `${item.medicineName}\n${item.composition}`,
      `${item.strength} ${item.dosageFormat} (${item.unitLabel})`,
      item.nlemSection,
      item.notificationNumber,
      item.notificationDate,
      item.ceilingPrice.toFixed(2),
      calcUnit(item.ceilingPrice).toFixed(2),
      calcPack(item.ceilingPrice).toFixed(2),
    ]),
    styles: {
      fontSize: 8.5,
      cellPadding: 3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [224, 231, 255],
      textColor: [30, 58, 138],
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right', fontStyle: 'bold' },
    },
  });

  doc.save(`dpco-schedule-formulations-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function exportScheduleHistoryPdf(history: CeilingPriceHistoryEntry[]) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  addPdfHeader(
    doc,
    'Ceiling Price Update History & Change Log',
    `Audit trail of NPPA ceiling price revisions and master updates | Records: ${history.length}`
  );

  autoTable(doc, {
    startY: 34,
    head: [
      [
        'Formulation',
        'Change Type',
        'Previous Price (INR)',
        'New Price (INR)',
        'Notification No.',
        'Date',
        'Updated By',
        'Notes',
      ],
    ],
    body: history.map((h) => [
      `${h.medicineName} (${h.strength} ${h.dosageFormat})`,
      h.changeType.toUpperCase(),
      h.previousCeilingPrice != null ? h.previousCeilingPrice.toFixed(2) : '-',
      h.newCeilingPrice != null ? h.newCeilingPrice.toFixed(2) : 'Removed',
      h.notificationNumber,
      h.notificationDate,
      `${h.changedBy}\n${new Date(h.timestamp).toLocaleString()}`,
      h.notes,
    ]),
    styles: {
      fontSize: 8.5,
      cellPadding: 3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [237, 233, 254],
      textColor: [91, 33, 182],
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [250, 249, 255],
    },
    columnStyles: {
      2: { halign: 'right' },
      3: { halign: 'right' },
    },
  });

  doc.save(`dpco-ceiling-price-history-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function exportRetailPricesPdf(params: {
  items: EnrichedRetailPrice[];
  gstRate: number;
  packSize: number;
  retentionFilter: 'active' | 'all';
  searchQuery: string;
}) {
  const { items, gstRate, packSize, retentionFilter, searchQuery } = params;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const filterParts = [
    retentionFilter === 'active' ? 'Active 1-Yr Retention Window' : 'All Post-16 Jul 2026 Logs',
    searchQuery.trim() ? `Search: "${searchQuery.trim()}"` : null,
    `GST: ${gstRate}%`,
    `Pack: ${packSize}u`,
    `Records: ${items.length}`,
  ]
    .filter(Boolean)
    .join(' | ');

  addPdfHeader(
    doc,
    'Retail Prices — Form 1A Ready Reference (Post 16 July 2026)',
    filterParts
  );

  const calcPack = (rp: number) => (rp + rp * (gstRate / 100)) * Math.max(1, packSize);

  autoTable(doc, {
    startY: 34,
    head: [
      [
        'Notification No.',
        'Notification Date',
        'Formulation',
        'Unit',
        'Retail Price (INR)',
        `Pack MRP (${packSize}u · ${gstRate}% GST)`,
        '1-Yr Retention Until',
        'Status',
      ],
    ],
    body: items.map((item) => [
      item.notificationNumber,
      item.notificationDate,
      `${item.formulation}\n${item.applicantCompany}`,
      item.unitLabel,
      item.retailPrice.toFixed(2),
      calcPack(item.retailPrice).toFixed(2),
      item.retentionExpiresOn,
      item.isActiveRetention ? `${item.daysRemaining} days left` : 'Expired (>1 yr)',
    ]),
    styles: {
      fontSize: 8.5,
      cellPadding: 3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [209, 250, 229],
      textColor: [6, 95, 70],
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [247, 254, 251],
    },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right', fontStyle: 'bold' },
    },
  });

  doc.save(`dpco-retail-prices-form1a-${new Date().toISOString().slice(0, 10)}.pdf`);
}
