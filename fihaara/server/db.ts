import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DB_PATH = resolve(process.env.FIHAARA_DB ?? 'data/fihaara.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  rate_percent REAL NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_name TEXT,
  variant_name TEXT,
  description TEXT,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  cost_price INTEGER NOT NULL DEFAULT 0,
  sale_price INTEGER NOT NULL DEFAULT 0,
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  stock_qty REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL NOT NULL DEFAULT 5,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta REAL NOT NULL,
  qty_after REAL NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, id DESC);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tin TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  island TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT,
  customer_tin TEXT,
  customer_address TEXT,
  customer_phone TEXT,
  currency TEXT NOT NULL DEFAULT 'MVR',
  usd_rate REAL NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  gst_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  external_ref TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  sku TEXT,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  tax_code TEXT,
  tax_rate_percent REAL NOT NULL DEFAULT 0,
  line_subtotal INTEGER NOT NULL,
  line_gst INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  method TEXT NOT NULL,
  reference TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// ---------- settings helpers ----------

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value))
}

export interface BusinessSettings {
  name: string
  address: string
  island: string
  phone: string
  email: string
  tin: string
  gst_tin: string
  gst_registered: boolean
}

export interface CurrencySettings {
  base: 'MVR'
  usd_rate: number
}

export interface InvoiceSettings {
  prefix: string
  next_number: number
  due_days: number
  footer_note: string
}

export const DEFAULTS = {
  business: {
    name: 'My Business',
    address: '',
    island: "Male'",
    phone: '',
    email: '',
    tin: '',
    gst_tin: '',
    gst_registered: true,
  } as BusinessSettings,
  currency: { base: 'MVR', usd_rate: 15.42 } as CurrencySettings,
  invoice: { prefix: 'INV', next_number: 1, due_days: 14, footer_note: 'Thank you for your business!' } as InvoiceSettings,
  payment_methods: ['Cash', 'Card', 'BML Transfer', 'Favara', 'm-Faisaa', 'Cheque', 'Other'] as string[],
}

// ---------- seed ----------

function seed(): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM tax_rates').get() as { n: number }).n
  if (count === 0) {
    // Maldives GST rates. Rates change by law (Goods and Services Tax Act amendments) —
    // they are stored as data, editable from Settings, never hardcoded in calculations.
    const ins = db.prepare('INSERT INTO tax_rates (code, label, rate_percent, is_default) VALUES (?, ?, ?, ?)')
    ins.run('GST', 'GST 8% (general sector)', 8, 1)
    ins.run('TGST', 'TGST 17% (tourism sector)', 17, 0)
    ins.run('ZERO', 'Zero-rated (0%)', 0, 0)
    ins.run('EXEMPT', 'Exempt supply', 0, 0)
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) setSetting(key, value)
  }
}

seed()

export function nowIso(): string {
  return new Date().toISOString()
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
