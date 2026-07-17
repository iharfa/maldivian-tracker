import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, PackagePlus, History } from 'lucide-react'
import { apiFetch } from '../api'
import { fmtMoney, fmtQty } from '../format'
import { Modal, Field, EmptyState, ErrorNote } from '../ui'

interface Product {
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
  is_active: boolean
  low_stock: boolean
}

interface TaxRate {
  id: number
  code: string
  label: string
  rate_percent: number
}

const emptyForm = {
  sku: '', name: '', group_name: '', variant_name: '', category: '', unit: 'pcs',
  cost_price: '0', sale_price: '0', tax_rate_id: '', low_stock_threshold: '5', stock_qty: '0', description: '',
}

export default function Products() {
  const [products, setProducts] = useState<Product[]>([])
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [history, setHistory] = useState<{ product: Product; movements: Record<string, unknown>[] } | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [adjustForm, setAdjustForm] = useState({ mode: 'delta', value: '', reason: 'adjustment', note: '' })

  const load = useCallback(() => {
    apiFetch<{ products: Product[] }>(`/products?q=${encodeURIComponent(q)}`)
      .then((r) => setProducts(r.products))
      .catch((e) => setError(e.message))
  }, [q])

  useEffect(() => {
    load()
    apiFetch<{ tax_rates: TaxRate[] }>('/tax-rates').then((r) => setTaxRates(r.tax_rates)).catch(() => {})
  }, [load])

  function openEdit(p: Product | 'new') {
    setError(null)
    setEditing(p)
    setForm(
      p === 'new'
        ? emptyForm
        : {
            sku: p.sku, name: p.name, group_name: p.group_name ?? '', variant_name: p.variant_name ?? '',
            category: p.category ?? '', unit: p.unit, cost_price: String(p.cost_price), sale_price: String(p.sale_price),
            tax_rate_id: p.tax_rate_id ? String(p.tax_rate_id) : '', low_stock_threshold: String(p.low_stock_threshold),
            stock_qty: '', description: p.description ?? '',
          },
    )
  }

  async function save() {
    try {
      const body: Record<string, unknown> = {
        sku: form.sku, name: form.name, group_name: form.group_name || null, variant_name: form.variant_name || null,
        category: form.category || null, unit: form.unit || 'pcs', description: form.description || null,
        cost_price: Number(form.cost_price) || 0, sale_price: Number(form.sale_price) || 0,
        tax_rate_id: form.tax_rate_id ? Number(form.tax_rate_id) : null,
        low_stock_threshold: Number(form.low_stock_threshold) || 0,
      }
      if (editing === 'new') {
        body.stock_qty = Number(form.stock_qty) || 0
        await apiFetch('/products', { method: 'POST', body })
      } else if (editing) {
        await apiFetch(`/products/${editing.id}`, { method: 'PUT', body })
      }
      setEditing(null)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function saveAdjust() {
    if (!adjusting) return
    try {
      const value = Number(adjustForm.value)
      const body: Record<string, unknown> =
        adjustForm.mode === 'set'
          ? { set: value, reason: adjustForm.reason, note: adjustForm.note || null }
          : { delta: value, reason: adjustForm.reason, note: adjustForm.note || null }
      await apiFetch(`/products/${adjusting.id}/adjust-stock`, { method: 'POST', body })
      setAdjusting(null)
      setAdjustForm({ mode: 'delta', value: '', reason: 'adjustment', note: '' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function openHistory(p: Product) {
    try {
      const r = await apiFetch<{ movements: Record<string, unknown>[] }>(`/products/${p.id}/movements`)
      setHistory({ product: p, movements: r.movements })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function deactivate(p: Product) {
    if (!confirm(`Deactivate ${p.sku}? It keeps its history but disappears from lists.`)) return
    try {
      await apiFetch(`/products/${p.id}`, { method: 'DELETE' })
      setEditing(null)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const taxLabel = (id: number | null) => taxRates.find((t) => t.id === id)?.code ?? 'Default'

  return (
    <div>
      <div className="page-head">
        <h1>Products</h1>
        <div className="page-actions">
          <input className="search" placeholder="Search SKU, name, category…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" onClick={() => openEdit('new')}>
            <Plus size={15} /> New product
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
      {products.length === 0 ? (
        <EmptyState>No products yet. Add your first product to start tracking stock.</EmptyState>
      ) : (
        <table className="table panel">
          <thead>
            <tr>
              <th>SKU</th><th>Product</th><th>Category</th><th className="r">Cost</th><th className="r">Price</th>
              <th>GST</th><th className="r">Stock</th><th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.sku}</td>
                <td>
                  {p.name}
                  {p.variant_name && <span className="muted"> — {p.variant_name}</span>}
                </td>
                <td className="muted">{p.category ?? '—'}</td>
                <td className="r">{fmtMoney(p.cost_price)}</td>
                <td className="r">{fmtMoney(p.sale_price)}</td>
                <td>{taxLabel(p.tax_rate_id)}</td>
                <td className={`r ${p.stock_qty <= 0 ? 'danger' : p.low_stock ? 'warn' : ''}`}>
                  {fmtQty(p.stock_qty)} {p.unit}
                  {p.low_stock && <span className="badge badge-low">low</span>}
                </td>
                <td className="row-actions">
                  <button className="icon-btn" title="Adjust stock" onClick={() => { setError(null); setAdjusting(p) }}>
                    <PackagePlus size={16} />
                  </button>
                  <button className="icon-btn" title="Stock history" onClick={() => openHistory(p)}>
                    <History size={16} />
                  </button>
                  <button className="icon-btn" title="Edit" onClick={() => openEdit(p)}>
                    <Pencil size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'New product' : `Edit ${editing.sku}`} onClose={() => setEditing(null)} wide>
          <ErrorNote error={error} />
          <div className="form-grid">
            <Field label="SKU *">
              <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="TSHIRT-RED-L" />
            </Field>
            <Field label="Name *">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Cotton T-shirt" />
            </Field>
            <Field label="Variant" hint="e.g. Red / L — leave blank if the product has no variants">
              <input value={form.variant_name} onChange={(e) => setForm({ ...form, variant_name: e.target.value })} />
            </Field>
            <Field label="Group" hint="groups variants of the same product together">
              <input value={form.group_name} onChange={(e) => setForm({ ...form, group_name: e.target.value })} />
            </Field>
            <Field label="Category">
              <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </Field>
            <Field label="Unit">
              <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pcs" />
            </Field>
            <Field label="Cost price (MVR)">
              <input type="number" min="0" step="0.01" value={form.cost_price} onChange={(e) => setForm({ ...form, cost_price: e.target.value })} />
            </Field>
            <Field label="Sale price (MVR)">
              <input type="number" min="0" step="0.01" value={form.sale_price} onChange={(e) => setForm({ ...form, sale_price: e.target.value })} />
            </Field>
            <Field label="GST rate">
              <select value={form.tax_rate_id} onChange={(e) => setForm({ ...form, tax_rate_id: e.target.value })}>
                <option value="">Default rate</option>
                {taxRates.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Low stock threshold">
              <input type="number" min="0" value={form.low_stock_threshold} onChange={(e) => setForm({ ...form, low_stock_threshold: e.target.value })} />
            </Field>
            {editing === 'new' && (
              <Field label="Opening stock">
                <input type="number" value={form.stock_qty} onChange={(e) => setForm({ ...form, stock_qty: e.target.value })} />
              </Field>
            )}
          </div>
          <Field label="Description">
            <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={save}>Save product</button>
            {editing !== 'new' && (
              <button className="btn btn-danger-outline" onClick={() => deactivate(editing)}>Deactivate</button>
            )}
          </div>
        </Modal>
      )}

      {adjusting && (
        <Modal title={`Adjust stock — ${adjusting.sku}`} onClose={() => setAdjusting(null)}>
          <ErrorNote error={error} />
          <p className="muted" style={{ marginBottom: 12 }}>
            Current stock: <strong>{fmtQty(adjusting.stock_qty)} {adjusting.unit}</strong>. Every adjustment is recorded
            in the audit trail.
          </p>
          <div className="form-grid">
            <Field label="Mode">
              <select value={adjustForm.mode} onChange={(e) => setAdjustForm({ ...adjustForm, mode: e.target.value })}>
                <option value="delta">Add / remove (+/−)</option>
                <option value="set">Set exact count (stocktake)</option>
              </select>
            </Field>
            <Field label={adjustForm.mode === 'set' ? 'Counted quantity' : 'Change (use − to remove)'}>
              <input type="number" step="any" value={adjustForm.value} onChange={(e) => setAdjustForm({ ...adjustForm, value: e.target.value })} autoFocus />
            </Field>
            <Field label="Reason">
              <select value={adjustForm.reason} onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}>
                <option value="adjustment">Adjustment</option>
                <option value="receive">Stock received</option>
                <option value="return">Customer return</option>
                <option value="correction">Stocktake correction</option>
                <option value="damage">Damaged / expired</option>
              </select>
            </Field>
            <Field label="Note">
              <input value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} />
            </Field>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={saveAdjust}>Apply adjustment</button>
          </div>
        </Modal>
      )}

      {history && (
        <Modal title={`Stock history — ${history.product.sku}`} onClose={() => setHistory(null)} wide>
          {history.movements.length === 0 ? (
            <EmptyState>No movements recorded yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr><th>When</th><th>Reason</th><th>Reference</th><th className="r">Change</th><th className="r">After</th><th>Note</th></tr>
              </thead>
              <tbody>
                {history.movements.map((m) => (
                  <tr key={String(m.id)}>
                    <td className="muted">{String(m.created_at)}</td>
                    <td>{String(m.reason)}</td>
                    <td className="mono">{String(m.reference ?? '—')}</td>
                    <td className={`r ${Number(m.delta) < 0 ? 'danger' : 'ok'}`}>
                      {Number(m.delta) > 0 ? '+' : ''}{fmtQty(m.delta as number)}
                    </td>
                    <td className="r">{fmtQty(m.qty_after as number)}</td>
                    <td className="muted">{String(m.note ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  )
}
