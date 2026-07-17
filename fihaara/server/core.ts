import { db, getSetting, setSetting, DEFAULTS, today } from './db.js'
import type { InvoiceSettings, CurrencySettings } from './db.js'
import { fireWebhook } from './webhooks.js'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Amounts are stored as integer minor units (laari / cents).
export function toMinor(value: unknown, field: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new ApiError(400, `${field} must be a number`)
  return Math.round(n * 100)
}

export function fromMinor(minor: number): number {
  return minor / 100
}

// ---------- tax rates ----------

export interface TaxRate {
  id: number
  code: string
  label: string
  rate_percent: number
  is_default: number
  is_active: number
}

export function listTaxRates(): TaxRate[] {
  return db.prepare('SELECT * FROM tax_rates ORDER BY rate_percent DESC').all() as unknown as TaxRate[]
}

export function defaultTaxRate(): TaxRate | undefined {
  return db.prepare('SELECT * FROM tax_rates WHERE is_default = 1 AND is_active = 1').get() as TaxRate | undefined
}

// ---------- products ----------

export interface ProductRow {
  id: number
  sku: string
  name: string
  group_name: string | null
  variant_name: string | null
  description: string | null
  category: string | null
  unit: string
  cost_price: number
  sale_price: number
  tax_rate_id: number | null
  stock_qty: number
  low_stock_threshold: number
  is_active: number
  created_at: string
  updated_at: string
}

export function productToJson(p: ProductRow) {
  return {
    ...p,
    cost_price: fromMinor(p.cost_price),
    sale_price: fromMinor(p.sale_price),
    is_active: !!p.is_active,
    low_stock: p.stock_qty <= p.low_stock_threshold,
  }
}

export function getProduct(id: number): ProductRow {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
  if (!p) throw new ApiError(404, `product ${id} not found`)
  return p
}

export function getProductBySku(sku: string): ProductRow | undefined {
  return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as ProductRow | undefined
}

