import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, TrendingUp, Wallet, Boxes } from 'lucide-react'
import { apiFetch } from '../api'
import { fmtMoney, fmtQty, fmtDate } from '../format'
import { StatusBadge, EmptyState, ErrorNote } from '../ui'

interface Summary {
  revenue_this_month_mvr: number
  outstanding_mvr: number
  overdue_invoices: number
  inventory_value_mvr: number
  active_products: number
  low_stock_products: number
}

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [lowStock, setLowStock] = useState<Record<string, unknown>[]>([])
  const [recent, setRecent] = useState<Record<string, unknown>[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<Summary>('/reports/summary'),
      apiFetch<{ products: Record<string, unknown>[] }>('/products?low_stock=true'),
      apiFetch<{ invoices: Record<string, unknown>[] }>('/invoices'),
    ])
      .then(([s, p, i]) => {
        setSummary(s)
        setLowStock(p.products)
        setRecent(i.invoices.slice(0, 8))
      })
      .catch((e) => setError(e.message))
  }, [])

  return (
    <div>
      <div className="page-head">
        <h1>Dashboard</h1>
      </div>
      <ErrorNote error={error} />
      {summary && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-icon teal"><TrendingUp size={20} /></div>
            <div>
              <div className="stat-label">Invoiced this month</div>
              <div className="stat-value">{fmtMoney(summary.revenue_this_month_mvr)}</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon coral"><Wallet size={20} /></div>
            <div>
              <div className="stat-label">Outstanding</div>
              <div className="stat-value">{fmtMoney(summary.outstanding_mvr)}</div>
              {summary.overdue_invoices > 0 && (
                <div className="stat-sub warn">{summary.overdue_invoices} overdue invoice{summary.overdue_invoices === 1 ? '' : 's'}</div>
              )}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon teal"><Boxes size={20} /></div>
            <div>
              <div className="stat-label">Inventory value (cost)</div>
              <div className="stat-value">{fmtMoney(summary.inventory_value_mvr)}</div>
              <div className="stat-sub">{summary.active_products} active products</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon amber"><AlertTriangle size={20} /></div>
            <div>
              <div className="stat-label">Low stock</div>
              <div className="stat-value">{summary.low_stock_products}</div>
              <div className="stat-sub">at or below threshold</div>
            </div>
          </div>
        </div>
      )}

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Low stock</h2>
            <Link to="/products" className="link">All products →</Link>
          </div>
          {lowStock.length === 0 ? (
            <EmptyState>All stocked up. 🌊</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr><th>SKU</th><th>Product</th><th className="r">Stock</th><th className="r">Threshold</th></tr>
              </thead>
              <tbody>
                {lowStock.slice(0, 8).map((p) => (
                  <tr key={String(p.id)}>
                    <td className="mono">{String(p.sku)}</td>
                    <td>{String(p.name)}{p.variant_name ? ` — ${p.variant_name}` : ''}</td>
                    <td className={`r ${Number(p.stock_qty) <= 0 ? 'danger' : 'warn'}`}>{fmtQty(p.stock_qty as number)}</td>
                    <td className="r muted">{fmtQty(p.low_stock_threshold as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Recent invoices</h2>
            <Link to="/invoices" className="link">All invoices →</Link>
          </div>
          {recent.length === 0 ? (
            <EmptyState>No invoices yet — create one from the Invoices page.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Number</th><th>Customer</th><th className="r">Total</th><th>Status</th></tr>
              </thead>
              <tbody>
                {recent.map((inv) => (
                  <tr key={String(inv.id)}>
                    <td><Link className="link mono" to={`/invoices/${inv.id}`}>{String(inv.number)}</Link></td>
                    <td>{String(inv.customer_name ?? 'Walk-in')}</td>
                    <td className="r">{fmtMoney(inv.total as number, String(inv.currency))}</td>
                    <td><StatusBadge status={String(inv.status)} overdue={Boolean(inv.overdue)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {recent.length > 0 && `Last updated ${fmtDate(new Date().toISOString())}`}
          </div>
        </section>
      </div>
    </div>
  )
}
