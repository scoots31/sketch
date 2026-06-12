import pkg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { Pool } = pkg
const __dirname = dirname(fileURLToPath(import.meta.url))

// Render provides DATABASE_URL and requires SSL; local dev uses a plain connection.
const connectionString =
  process.env.DATABASE_URL || 'postgres://localhost:5432/sketch_dev'
const isRemote = /render\.com|amazonaws\.com/.test(connectionString)

export const pool = new Pool({
  connectionString,
  ssl: isRemote ? { rejectUnauthorized: false } : false,
})

// Test-only fault injection for the gate harness (scripts/gate-durability.mjs):
// when failNext > 0, the next N queries reject. Never set in production code.
export const _testFaults = { failNext: 0 }

export function query(text, params) {
  if (_testFaults.failNext > 0) {
    _testFaults.failNext--
    return Promise.reject(new Error('injected fault (gate harness)'))
  }
  return pool.query(text, params)
}

// Apply the schema on boot. Idempotent — safe to run every start.
export async function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  await pool.query(sql)
}