export function adjustStock(
  productId: number,
  delta: number,
  reason: string,
  reference?: string | null,
  note?: string | null,
): ProductRow {
  if (!Number.isFinite(delta)) throw new ApiError(400, 'delta must be a number')
  const p = getProduct(productId)
  const after = Math.round((p.stock_qty + delta) * 1000) / 1000
  db.prepare("UPDATE products SET stock_qty = ?, updated_at = datetime('now') WHERE id = ?").run(after, productId)
  db.prepare(
    'INSERT INTO stock_movements (product_id, delta, qty_after, reason, reference, note) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(productId, delta, after, reason, reference ?? null, note ?? null)
  const updated = getProduct(productId)
  fireWebhook('stock.updated', { product: productToJson(updated), delta, reason, reference: reference ?? null })
  if (delta < 0 && after <= p.low_stock_threshold) {
    fireWebhook('stock.low', { product: productToJson(updated) })
  }
  return updated
}

// ---------- invoices ----------

export interface InvoiceLineInput {
  product_id?: number
  sku?: string
  description?: string
  qty: number
  unit_price?: number // decimal, in invoice currency
  tax_code?: string
}

export interface InvoiceInput {
  customer_id?: number
  customer?: { name: string; tin?: string; phone?: string; email?: string; address?: string; island?: string }
  currency?: 'MVR' | 'USD'
  issue_date?: string
  due_date?: string
  notes?: string
  status?: 'draft' | 'issued'
  external_ref?: string
  source?: string
  lines: InvoiceLineInput[]
}

interface ResolvedLine {
  product_id: number | null
  sku: string | null
  description: string
  qty: number
  unit_price: number
  tax_code: string | null
  tax_rate_percent: number
  line_subtotal: number
  line_gst: number
  line_total: number
}

function resolveLines(lines: InvoiceLineInput[], currency: string, usdRate: number): ResolvedLine[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new ApiError(400, 'lines must be a non-empty array')
  const rates = listTaxRates()
  const fallbackRate = defaultTaxRate()
  return lines.map((line, i) => {
    const qty = Number(line.qty)
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, `lines[${i}].qty must be a positive number`)
    let product: ProductRow | undefined
    if (line.product_id != null) product = getProduct(Number(line.product_id))
    else if (line.sku) {
      product = getProductBySku(line.sku)
      if (!product) throw new ApiError(400, `lines[${i}]: no product with SKU '${line.sku}'`)
    }
    let unitPrice: number
    if (line.unit_price != null) {
      unitPrice = toMinor(line.unit_price, `lines[${i}].unit_price`)
    } else if (product) {
      // product prices are stored in MVR; convert if invoicing in USD
      unitPrice = currency === 'USD' ? Math.round(product.sale_price / usdRate) : product.sale_price
    } else {
      throw new ApiError(400, `lines[${i}] needs unit_price or a product reference`)
    }
    let taxCode: string | null = null
    let taxPercent = 0
    if (line.tax_code) {
      const rate = rates.find((r) => r.code === line.tax_code)
      if (!rate) throw new ApiError(400, `lines[${i}]: unknown tax_code '${line.tax_code}'`)
      taxCode = rate.code
      taxPercent = rate.rate_percent
    } else if (product?.tax_rate_id) {
      const rate = rates.find((r) => r.id === product!.tax_rate_id)
      if (rate) {
        taxCode = rate.code
        taxPercent = rate.rate_percent
      }
    } else if (fallbackRate) {
      taxCode = fallbackRate.code
      taxPercent = fallbackRate.rate_percent
    }
    const description =
      line.description ??
      (product ? (product.variant_name ? `${product.name} — ${product.variant_name}` : product.name) : null) ??
      ''
    if (!description) throw new ApiError(400, `lines[${i}] needs a description`)
    const lineSubtotal = Math.round(qty * unitPrice)
    const lineGst = Math.round((lineSubtotal * taxPercent) / 100)
    return {
      product_id: product?.id ?? null,
      sku: product?.sku ?? line.sku ?? null,
      description,
      qty,
      unit_price: unitPrice,
      tax_code: taxCode,
      tax_rate_percent: taxPercent,
      line_subtotal: lineSubtotal,
      line_gst: lineGst,
      line_total: lineSubtotal + lineGst,
    }
  })
}

function nextInvoiceNumber(): string {
  const cfg = getSetting<InvoiceSettings>('invoice', DEFAULTS.invoice)
  const year = new Date().getFullYear()
  const number = `${cfg.prefix}-${year}-${String(cfg.next_number).padStart(4, '0')}`
  setSetting('invoice', { ...cfg, next_number: cfg.next_number + 1 })
  return number
}

