import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { db, getSetting, setSetting, DEFAULTS, today } from './db.js'
import {
  ApiError,
  toMinor,
  fromMinor,
  listTaxRates,
  getProduct,
  productToJson,
  adjustStock,
  createInvoice,
  getInvoice,
  issueInvoice,
  voidInvoice,
  recordPayment,
  deletePayment,
  summaryReport,
  gstReport,
} from './core.js'
import type { ProductRow, InvoiceInput } from './core.js'
import { WEBHOOK_EVENTS, fireWebhook } from './webhooks.js'
import type { WebhookEvent } from './webhooks.js'
import { renderInvoiceHtml } from './invoiceHtml.js'

export const api = Router()

// ---------- auth ----------
// If any API key exists, every request must carry one (Authorization: Bearer
// fhr_… or X-API-Key). With no keys configured the API is open — meant for
// local/trusted use; create a key in Settings before exposing the server.

function hashKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

api.use((req: Request, res: Response, next: NextFunction) => {
  const keyCount = (db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n
  if (keyCount === 0) return next()
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined)
  if (!token) {
    res.status(401).json({ error: 'API key required (Authorization: Bearer <key>)' })
    return
  }
  const row = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hashKey(token)) as { id: number } | undefined
  if (!row) {
    res.status(401).json({ error: 'invalid API key' })
    return
  }
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id)
  next()
})

function idParam(req: Request): number {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'invalid id')
  return id
}

// ---------- products ----------

api.get('/products', (req, res) => {
  const q = String(req.query.q ?? '').trim()
  const lowStock = req.query.low_stock === 'true'
  const includeInactive = req.query.include_inactive === 'true'
  let sql = 'SELECT * FROM products WHERE 1=1'
  const params: unknown[] = []
  if (!includeInactive) sql += ' AND is_active = 1'
  if (q) {
    sql += ' AND (sku LIKE ? OR name LIKE ? OR category LIKE ? OR group_name LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like)
  }
  if (lowStock) sql += ' AND stock_qty <= low_stock_threshold'
  sql += ' ORDER BY name, variant_name'
  const rows = db.prepare(sql).all(...(params as string[])) as unknown as ProductRow[]
  res.json({ products: rows.map(productToJson) })
})

function productBody(req: Request) {
  const b = req.body ?? {}
  if (!b.sku || !String(b.sku).trim()) throw new ApiError(400, 'sku is required')
  if (!b.name || !String(b.name).trim()) throw new ApiError(400, 'name is required')
  return {
    sku: String(b.sku).trim(),
    name: String(b.name).trim(),
    group_name: b.group_name ? String(b.group_name) : null,
    variant_name: b.variant_name ? String(b.variant_name) : null,
    description: b.description ? String(b.description) : null,
    category: b.category ? String(b.category) : null,
    unit: b.unit ? String(b.unit) : 'pcs',
    cost_price: toMinor(b.cost_price ?? 0, 'cost_price'),
    sale_price: toMinor(b.sale_price ?? 0, 'sale_price'),
    tax_rate_id: b.tax_rate_id != null ? Number(b.tax_rate_id) : null,
    low_stock_threshold: b.low_stock_threshold != null ? Number(b.low_stock_threshold) : 5,
    is_active: b.is_active === false ? 0 : 1,
  }
}

