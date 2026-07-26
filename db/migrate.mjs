import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined });
await db.connect();
try {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
    try { await db.query(statement); }
    catch (error) { if (!['42P07', '42710'].includes(error.code)) throw error; }
  }
} finally { await db.end(); }
console.log('Nexus database schema is ready');
