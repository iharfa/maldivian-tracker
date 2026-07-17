import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2, Plus } from 'lucide-react'
import { apiFetch } from '../api'
import { fmtMoney } from '../format'
import { Field, ErrorNote } from '../ui'

interface Product {
  id: number
  sku: string
  name: string
  variant_name: string | null
  sale_price: number
  stock_qty: number
  unit: string
  tax_rate_id: number | null
}

interface TaxRate { id: number; code: string; label: string; rate_percent: number; is_default: number }
interface Customer { id: number; name: string; phone: string | null }

interface Line {
  product_id: number | null
  description: string
  qty: string
  unit_price: string
  tax_code: string
}

export default function NewInvoice() {
  const navigate = useNavigate()
  const [products, setProducts] = useState<Product[]>([])
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [usdRate, setUsdRate] = useState(15.42)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [customerId, setCustomerId] = useState('')
  const [newCustomer, setNewCustomer] = useState({ name: '', phone: '', tin: '', address: '' })
  const [currency, setCurrency] = useState<'MVR' | 'USD'>('MVR')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [picker, setPicker] = useState('')

  useEffect(() => {
    apiFetch<{ products: Product[] }>('/products').then((r) => setProducts(r.products)).catch((e) => setError(e.message))
    apiFetch<{ tax_rates: TaxRate[] }>('/tax-rates').then((r) => setTaxRates(r.tax_rates)).catch(() => {})
    apiFetch<{ customers: Customer[] }>('/customers').then((r) => setCustomers(r.customers)).catch(() => {})
    apiFetch<{ currency: { usd_rate: number } }>('/settings').then((r) => setUsdRate(r.currency.usd_rate)).catch(() => {})
  }, [])

  const defaultTax = taxRates.find((t) => t.is_default)?.code ?? ''

  function addProductLine(p: Product) {
    const price = currency === 'USD' ? p.sale_price / usdRate : p.sale_price
    const rate = taxRates.find((t) => t.id === p.tax_rate_id)
    setLines((ls) => [
      ...ls,
      {
        product_id: p.id,
        description: p.variant_name ? `${p.name} — ${p.variant_name}` : p.name,
        qty: '1',
        unit_price: price.toFixed(2),
        tax_code: rate?.code ?? defaultTax,
      },
    ])
    setPicker('')
  }

  function addCustomLine() {
    setLines((ls) => [...ls, { product_id: null, description: '', qty: '1', unit_price: '0.00', tax_code: defaultTax }])
  }

  const totals = useMemo(() => {
    let subtotal = 0
    let gst = 0
    for (const l of lines) {
      const lineSub = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
      const rate = taxRates.find((t) => t.code === l.tax_code)?.rate_percent ?? 0
      subtotal += lineSub
      gst += (lineSub * rate) / 100
    }
    return { subtotal, gst, total: subtotal + gst }
  }, [lines, taxRates])

  const filtered = picker.trim()
    ? products.filter(
        (p) =>
          p.sku.toLowerCase().includes(picker.toLowerCase()) ||
          p.name.toLowerCase().includes(picker.toLowerCase()) ||
          (p.variant_name ?? '').toLowerCase().includes(picker.toLowerCase()),
      ).slice(0, 8)
    : []

  async function save(status: 'draft' | 'issued') {
    setError(null)
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        currency,
        status,
        notes: notes || undefined,
        lines: lines.map((l) => ({
          product_id: l.product_id ?? undefined,
          description: l.description,
          qty: Number(l.qty),
          unit_price: Number(l.unit_price),
          tax_code: l.tax_code || undefined,
        })),
      }
      if (customerId === 'new') {
        if (!newCustomer.name.trim()) throw new Error('customer name is required')
        body.customer = {
          name: newCustomer.name, phone: newCustomer.phone || undefined,
          tin: newCustomer.tin || undefined, address: newCustomer.address || undefined,
        }
      } else if (customerId) {
        body.customer_id = Number(customerId)
      }
      const r = await apiFetch<{ invoice: { id: number } }>('/invoices', { method: 'POST', body })
      navigate(`/invoices/${r.invoice.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>New invoice</h1>
      </div>
      <ErrorNote error={error} />
      <div className="panel" style={{ padding: 20 }}>
        <div className="form-grid">
          <Field label="Customer">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Walk-in customer</option>
              <option value="new">+ New customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency" hint={currency === 'USD' ? `converted at 1 USD = ${usdRate} MVR` : undefined}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as 'MVR' | 'USD')}>
              <option value="MVR">MVR — Rufiyaa</option>
              <option value="USD">USD — US Dollar</option>
            </select>
          </Field>
        </div>
        {customerId === 'new' && (
          <div className="form-grid">
            <Field label="Name *"><input value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} /></Field>
            <Field label="Phone"><input value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} /></Field>
            <Field label="TIN" hint="required on the tax invoice if the customer is GST-registered"><input value={newCustomer.tin} onChange={(e) => setNewCustomer({ ...newCustomer, tin: e.target.value })} /></Field>
            <Field label="Address"><input value={newCustomer.address} onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })} /></Field>
          </div>
        )}

        <div className="line-picker">
          <input
            className="search"
            placeholder="Type to add a product by SKU or name…"
            value={picker}
            onChange={(e) => setPicker(e.target.value)}
          />
          {filtered.length > 0 && (
            <div className="picker-results">
              {filtered.map((p) => (
                <button key={p.id} className="picker-item" onClick={() => addProductLine(p)}>
                  <span className="mono">{p.sku}</span> {p.name}{p.variant_name ? ` — ${p.variant_name}` : ''}
                  <span className="muted"> · {fmtMoney(p.sale_price)} · {p.stock_qty} {p.unit} in stock</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr><th style={{ width: '38%' }}>Description</th><th>Qty</th><th>Unit price ({currency})</th><th>GST</th><th className="r">Amount</th><th></th></tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const rate = taxRates.find((t) => t.code === l.tax_code)?.rate_percent ?? 0
                const lineSub = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
                return (
                  <tr key={i}>
                    <td><input value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td>
                    <td><input type="number" step="any" min="0" style={{ width: 80 }} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
                    <td><input type="number" step="0.01" min="0" style={{ width: 110 }} value={l.unit_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} /></td>
                    <td>
                      <select value={l.tax_code} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, tax_code: e.target.value } : x)))}>
                        {taxRates.map((t) => (
                          <option key={t.id} value={t.code}>{t.code} {t.rate_percent}%</option>
                        ))}
                      </select>
                    </td>
                    <td className="r">{fmtMoney(lineSub * (1 + rate / 100), currency)}</td>
                    <td>
                      <button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} title="Remove line">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <button className="btn" style={{ marginTop: 10 }} onClick={addCustomLine}>
          <Plus size={14} /> Custom line
        </button>

        <div className="invoice-summary">
          <div><span>Subtotal</span><span>{fmtMoney(totals.subtotal, currency)}</span></div>
          <div><span>GST</span><span>{fmtMoney(totals.gst, currency)}</span></div>
          <div className="grand"><span>Total</span><span>{fmtMoney(totals.total, currency)}</span></div>
          {currency === 'USD' && <div className="muted fx"><span>≈ MVR</span><span>{fmtMoney(totals.total * usdRate)}</span></div>}
        </div>

        <Field label="Notes (shown on the invoice)">
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div className="modal-actions">
          <button className="btn btn-primary" disabled={saving || lines.length === 0} onClick={() => save('issued')}>
            Issue invoice
          </button>
          <button className="btn" disabled={saving || lines.length === 0} onClick={() => save('draft')}>
            Save as draft
          </button>
          <span className="muted" style={{ fontSize: 12 }}>Issuing assigns the number and deducts stock.</span>
        </div>
      </div>
    </div>
  )
}