export function createInvoice(input: InvoiceInput): Record<string, unknown> {
  const currencyCfg = getSetting<CurrencySettings>('currency', DEFAULTS.currency)
  const invoiceCfg = getSetting<InvoiceSettings>('invoice', DEFAULTS.invoice)
  const currency = input.currency === 'USD' ? 'USD' : 'MVR'
  const status = input.status === 'draft' ? 'draft' : 'issued'

  if (input.external_ref) {
    const existing = db.prepare('SELECT id FROM invoices WHERE external_ref = ?').get(input.external_ref) as
      | { id: number }
      | undefined
    if (existing) return { ...getInvoice(existing.id), idempotent: true }
  }

  let customerId: number | null = null
  let snapshot = { name: null as string | null, tin: null as string | null, address: null as string | null, phone: null as string | null }
  if (input.customer_id != null) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(input.customer_id)) as
      | Record<string, string | number | null>
      | undefined
    if (!c) throw new ApiError(400, `customer ${input.customer_id} not found`)
    customerId = c.id as number
    snapshot = {
      name: (c.name as string) ?? null,
      tin: (c.tin as string) ?? null,
      address: [c.address, c.island].filter(Boolean).join(', ') || null,
      phone: (c.phone as string) ?? null,
    }
  } else if (input.customer?.name) {
    // find-or-create by name+phone so repeat e-commerce buyers don't duplicate
    const found = db
      .prepare('SELECT id FROM customers WHERE name = ? AND ifnull(phone, \'\') = ifnull(?, \'\')')
      .get(input.customer.name, input.customer.phone ?? null) as { id: number } | undefined
    if (found) customerId = found.id
    else {
      const r = db
        .prepare('INSERT INTO customers (name, tin, phone, email, address, island) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          input.customer.name,
          input.customer.tin ?? null,
          input.customer.phone ?? null,
          input.customer.email ?? null,
          input.customer.address ?? null,
          input.customer.island ?? null,
        )
      customerId = Number(r.lastInsertRowid)
    }
    snapshot = {
      name: input.customer.name,
      tin: input.customer.tin ?? null,
      address: [input.customer.address, input.customer.island].filter(Boolean).join(', ') || null,
      phone: input.customer.phone ?? null,
    }
  }

  const lines = resolveLines(input.lines, currency, currencyCfg.usd_rate)
  const subtotal = lines.reduce((s, l) => s + l.line_subtotal, 0)
  const gstTotal = lines.reduce((s, l) => s + l.line_gst, 0)
  const total = subtotal + gstTotal
  const issueDate = input.issue_date ?? today()
  const dueDate =
    input.due_date ??
    new Date(new Date(issueDate).getTime() + invoiceCfg.due_days * 86400_000).toISOString().slice(0, 10)

  const number = nextInvoiceNumber()
  const result = db
    .prepare(
      `INSERT INTO invoices (number, status, customer_id, customer_name, customer_tin, customer_address, customer_phone,
        currency, usd_rate, issue_date, due_date, subtotal, gst_total, total, notes, external_ref, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      number,
      status,
      customerId,
      snapshot.name,
      snapshot.tin,
      snapshot.address,
      snapshot.phone,
      currency,
      currencyCfg.usd_rate,
      issueDate,
      dueDate,
      subtotal,
      gstTotal,
      total,
      input.notes ?? null,
      input.external_ref ?? null,
      input.source ?? 'manual',
    )
  const invoiceId = Number(result.lastInsertRowid)

  const insLine = db.prepare(
    `INSERT INTO invoice_lines (invoice_id, product_id, sku, description, qty, unit_price, tax_code, tax_rate_percent,
      line_subtotal, line_gst, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const l of lines) {
    insLine.run(
      invoiceId, l.product_id, l.sku, l.description, l.qty, l.unit_price,
      l.tax_code, l.tax_rate_percent, l.line_subtotal, l.line_gst, l.line_total,
    )
  }

  if (status === 'issued') decrementStockForInvoice(invoiceId, number)

  const invoice = getInvoice(invoiceId)
  fireWebhook('invoice.created', { invoice })
  return invoice
}

function decrementStockForInvoice(invoiceId: number, number: string): void {
  const lines = db
    .prepare('SELECT product_id, qty FROM invoice_lines WHERE invoice_id = ? AND product_id IS NOT NULL')
    .all(invoiceId) as unknown as { product_id: number; qty: number }[]
  for (const l of lines) adjustStock(l.product_id, -l.qty, 'sale', number)
}

export function issueInvoice(id: number): Record<string, unknown> {
  const inv = rawInvoice(id)
  if (inv.status !== 'draft') throw new ApiError(400, `invoice is ${inv.status}, only drafts can be issued`)
  db.prepare("UPDATE invoices SET status = 'issued', updated_at = datetime('now') WHERE id = ?").run(id)
  decrementStockForInvoice(id, inv.number as string)
  return getInvoice(id)
}

