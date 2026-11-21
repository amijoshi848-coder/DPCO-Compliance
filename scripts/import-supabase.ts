import 'dotenv/config';
import { importDatabaseFile } from '../server/storage.ts';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/import-supabase.ts /path/to/verified-backup.json');
await importDatabaseFile(file);
console.log('Database imported. Existing Supabase records are never overwritten.');
