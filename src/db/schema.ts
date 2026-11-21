import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { ExistingCompanyFormulation, NlemDosageOption } from '../types/compliance.ts';

// Users linked to Firebase Auth UID (also supports provisioned Login ID accounts)
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  loginId: text('login_id').notNull(),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  department: text('department').notNull().default('Regulatory Affairs'),
  role: text('role').notNull().default('user'), // 'admin' | 'user'
  passwordHash: text('password_hash').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at'),
});

// Log 1: NPPA Ceiling Price Notifications Log
export const nppaCeilingLogs = pgTable('nppa_ceiling_logs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  referenceNumber: text('reference_number').notNull(),
  publishedDate: text('published_date').notNull(),
  summary: text('summary').notNull().default(''),
  url: text('url').notNull(),
  pdfUrl: text('pdf_url'),
  fetchedAt: text('fetched_at').notNull(),
  isLiveFetched: boolean('is_live_fetched').notNull().default(true),
  soImportedAt: text('so_imported_at'),
  importedEntryCount: integer('imported_entry_count'),
});

// Log 2: NPPA Retail Price Notifications Log
export const nppaRetailLogs = pgTable('nppa_retail_logs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  referenceNumber: text('reference_number').notNull(),
  publishedDate: text('published_date').notNull(),
  summary: text('summary').notNull().default(''),
  url: text('url').notNull(),
  pdfUrl: text('pdf_url'),
  fetchedAt: text('fetched_at').notNull(),
  isLiveFetched: boolean('is_live_fetched').notNull().default(true),
  soImportedAt: text('so_imported_at'),
  importedEntryCount: integer('imported_entry_count'),
});

// Log 3: NPPA Meeting Minutes Log (Authority Meetings & Multidisciplinary Expert Committee)
export const nppaMeetingMinutesLogs = pgTable('nppa_meeting_minutes_logs', {
  id: text('id').primaryKey(),
  minuteType: text('minute_type').notNull().default('authority_minutes'), // 'authority_minutes' | 'expert_committee'
  title: text('title').notNull(),
  referenceNumber: text('reference_number').notNull(),
  publishedDate: text('published_date').notNull(),
  summary: text('summary').notNull().default(''),
  url: text('url').notNull(),
  pdfUrl: text('pdf_url'),
  fetchedAt: text('fetched_at').notNull(),
  isLiveFetched: boolean('is_live_fetched').notNull().default(true),
  soImportedAt: text('so_imported_at'),
  importedEntryCount: integer('imported_entry_count'),
});

// Ceiling Price Notification Records (stores full notification versions per formulation;
// latest record per formulation_key by effectiveDate/notificationDate is resolved as implemented ceiling price)
export const ceilingPrices = pgTable('ceiling_prices', {
  id: text('id').primaryKey(),
  formulationKey: text('formulation_key').notNull(),
  medicineName: text('medicine_name').notNull(),
  composition: text('composition').notNull(),
  strength: text('strength').notNull(),
  dosageFormat: text('dosage_format').notNull(),
  unitLabel: text('unit_label').notNull(),
  ceilingPrice: doublePrecision('ceiling_price').notNull(),
  notificationNumber: text('notification_number').notNull(),
  notificationDate: text('notification_date').notNull(),
  effectiveDate: text('effective_date').notNull(),
  nlemSection: text('nlem_section').notNull().default('NLEM 2022'),
  gstDefault: integer('gst_default').notNull().default(12),
  sourceUrl: text('source_url').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const ceilingPriceHistory = pgTable('ceiling_price_history', {
  id: text('id').primaryKey(),
  ceilingPriceId: text('ceiling_price_id').notNull(),
  medicineName: text('medicine_name').notNull(),
  strength: text('strength').notNull(),
  dosageFormat: text('dosage_format').notNull(),
  changeType: text('change_type').notNull(),
  previousCeilingPrice: doublePrecision('previous_ceiling_price'),
  newCeilingPrice: doublePrecision('new_ceiling_price'),
  notificationNumber: text('notification_number').notNull(),
  notificationDate: text('notification_date').notNull(),
  source: text('source').notNull(),
  changedBy: text('changed_by').notNull(),
  notes: text('notes').notNull(),
  timestamp: text('timestamp').notNull(),
});

export const retailPrices = pgTable('retail_prices', {
  id: text('id').primaryKey(),
  notificationNumber: text('notification_number').notNull(),
  notificationDate: text('notification_date').notNull(),
  formulation: text('formulation').notNull(),
  composition: text('composition').notNull(),
  strength: text('strength').notNull(),
  dosageFormat: text('dosage_format').notNull(),
  unitLabel: text('unit_label').notNull(),
  retailPrice: doublePrecision('retail_price').notNull(),
  applicantCompany: text('applicant_company').notNull(),
  sourceUrl: text('source_url').notNull(),
  createdAt: text('created_at').notNull(),
});

export const nlem2022 = pgTable('nlem_2022', {
  id: text('id').primaryKey(),
  medicineName: text('medicine_name').notNull(),
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  therapeuticCategory: text('therapeutic_category').notNull(),
  sectionCode: text('section_code').notNull(),
  dosageForms: jsonb('dosage_forms').$type<NlemDosageOption[]>().notNull().default([]),
  notes: text('notes'),
});

export const companyProfiles = pgTable('company_profiles', {
  id: text('id').primaryKey(),
  companyName: text('company_name').notNull(),
  cin: text('cin').notNull().default(''),
  gstin: text('gstin').notNull().default(''),
  manufacturingLicenseNo: text('manufacturing_license_no').notNull().default(''),
  corporateAddress: text('corporate_address').notNull().default(''),
  regulatoryOfficerName: text('regulatory_officer_name').notNull().default(''),
  regulatoryOfficerEmail: text('regulatory_officer_email').notNull().default(''),
  existingFormulations: jsonb('existing_formulations')
    .$type<ExistingCompanyFormulation[]>()
    .notNull()
    .default([]),
  updatedAt: text('updated_at').notNull(),
});

export const soTrackingRecords = pgTable('so_tracking_records', {
  id: text('id').primaryKey(),
  soNumber: text('so_number').notNull(),
  soDate: text('so_date').notNull(),
  sourceType: text('source_type').notNull(),
  sourceFileName: text('source_file_name'),
  sourceUrl: text('source_url'),
  ceilingCount: integer('ceiling_count').notNull().default(0),
  retailCount: integer('retail_count').notNull().default(0),
  importedBy: text('imported_by').notNull(),
  importedAt: text('imported_at').notNull(),
  notes: text('notes'),
});

export const syncLogs = pgTable('sync_logs', {
  id: text('id').primaryKey(),
  triggeredBy: text('triggered_by').notNull(),
  timestamp: text('timestamp').notNull(),
  status: text('status').notNull(),
  circularsFetched: integer('circulars_fetched').notNull().default(0),
  authorityMinutesFetched: integer('authority_minutes_fetched').notNull().default(0),
  expertNotesFetched: integer('expert_notes_fetched').notNull().default(0),
  newCeilingPricesFound: integer('new_ceiling_prices_found').notNull().default(0),
  newRetailPricesFound: integer('new_retail_prices_found').notNull().default(0),
  message: text('message').notNull(),
});

export const customCalendarEvents = pgTable('custom_calendar_events', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  date: text('date').notNull(),
  category: text('category').notNull(),
  referenceNumber: text('reference_number').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