export function voidInvoice(id: number): Record<string, unknown> {
  const inv = rawInvoice(id)
  if (inv.status === 'void') throw new ApiError(400, 'invoice is already void')
  if ((inv.amount_paid as number) > 0) throw new ApiError(400, 'cannot void an invoice with recorded payments — delete the payments first')
  const restock = inv.status !== 'draft'
  db.prepare("UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?").run(id)
  if (restock) {
    const lines = db
      .prepare('SELECT product_id, qty FROM invoice_lines WHERE invoice_id = ? AND product_id IS NOT NULL')
      .all(id) as unknown as { product_id: number; qty: number }[]
    for (const l of lines) adjustStock(l.product_id, l.qty, 'void_restock', inv.number as string)
  }
  const invoice = getInvoice(id)
  fireWebhook('invoice.voided', { invoice })
  return invoice
}

interface RawInvoice {
  [key: string]: unknown
  id: number
  number: string
  status: string
  currency: string
  usd_rate: number
  subtotal: number
  gst_total: number
  total: number
  amount_paid: number
}

function rawInvoice(id: number): RawInvoice {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as RawInvoice | undefined
  if (!inv) throw new ApiError(404, `invoice ${id} not found`)
  return inv
}

export function getInvoice(id: number): Record<string, unknown> {
  const inv = rawInvoice(id)
  const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(id) as unknown as Record<
    string,
    unknown
  >[]
  const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at, id').all(id) as unknown as Record<
    string,
    unknown
  >[]
  return {
    ...inv,
    subtotal: fromMinor(inv.subtotal),
    gst_total: fromMinor(inv.gst_total),
    total: fromMinor(inv.total),
    amount_paid: fromMinor(inv.amount_paid),
    balance_due: fromMinor(inv.total - inv.amount_paid),
    lines: lines.map((l) => ({
      ...l,
      unit_price: fromMinor(l.unit_price as number),
      line_subtotal: fromMinor(l.line_subtotal as number),
      line_gst: fromMinor(l.line_gst as number),
      line_total: fromMinor(l.line_total as number),
    })),
    payments: payments.map((p) => ({ ...p, amount: fromMinor(p.amount as number) })),
  }
}

