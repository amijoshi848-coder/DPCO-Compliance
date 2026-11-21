export type UserRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  loginId: string;
  fullName: string;
  department: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AllowedUserRecord extends AuthUser {
  passwordHash: string;
}

export interface CeilingPriceEntry {
  id: string;
  formulationKey?: string;
  medicineName: string;
  composition: string;
  strength: string;
  dosageFormat: string;
  unitLabel: string;
  ceilingPrice: number;
  notificationNumber: string;
  notificationDate: string;
  effectiveDate: string;
  nlemSection: string;
  gstDefault: number;
  sourceUrl: string;
  updatedAt: string;
  supersededCount?: number;
}

export interface RetailPriceEntry {
  id: string;
  notificationNumber: string;
  notificationDate: string;
  formulation: string;
  composition: string;
  strength: string;
  dosageFormat: string;
  unitLabel: string;
  retailPrice: number;
  applicantCompany: string;
  sourceUrl: string;
  createdAt: string;
}

export type NppaSourceType = 'circular' | 'authority_minutes' | 'expert_committee';

export type NppaLogCategory = 'ceiling_price' | 'retail_price' | 'meeting_minutes';

export interface NppaDocumentLog {
  id: string;
  sourceType: NppaSourceType;
  logCategory?: NppaLogCategory;
  title: string;
  referenceNumber: string;
  publishedDate: string;
  summary: string;
  url: string;
  pdfUrl?: string;
  fetchedAt: string;
  isLiveFetched: boolean;
  soImportedAt?: string;
  importedEntryCount?: number;
}

export interface NppaGroupedLogsResponse {
  items: NppaDocumentLog[];
  ceilingLogs: NppaDocumentLog[];
  retailLogs: NppaDocumentLog[];
  meetingMinutesLogs: NppaDocumentLog[];
  syncLogs: SyncLogEntry[];
}

export interface NlemDosageOption {
  dosageForm: string;
  strength: string;
  route?: string;
  levelOfHealthcare?: string;
}

export interface Nlem2022Entry {
  id: string;
  medicineName: string;
  aliases?: string[];
  therapeuticCategory: string;
  sectionCode: string;
  dosageForms: NlemDosageOption[];
  notes?: string;
}

export interface FdcComponent {
  ingredient: string;
  strength: string;
}

export interface ExistingCompanyFormulation {
  id: string;
  medicineName: string;
  composition?: string;
  isFdc?: boolean;
  components?: FdcComponent[];
  dosageForm: string;
  strength: string;
  category?: string;
  pack?: string;
  mrp?: number;
  brandName?: string;
  marketingStatus: 'Active' | 'Discontinued';
}

export interface CompanyProfile {
  companyName: string;
  cin: string;
  gstin: string;
  manufacturingLicenseNo: string;
  corporateAddress: string;
  regulatoryOfficerName: string;
  regulatoryOfficerEmail: string;
  existingFormulations: ExistingCompanyFormulation[];
  updatedAt: string;
}

export interface SyncLogEntry {
  id: string;
  triggeredBy: 'scheduled_10am_ist' | 'manual';
  timestamp: string;
  status: 'success' | 'partial' | 'fallback';
  circularsFetched: number;
  authorityMinutesFetched: number;
  expertNotesFetched: number;
  newCeilingPricesFound: number;
  newRetailPricesFound: number;
  message: string;
}

export interface Form1IngredientMatch {
  extractedToken: string;
  matchedMedicine: string | null;
  isNlem2022: boolean;
  isOmittedFromNlem2022?: boolean;
  omissionNote?: string;
  nlemEntry?: Nlem2022Entry;
  companyMatches: ExistingCompanyFormulation[];
}

export interface Form1CheckResult {
  productName: string;
  dosageForm: string;
  compositionText: string;
  hasScheduledIngredient: boolean;
  isExistingManufacturerInPortfolio: boolean;
  form1RequiredBasedOnPortfolio: boolean;
  summaryHeadline: string;
  regulatoryGuidance: string;
  existingManufacturerConditions: string[];
  matches: Form1IngredientMatch[];
  checkedAt: string;
}

export interface CeilingPriceHistoryEntry {
  id: string;
  ceilingPriceId: string;
  medicineName: string;
  strength: string;
  dosageFormat: string;
  changeType: 'created' | 'revised' | 'deleted';
  previousCeilingPrice: number | null;
  newCeilingPrice: number | null;
  notificationNumber: string;
  notificationDate: string;
  source: 'scheduled_10am_ist' | 'manual_sync' | 'admin_edit' | 'notification_parser';
  changedBy: string;
  notes: string;
  timestamp: string;
}

export type SearchResultCategory =
  | 'ceiling'
  | 'retail'
  | 'nlem'
  | 'nppa_log'
  | 'history';

export interface GlobalSearchResultItem {
  id: string;
  category: SearchResultCategory;
  title: string;
  subtitle: string;
  meta: string;
  tabTarget: 'schedule_formulations' | 'retail_prices' | 'new_product';
  searchKeyword: string;
}

export interface GlobalSearchResponse {
  query: string;
  total: number;
  results: GlobalSearchResultItem[];
}

export interface AiGroundingSource {
  title: string;
  uri: string;
}

export interface AiChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiParsedNotificationRow {
  kind: 'ceiling' | 'retail';
  medicineName: string;
  composition: string;
  strength: string;
  dosageFormat: string;
  unitLabel: string;
  price: number;
  notificationNumber: string;
  notificationDate: string;
  nlemSection: string;
}

export interface AiForm1Brief {
  riskLevel: 'High' | 'Medium' | 'Low';
  verdictSummary: string;
  legalBasis: string;
  actionChecklist: string[];
  form1aBenchmarkNote: string;
}

export type CalendarEventCategory =
  | 'authority_meeting'
  | 'expert_committee'
  | 'ceiling_deadline'
  | 'form1a_expiry'
  | 'custom_deadline';

export type CalendarEventConfidence =
  | 'confirmed_log'
  | 'derived_dpco_rule'
  | 'projected_cadence'
  | 'manual';

export interface CustomCalendarEvent {
  id: string;
  title: string;
  date: string;
  category: CalendarEventCategory;
  referenceNumber: string;
  notes: string;
  createdBy: string;
  createdAt: string;
}

export interface ComplianceCalendarEvent {
  id: string;
  title: string;
  date: string;
  category: CalendarEventCategory;
  confidence: CalendarEventConfidence;
  status: 'upcoming' | 'due_soon' | 'logged' | 'overdue';
  daysFromToday: number;
  referenceNumber: string;
  sourceTitle: string;
  sourceUrl?: string;
  notes: string;
  isCustom?: boolean;
}

export interface ComplianceCalendarResponse {
  todayIst: string;
  events: ComplianceCalendarEvent[];
  summary: {
    upcomingMeetings: number;
    dueWithin45Days: number;
    form1aExpiries: number;
    totalEvents: number;
  };
}

export interface SoTrackingRecord {
  id: string;
  soNumber: string;
  soDate: string;
  sourceType: 'pdf_upload' | 'nppa_pdf_url' | 'daily_nppa_sync' | 'manual_entry';
  sourceFileName?: string;
  sourceUrl?: string;
  ceilingCount: number;
  retailCount: number;
  importedBy: string;
  importedAt: string;
  notes?: string;
}

export interface PdfConversionResult {
  soNumber: string;
  soDate: string;
  documentTitle: string;
  fileName: string;
  rows: AiParsedNotificationRow[];
}

