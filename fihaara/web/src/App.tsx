import { useEffect, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import { LayoutDashboard, Package, FileText, Users, Settings as SettingsIcon, KeyRound } from 'lucide-react'
import { setUnauthorizedHandler, setStoredKey, getStoredKey } from './api'
import { Modal, Field } from './ui'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Invoices from './pages/Invoices'
import InvoiceDetail from './pages/InvoiceDetail'
import NewInvoice from './pages/NewInvoice'
import Customers from './pages/Customers'
import Settings from './pages/Settings'

export default function App() {
  const [needsKey, setNeedsKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')

  useEffect(() => {
    setUnauthorizedHandler(() => setNeedsKey(true))
  }, [])

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">ފ</span>
          <div>
            <div className="brand-name">Fihaara</div>
            <div className="brand-sub">Inventory &amp; Invoicing</div>
          </div>
        </div>
        <nav>
          <NavLink to="/" end>
            <LayoutDashboard size={17} /> Dashboard
          </NavLink>
          <NavLink to="/products">
            <Package size={17} /> Products
          </NavLink>
          <NavLink to="/invoices">
            <FileText size={17} /> Invoices
          </NavLink>
          <NavLink to="/customers">
            <Users size={17} /> Customers
          </NavLink>
          <NavLink to="/settings">
            <SettingsIcon size={17} /> Settings
          </NavLink>
        </nav>
        <div className="sidebar-foot">Made for the Maldives 🇲🇻</div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/new" element={<NewInvoice />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      {needsKey && (
        <Modal title="API key required" onClose={() => setNeedsKey(false)}>
          <p className="muted" style={{ marginBottom: 12 }}>
            This server has API keys configured, so requests must be authenticated. Paste an API key to continue
            (create one from Settings → API keys on a machine that still has access, or delete the keys row from the
            database to reopen access).
          </p>
          <Field label="API key">
            <input
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="fhr_…"
              autoFocus
            />
          </Field>
          <div className="modal-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                setStoredKey(keyInput.trim())
                setNeedsKey(false)
                window.location.reload()
              }}
            >
              <KeyRound size={15} /> Save key
            </button>
            {getStoredKey() && (
              <button
                className="btn"
                onClick={() => {
                  setStoredKey('')
                  setNeedsKey(false)
                  window.location.reload()
                }}
              >
                Clear stored key
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