export function recordPayment(
  invoiceId: number,
  input: { method?: string; amount: number; reference?: string; paid_at?: string; note?: string },
): Record<string, unknown> {
  const inv = rawInvoice(invoiceId)
  if (inv.status === 'void') throw new ApiError(400, 'cannot record a payment on a void invoice')
  if (inv.status === 'draft') throw new ApiError(400, 'issue the invoice before recording payments')
  const methods = getSetting<string[]>('payment_methods', DEFAULTS.payment_methods)
  const method = input.method ?? methods[0] ?? 'Cash'
  const amount = toMinor(input.amount, 'amount')
  if (amount <= 0) throw new ApiError(400, 'amount must be positive')
  db.prepare(
    'INSERT INTO payments (invoice_id, method, reference, amount, currency, paid_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(invoiceId, method, input.reference ?? null, amount, inv.currency, input.paid_at ?? today(), input.note ?? null)
  refreshPaymentStatus(invoiceId)
  const invoice = getInvoice(invoiceId)
  if (invoice.status === 'paid') fireWebhook('invoice.paid', { invoice })
  return invoice
}

export function deletePayment(invoiceId: number, paymentId: number): Record<string, unknown> {
  const r = db.prepare('DELETE FROM payments WHERE id = ? AND invoice_id = ?').run(paymentId, invoiceId)
  if (r.changes === 0) throw new ApiError(404, `payment ${paymentId} not found on invoice ${invoiceId}`)
  refreshPaymentStatus(invoiceId)
  return getInvoice(invoiceId)
}

function refreshPaymentStatus(invoiceId: number): void {
  const inv = rawInvoice(invoiceId)
  const paid = (
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ?').get(invoiceId) as { s: number }
  ).s
  let status = inv.status
  if (inv.status !== 'void' && inv.status !== 'draft') {
    status = paid >= inv.total ? 'paid' : paid > 0 ? 'partially_paid' : 'issued'
  }
  db.prepare("UPDATE invoices SET amount_paid = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(
    paid, status, invoiceId,
  )
}

// ---------- reports ----------

function mvrMinor(amountMinor: number, currency: string, usdRate: number): number {
  return currency === 'USD' ? Math.round(amountMinor * usdRate) : amountMinor
}

export function summaryReport(): Record<string, unknown> {
  const monthStart = today().slice(0, 8) + '01'
  const invoices = db
    .prepare("SELECT currency, usd_rate, total, amount_paid, status, issue_date, due_date FROM invoices WHERE status != 'void'")
    .all() as unknown as {
    currency: string
    usd_rate: number
    total: number
    amount_paid: number
    status: string
    issue_date: string
    due_date: string | null
  }[]
  let outstanding = 0
  let revenueMonth = 0
  let overdueCount = 0
  for (const inv of invoices) {
    if (inv.status === 'draft') continue
    outstanding += mvrMinor(inv.total - inv.amount_paid, inv.currency, inv.usd_rate)
    if (inv.issue_date >= monthStart) revenueMonth += mvrMinor(inv.total, inv.currency, inv.usd_rate)
    if (inv.total > inv.amount_paid && inv.due_date && inv.due_date < today()) overdueCount++
  }
  const stock = db
    .prepare('SELECT COALESCE(SUM(stock_qty * cost_price), 0) AS value, COUNT(*) AS products FROM products WHERE is_active = 1')
    .get() as { value: number; products: number }
  const lowStock = db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND stock_qty <= low_stock_threshold')
    .get() as { n: number }
  return {
    revenue_this_month_mvr: fromMinor(revenueMonth),
    outstanding_mvr: fromMinor(outstanding),
    overdue_invoices: overdueCount,
    inventory_value_mvr: fromMinor(Math.round(stock.value)),
    active_products: stock.products,
    low_stock_products: lowStock.n,
  }
}

export function gstReport(from: string, to: string): Record<string, unknown> {
  // GST collected by tax code over a period — the numbers needed for a MIRA GST return.
  const rows = db
    .prepare(
      `SELECT l.tax_code, l.tax_rate_percent, i.currency, i.usd_rate,
              SUM(l.line_subtotal) AS taxable, SUM(l.line_gst) AS gst
       FROM invoice_lines l
       JOIN invoices i ON i.id = l.invoice_id
       WHERE i.status IN ('issued', 'partially_paid', 'paid')
         AND i.issue_date >= ? AND i.issue_date <= ?
       GROUP BY l.tax_code, l.tax_rate_percent, i.currency, i.usd_rate`,
    )
    .all(from, to) as unknown as {
    tax_code: string | null
    tax_rate_percent: number
    currency: string
    usd_rate: number
    taxable: number
    gst: number
  }[]
  const byCode = new Map<string, { tax_code: string; rate_percent: number; taxable_mvr: number; gst_mvr: number }>()
  for (const r of rows) {
    const key = `${r.tax_code ?? 'NONE'}@${r.tax_rate_percent}`
    const entry = byCode.get(key) ?? {
      tax_code: r.tax_code ?? 'NONE',
      rate_percent: r.tax_rate_percent,
      taxable_mvr: 0,
      gst_mvr: 0,
    }
    entry.taxable_mvr += mvrMinor(r.taxable, r.currency, r.usd_rate)
    entry.gst_mvr += mvrMinor(r.gst, r.currency, r.usd_rate)
    byCode.set(key, entry)
  }
  const breakdown = [...byCode.values()]
    .map((e) => ({ ...e, taxable_mvr: fromMinor(e.taxable_mvr), gst_mvr: fromMinor(e.gst_mvr) }))
    .sort((a, b) => b.rate_percent - a.rate_percent)
  return {
    from,
    to,
    breakdown,
    total_gst_mvr: breakdown.reduce((s, e) => s + e.gst_mvr, 0),
    total_taxable_mvr: breakdown.reduce((s, e) => s + e.taxable_mvr, 0),
  }
}