api.post('/products', (req, res) => {
  const p = productBody(req)
  if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(p.sku)) {
    throw new ApiError(409, `SKU '${p.sku}' already exists`)
  }
  const r = db
    .prepare(
      `INSERT INTO products (sku, name, group_name, variant_name, description, category, unit, cost_price, sale_price,
        tax_rate_id, low_stock_threshold, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.sku, p.name, p.group_name, p.variant_name, p.description, p.category, p.unit,
      p.cost_price, p.sale_price, p.tax_rate_id, p.low_stock_threshold, p.is_active,
    )
  const id = Number(r.lastInsertRowid)
  const initialQty = Number(req.body?.stock_qty ?? 0)
  if (initialQty) adjustStock(id, initialQty, 'initial', null, 'Opening stock')
  res.status(201).json({ product: productToJson(getProduct(id)) })
})

api.get('/products/:id', (req, res) => {
  res.json({ product: productToJson(getProduct(idParam(req))) })
})

api.put('/products/:id', (req, res) => {
  const id = idParam(req)
  getProduct(id)
  const p = productBody(req)
  const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(p.sku, id)
  if (dup) throw new ApiError(409, `SKU '${p.sku}' already exists`)
  db.prepare(
    `UPDATE products SET sku=?, name=?, group_name=?, variant_name=?, description=?, category=?, unit=?, cost_price=?,
      sale_price=?, tax_rate_id=?, low_stock_threshold=?, is_active=?, updated_at=datetime('now') WHERE id=?`,
  ).run(
    p.sku, p.name, p.group_name, p.variant_name, p.description, p.category, p.unit,
    p.cost_price, p.sale_price, p.tax_rate_id, p.low_stock_threshold, p.is_active, id,
  )
  res.json({ product: productToJson(getProduct(id)) })
})

api.delete('/products/:id', (req, res) => {
  const id = idParam(req)
  getProduct(id)
  // soft delete — movements and invoice lines keep their history
  db.prepare("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id)
  res.json({ ok: true })
})

api.post('/products/:id/adjust-stock', (req, res) => {
  const id = idParam(req)
  const b = req.body ?? {}
  let delta: number
  if (b.set != null) {
    const target = Number(b.set)
    if (!Number.isFinite(target)) throw new ApiError(400, 'set must be a number')
    delta = target - getProduct(id).stock_qty
  } else {
    delta = Number(b.delta)
    if (!Number.isFinite(delta) || delta === 0) throw new ApiError(400, 'delta must be a non-zero number (or pass set)')
  }
  const reason = b.reason ? String(b.reason) : 'adjustment'
  const product = adjustStock(id, delta, reason, b.reference ?? null, b.note ?? null)
  res.json({ product: productToJson(product) })
})

api.get('/products/:id/movements', (req, res) => {
  const id = idParam(req)
  getProduct(id)
  const rows = db
    .prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 100')
    .all(id)
  res.json({ movements: rows })
})

// Flat stock levels — built for e-commerce stock sync.
api.get('/stock', (_req, res) => {
  const rows = db
    .prepare('SELECT sku, name, variant_name, stock_qty, low_stock_threshold FROM products WHERE is_active = 1 ORDER BY sku')
    .all() as unknown as { sku: string; name: string; variant_name: string | null; stock_qty: number; low_stock_threshold: number }[]
  res.json({
    stock: rows.map((r) => ({
      sku: r.sku,
      name: r.variant_name ? `${r.name} — ${r.variant_name}` : r.name,
      qty: r.stock_qty,
      low_stock: r.stock_qty <= r.low_stock_threshold,
    })),
  })
})

// ---------- customers ----------

api.get('/customers', (req, res) => {
  const q = String(req.query.q ?? '').trim()
  let sql = 'SELECT * FROM customers'
  const params: string[] = []
  if (q) {
    sql += ' WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?'
    const like = `%${q}%`
    params.push(like, like, like)
  }
  sql += ' ORDER BY name'
  res.json({ customers: db.prepare(sql).all(...params) })
})

function customerBody(req: Request) {
  const b = req.body ?? {}
  if (!b.name || !String(b.name).trim()) throw new ApiError(400, 'name is required')
  return {
    name: String(b.name).trim(),
    tin: b.tin ? String(b.tin) : null,
    phone: b.phone ? String(b.phone) : null,
    email: b.email ? String(b.email) : null,
    address: b.address ? String(b.address) : null,
    island: b.island ? String(b.island) : null,
  }
}

api.post('/customers', (req, res) => {
  const c = customerBody(req)
  const r = db
    .prepare('INSERT INTO customers (name, tin, phone, email, address, island) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.name, c.tin, c.phone, c.email, c.address, c.island)
  res.status(201).json({ customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid)) })
})

api.put('/customers/:id', (req, res) => {
  const id = idParam(req)
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new ApiError(404, `customer ${id} not found`)
  const c = customerBody(req)
  db.prepare(
    "UPDATE customers SET name=?, tin=?, phone=?, email=?, address=?, island=?, updated_at=datetime('now') WHERE id=?",
  ).run(c.name, c.tin, c.phone, c.email, c.address, c.island, id)
  res.json({ customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(id) })
})

api.delete('/customers/:id', (req, res) => {
  const id = idParam(req)
  const used = db.prepare('SELECT 1 FROM invoices WHERE customer_id = ? LIMIT 1').get(id)
  if (used) throw new ApiError(400, 'customer has invoices and cannot be deleted')
  const r = db.prepare('DELETE FROM customers WHERE id = ?').run(id)
  if (r.changes === 0) throw new ApiError(404, `customer ${id} not found`)
  res.json({ ok: true })
})

// ---------- tax rates ----------

api.get('/tax-rates', (_req, res) => {
  res.json({ tax_rates: listTaxRates() })
})

api.post('/tax-rates', (req, res) => {
  const b = req.body ?? {}
  if (!b.code || !b.label || b.rate_percent == null) throw new ApiError(400, 'code, label and rate_percent are required')
  const rate = Number(b.rate_percent)
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new ApiError(400, 'rate_percent must be 0–100')
  if (db.prepare('SELECT 1 FROM tax_rates WHERE code = ?').get(String(b.code))) {
    throw new ApiError(409, `tax code '${b.code}' already exists`)
  }
  db.prepare('INSERT INTO tax_rates (code, label, rate_percent, is_default) VALUES (?, ?, ?, 0)').run(
    String(b.code).toUpperCase(), String(b.label), rate,
  )
  res.status(201).json({ tax_rates: listTaxRates() })
})

api.put('/tax-rates/:id', (req, res) => {
  const id = idParam(req)
  const b = req.body ?? {}
  const existing = db.prepare('SELECT * FROM tax_rates WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!existing) throw new ApiError(404, `tax rate ${id} not found`)
  const rate = b.rate_percent != null ? Number(b.rate_percent) : (existing.rate_percent as number)
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new ApiError(400, 'rate_percent must be 0–100')
  db.prepare('UPDATE tax_rates SET label = ?, rate_percent = ?, is_active = ? WHERE id = ?').run(
    b.label != null ? String(b.label) : (existing.label as string),
    rate,
    b.is_active === false ? 0 : 1,
    id,
  )
  if (b.is_default === true) {
    db.prepare('UPDATE tax_rates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id)
  }
  res.json({ tax_rates: listTaxRates() })
})

// ---------- invoices ----------

api.get('/invoices', (req, res) => {
  const status = String(req.query.status ?? '').trim()
  const q = String(req.query.q ?? '').trim()
  let sql = 'SELECT * FROM invoices WHERE 1=1'
  const params: string[] = []
  if (status) {
    sql += ' AND status = ?'
    params.push(status)
  }
  if (q) {
    sql += ' AND (number LIKE ? OR customer_name LIKE ? OR external_ref LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like)
  }
  sql += ' ORDER BY id DESC LIMIT 500'
  const rows = db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]
  res.json({
    invoices: rows.map((r) => ({
      ...r,
      subtotal: fromMinor(r.subtotal as number),
      gst_total: fromMinor(r.gst_total as number),
      total: fromMinor(r.total as number),
      amount_paid: fromMinor(r.amount_paid as number),
      balance_due: fromMinor((r.total as number) - (r.amount_paid as number)),
      overdue:
        (r.total as number) > (r.amount_paid as number) &&
        r.status !== 'void' && r.status !== 'draft' &&
        !!r.due_date && (r.due_date as string) < today(),
    })),
  })
})

api.post('/invoices', (req, res) => {
  const invoice = createInvoice((req.body ?? {}) as InvoiceInput)
  res.status(201).json({ invoice })
})

api.get('/invoices/:id', (req, res) => {
  res.json({ invoice: getInvoice(idParam(req)) })
})

api.get('/invoices/:id/html', (req, res) => {
  const invoice = getInvoice(idParam(req))
  res.type('html').send(renderInvoiceHtml(invoice))
})

api.post('/invoices/:id/issue', (req, res) => {
  res.json({ invoice: issueInvoice(idParam(req)) })
})

api.post('/invoices/:id/void', (req, res) => {
  res.json({ invoice: voidInvoice(idParam(req)) })
})

api.post('/invoices/:id/payments', (req, res) => {
  res.status(201).json({ invoice: recordPayment(idParam(req), req.body ?? {}) })
})

api.delete('/invoices/:id/payments/:paymentId', (req, res) => {
  const paymentId = Number(req.params.paymentId)
  if (!Number.isInteger(paymentId) || paymentId <= 0) throw new ApiError(400, 'invalid payment id')
  res.json({ invoice: deletePayment(idParam(req), paymentId) })
})

// ---------- orders (e-commerce intake) ----------
// Idempotent on external_ref: replaying the same order returns the existing
// invoice instead of double-billing or double-decrementing stock.

api.post('/orders', (req, res) => {
  const b = req.body ?? {}
  if (!b.external_ref || !String(b.external_ref).trim()) {
    throw new ApiError(400, 'external_ref is required (your platform\'s order id) — it makes order intake idempotent')
  }
  const invoice = createInvoice({
    external_ref: String(b.external_ref).trim(),
    source: b.source ? String(b.source) : 'api',
    customer: b.customer,
    customer_id: b.customer_id,
    currency: b.currency,
    notes: b.notes,
    lines: b.lines,
    status: 'issued',
  })
  if (!invoice.idempotent && b.payment && typeof b.payment === 'object') {
    const paid = recordPayment(invoice.id as number, {
      method: b.payment.method,
      amount: b.payment.amount ?? (invoice.total as number),
      reference: b.payment.reference,
      note: b.payment.note,
    })
    res.status(201).json({ invoice: paid })
    return
  }
  res.status(invoice.idempotent ? 200 : 201).json({ invoice })
})

// ---------- settings ----------

api.get('/settings', (_req, res) => {
  res.json({
    business: getSetting('business', DEFAULTS.business),
    currency: getSetting('currency', DEFAULTS.currency),
    invoice: getSetting('invoice', DEFAULTS.invoice),
    payment_methods: getSetting('payment_methods', DEFAULTS.payment_methods),
    webhook_events: WEBHOOK_EVENTS,
  })
})

api.put('/settings', (req, res) => {
  const b = req.body ?? {}
  if (b.business) setSetting('business', { ...getSetting('business', DEFAULTS.business), ...b.business })
  if (b.currency) {
    const rate = Number(b.currency.usd_rate)
    if (!Number.isFinite(rate) || rate <= 0) throw new ApiError(400, 'currency.usd_rate must be a positive number')
    setSetting('currency', { base: 'MVR', usd_rate: rate })
  }
  if (b.invoice) {
    const merged = { ...getSetting('invoice', DEFAULTS.invoice), ...b.invoice }
    merged.next_number = Math.max(1, Number(merged.next_number) || 1)
    merged.due_days = Math.max(0, Number(merged.due_days) || 0)
    setSetting('invoice', merged)
  }
  if (Array.isArray(b.payment_methods)) {
    const methods = b.payment_methods.map((m: unknown) => String(m).trim()).filter(Boolean)
    if (methods.length === 0) throw new ApiError(400, 'payment_methods cannot be empty')
    setSetting('payment_methods', methods)
  }
  res.json({
    business: getSetting('business', DEFAULTS.business),
    currency: getSetting('currency', DEFAULTS.currency),
    invoice: getSetting('invoice', DEFAULTS.invoice),
    payment_methods: getSetting('payment_methods', DEFAULTS.payment_methods),
  })
})

// ---------- API keys ----------

api.get('/api-keys', (_req, res) => {
  res.json({ api_keys: db.prepare('SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY id').all() })
})

api.post('/api-keys', (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) throw new ApiError(400, 'name is required')
  const token = `fhr_${randomBytes(24).toString('hex')}`
  db.prepare('INSERT INTO api_keys (name, key_prefix, key_hash) VALUES (?, ?, ?)').run(
    name, token.slice(0, 12), hashKey(token),
  )
  // the plaintext key is returned exactly once
  res.status(201).json({ name, key: token })
})

api.delete('/api-keys/:id', (req, res) => {
  const r = db.prepare('DELETE FROM api_keys WHERE id = ?').run(idParam(req))
  if (r.changes === 0) throw new ApiError(404, 'API key not found')
  res.json({ ok: true })
})

// ---------- webhooks ----------

api.get('/webhooks', (_req, res) => {
  const hooks = db.prepare('SELECT id, url, events, is_active, created_at FROM webhooks ORDER BY id').all() as unknown as Record<string, unknown>[]
  res.json({ webhooks: hooks.map((h) => ({ ...h, events: JSON.parse(h.events as string), is_active: !!h.is_active })) })
})

api.post('/webhooks', (req, res) => {
  const b = req.body ?? {}
  const url = String(b.url ?? '').trim()
  if (!/^https?:\/\//.test(url)) throw new ApiError(400, 'url must be an http(s) URL')
  const events: string[] = Array.isArray(b.events) ? b.events.map(String) : ['*']
  const invalid = events.filter((e) => e !== '*' && !(WEBHOOK_EVENTS as readonly string[]).includes(e))
  if (invalid.length) throw new ApiError(400, `unknown events: ${invalid.join(', ')} (valid: ${WEBHOOK_EVENTS.join(', ')}, or *)`)
  const secret = String(b.secret ?? '') || randomBytes(16).toString('hex')
  const r = db.prepare('INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)').run(url, secret, JSON.stringify(events))
  res.status(201).json({ id: Number(r.lastInsertRowid), url, events, secret })
})

api.delete('/webhooks/:id', (req, res) => {
  const r = db.prepare('DELETE FROM webhooks WHERE id = ?').run(idParam(req))
  if (r.changes === 0) throw new ApiError(404, 'webhook not found')
  res.json({ ok: true })
})

api.post('/webhooks/:id/test', (req, res) => {
  const id = idParam(req)
  const hook = db.prepare('SELECT id FROM webhooks WHERE id = ?').get(id)
  if (!hook) throw new ApiError(404, 'webhook not found')
  fireWebhook('stock.updated' as WebhookEvent, { test: true, message: 'Fihaara webhook test delivery' })
  res.json({ ok: true, note: 'test event dispatched (stock.updated); check /webhooks/:id/deliveries' })
})

api.get('/webhooks/:id/deliveries', (req, res) => {
  const rows = db
    .prepare('SELECT id, event, status_code, ok, error, attempted_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 20')
    .all(idParam(req))
  res.json({ deliveries: rows })
})

// ---------- reports ----------

api.get('/reports/summary', (_req, res) => {
  res.json(summaryReport())
})

api.get('/reports/gst', (req, res) => {
  const from = String(req.query.from ?? '').trim() || today().slice(0, 8) + '01'
  const to = String(req.query.to ?? '').trim() || today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new ApiError(400, 'from and to must be YYYY-MM-DD')
  }
  res.json(gstReport(from, to))
})
