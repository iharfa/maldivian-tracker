import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { apiFetch } from '../api'
import { fmtMoney, fmtDate } from '../format'
import { StatusBadge, EmptyState, ErrorNote } from '../ui'

const FILTERS = ['', 'draft', 'issued', 'partially_paid', 'paid', 'void'] as const

export default function Invoices() {
  const [invoices, setInvoices] = useState<Record<string, unknown>[]>([])
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(() => {
    apiFetch<{ invoices: Record<string, unknown>[] }>(
      `/invoices?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`,
    )
      .then((r) => setInvoices(r.invoices))
      .catch((e) => setError(e.message))
  }, [status, q])

  useEffect(load, [load])

  return (
    <div>
      <div className="page-head">
        <h1>Invoices</h1>
        <div className="page-actions">
          <input className="search" placeholder="Search number, customer, order ref…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" onClick={() => navigate('/invoices/new')}>
            <Plus size={15} /> New invoice
          </button>
        </div>
      </div>
      <div className="filter-row">
        {FILTERS.map((f) => (
          <button key={f} className={`chip ${status === f ? 'chip-active' : ''}`} onClick={() => setStatus(f)}>
            {f === '' ? 'All' : f === 'partially_paid' ? 'Partially paid' : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {invoices.length === 0 ? (
        <EmptyState>No invoices match. Create one, or POST an order to /api/v1/orders from your store.</EmptyState>
      ) : (
        <table className="table panel">
          <thead>
            <tr>
              <th>Number</th><th>Date</th><th>Customer</th><th>Source</th>
              <th className="r">Total</th><th className="r">Balance</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={String(inv.id)}>
                <td><Link className="link mono" to={`/invoices/${inv.id}`}>{String(inv.number)}</Link></td>
                <td className="muted">{fmtDate(inv.issue_date as string)}</td>
                <td>{String(inv.customer_name ?? 'Walk-in')}</td>
                <td className="muted">{inv.external_ref ? `${inv.source}: ${inv.external_ref}` : String(inv.source)}</td>
                <td className="r">{fmtMoney(inv.total as number, String(inv.currency))}</td>
                <td className="r">{fmtMoney(inv.balance_due as number, String(inv.currency))}</td>
                <td><StatusBadge status={String(inv.status)} overdue={Boolean(inv.overdue)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
