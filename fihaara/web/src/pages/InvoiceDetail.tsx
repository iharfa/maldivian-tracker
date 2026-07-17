import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Printer, Send, Ban, BanknoteIcon, Trash2 } from 'lucide-react'
import { apiFetch, getStoredKey } from '../api'
import { fmtMoney, fmtQty, fmtDate } from '../format'
import { Modal, Field, StatusBadge, ErrorNote } from '../ui'

export default function InvoiceDetail() {
  const { id } = useParams()
  const [invoice, setInvoice] = useState<Record<string, unknown> | null>(null)
  const [methods, setMethods] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [payForm, setPayForm] = useState({ method: '', amount: '', reference: '', note: '' })

  const load = useCallback(() => {
    apiFetch<{ invoice: Record<string, unknown> }>(`/invoices/${id}`)
      .then((r) => setInvoice(r.invoice))
      .catch((e) => setError(e.message))
  }, [id])

  useEffect(() => {
    load()
    apiFetch<{ payment_methods: string[] }>('/settings')
      .then((r) => setMethods(r.payment_methods))
      .catch(() => {})
  }, [load])

  async function action(path: string, body?: unknown) {
    setError(null)
    try {
      const r = await apiFetch<{ invoice: Record<string, unknown> }>(path, { method: 'POST', body })
      setInvoice(r.invoice)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function removePayment(paymentId: number) {
    if (!confirm('Delete this payment record?')) return
    setError(null)
    try {
      const r = await apiFetch<{ invoice: Record<string, unknown> }>(`/invoices/${id}/payments/${paymentId}`, { method: 'DELETE' })
      setInvoice(r.invoice)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function openPrint() {
    const key = getStoredKey()
    // window.open cannot send an Authorization header; fetch the HTML and open it in a new tab instead
    fetch(`/api/v1/invoices/${id}/html`, { headers: key ? { Authorization: `Bearer ${key}` } : {} })
      .then((r) => r.text())
      .then((html) => {
        const w = window.open('', '_blank')
        if (w) {
          w.document.write(html)
          w.document.close()
        }
      })
      .catch((e) => setError((e as Error).message))
  }

  if (!invoice) {
    return (
      <div>
        <ErrorNote error={error} />
        <p className="muted">Loading…</p>
      </div>
    )
  }

  const currency = String(invoice.currency)
  const lines = (invoice.lines ?? []) as Record<string, unknown>[]
  const payments = (invoice.payments ?? []) as Record<string, unknown>[]
  const status = String(invoice.status)
  const balance = Number(invoice.balance_due)

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/invoices" className="link">Invoices</Link> / {String(invoice.number)}</div>
          <h1 style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {String(invoice.number)} <StatusBadge status={status} />
          </h1>
        </div>
        <div className="page-actions">
          {status === 'draft' && (
            <button className="btn btn-primary" onClick={() => action(`/invoices/${id}/issue`)}>
              <Send size={15} /> Issue
            </button>
          )}
          {(status === 'issued' || status === 'partially_paid') && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setPayForm({ method: methods[0] ?? 'Cash', amount: String(balance.toFixed(2)), reference: '', note: '' })
                setPaying(true)
              }}
            >
              <BanknoteIcon size={15} /> Record payment
            </button>
          )}
          <button className="btn" onClick={openPrint}>
            <Printer size={15} /> Print / PDF
          </button>
          {status !== 'void' && Number(invoice.amount_paid) === 0 && (
            <button
              className="btn btn-danger-outline"
              onClick={() => confirm('Void this invoice? Stock will be restored.') && action(`/invoices/${id}/void`)}
            >
              <Ban size={15} /> Void
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />

      <div className="two-col">
        <section className="panel" style={{ padding: 20 }}>
          <div className="detail-grid">
            <div><div className="label">Customer</div>{String(invoice.customer_name ?? 'Walk-in customer')}</div>
            <div><div className="label">Customer TIN</div>{String(invoice.customer_tin ?? '—')}</div>
            <div><div className="label">Issue date</div>{fmtDate(invoice.issue_date as string)}</div>
            <div><div className="label">Due date</div>{fmtDate(invoice.due_date as string)}</div>
            <div><div className="label">Source</div>{invoice.external_ref ? `${invoice.source} · ${invoice.external_ref}` : String(invoice.source)}</div>
            <div><div className="label">Currency</div>{currency}{currency === 'USD' ? ` (1 USD = ${invoice.usd_rate} MVR)` : ''}</div>
          </div>

          <table className="table" style={{ marginTop: 16 }}>
            <thead>
              <tr><th>Description</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">GST</th><th className="r">Amount</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={String(l.id)}>
                  <td>
                    {String(l.description)}
                    {l.sku ? <div className="muted mono" style={{ fontSize: 11 }}>{String(l.sku)}</div> : null}
                  </td>
                  <td className="r">{fmtQty(l.qty as number)}</td>
                  <td className="r">{fmtMoney(l.unit_price as number, currency)}</td>
                  <td className="r">
                    {Number(l.tax_rate_percent) > 0
                      ? `${fmtMoney(l.line_gst as number, currency)} (${l.tax_rate_percent}%)`
                      : '—'}
                  </td>
                  <td className="r">{fmtMoney(l.line_total as number, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="invoice-summary">
            <div><span>Subtotal</span><span>{fmtMoney(invoice.subtotal as number, currency)}</span></div>
            <div><span>GST</span><span>{fmtMoney(invoice.gst_total as number, currency)}</span></div>
            <div className="grand"><span>Total</span><span>{fmtMoney(invoice.total as number, currency)}</span></div>
            <div><span>Paid</span><span>{fmtMoney(invoice.amount_paid as number, currency)}</span></div>
            {balance > 0 && status !== 'draft' && status !== 'void' && (
              <div className="due"><span>Balance due</span><span>{fmtMoney(balance, currency)}</span></div>
            )}
          </div>
          {invoice.notes ? <p className="muted" style={{ marginTop: 12 }}>{String(invoice.notes)}</p> : null}
        </section>

        <section className="panel" style={{ padding: 20 }}>
          <h2 style={{ marginBottom: 10 }}>Payments</h2>
          {payments.length === 0 ? (
            <p className="muted">No payments recorded.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Method</th><th>Reference</th><th className="r">Amount</th><th></th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={String(p.id)}>
                    <td>{fmtDate(p.paid_at as string)}</td>
                    <td>{String(p.method)}</td>
                    <td className="mono">{String(p.reference ?? '—')}</td>
                    <td className="r">{fmtMoney(p.amount as number, currency)}</td>
                    <td>
                      <button className="icon-btn" title="Delete payment" onClick={() => removePayment(Number(p.id))}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {paying && (
        <Modal title={`Record payment — ${invoice.number}`} onClose={() => setPaying(false)}>
          <div className="form-grid">
            <Field label="Method">
              <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                {methods.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={`Amount (${currency})`}>
              <input type="number" step="0.01" min="0" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} />
            </Field>
            <Field label="Reference" hint="e.g. BML/Favara transfer reference">
              <input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} />
            </Field>
            <Field label="Note">
              <input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} />
            </Field>
          </div>
          <div className="modal-actions">
            <button
              className="btn btn-primary"
              onClick={async () => {
                await action(`/invoices/${id}/payments`, {
                  method: payForm.method,
                  amount: Number(payForm.amount),
                  reference: payForm.reference || undefined,
                  note: payForm.note || undefined,
                })
                setPaying(false)
              }}
            >
              Save payment
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
