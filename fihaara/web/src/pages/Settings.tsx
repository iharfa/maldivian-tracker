import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Copy, Check } from 'lucide-react'
import { apiFetch } from '../api'
import { Field, ErrorNote } from '../ui'

interface TaxRate { id: number; code: string; label: string; rate_percent: number; is_default: number; is_active: number }
interface ApiKey { id: number; name: string; key_prefix: string; created_at: string; last_used_at: string | null }
interface Webhook { id: number; url: string; events: string[]; is_active: boolean }

export default function Settings() {
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [business, setBusiness] = useState({ name: '', address: '', island: '', phone: '', email: '', tin: '', gst_tin: '', gst_registered: true })
  const [usdRate, setUsdRate] = useState('15.42')
  const [invoiceCfg, setInvoiceCfg] = useState({ prefix: 'INV', next_number: 1, due_days: 14, footer_note: '' })
  const [methods, setMethods] = useState('')
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [newRate, setNewRate] = useState({ code: '', label: '', rate_percent: '' })
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [webhookEvents, setWebhookEvents] = useState<string[]>([])
  const [newHook, setNewHook] = useState({ url: '', events: '*', secret: '' })
  const [freshHookSecret, setFreshHookSecret] = useState<string | null>(null)

  const load = useCallback(() => {
    apiFetch<{
      business: typeof business
      currency: { usd_rate: number }
      invoice: typeof invoiceCfg
      payment_methods: string[]
      webhook_events: string[]
    }>('/settings')
      .then((r) => {
        setBusiness(r.business)
        setUsdRate(String(r.currency.usd_rate))
        setInvoiceCfg(r.invoice)
        setMethods(r.payment_methods.join(', '))
        setWebhookEvents(r.webhook_events)
      })
      .catch((e) => setError(e.message))
    apiFetch<{ tax_rates: TaxRate[] }>('/tax-rates').then((r) => setTaxRates(r.tax_rates)).catch(() => {})
    apiFetch<{ api_keys: ApiKey[] }>('/api-keys').then((r) => setApiKeys(r.api_keys)).catch(() => {})
    apiFetch<{ webhooks: Webhook[] }>('/webhooks').then((r) => setWebhooks(r.webhooks)).catch(() => {})
  }, [])

  useEffect(load, [load])

  async function saveGeneral() {
    setError(null)
    setSaved(false)
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: {
          business,
          currency: { usd_rate: Number(usdRate) },
          invoice: invoiceCfg,
          payment_methods: methods.split(',').map((m) => m.trim()).filter(Boolean),
        },
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function addRate() {
    setError(null)
    try {
      await apiFetch('/tax-rates', {
        method: 'POST',
        body: { code: newRate.code, label: newRate.label, rate_percent: Number(newRate.rate_percent) },
      })
      setNewRate({ code: '', label: '', rate_percent: '' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function updateRate(rate: TaxRate, patch: Record<string, unknown>) {
    setError(null)
    try {
      await apiFetch(`/tax-rates/${rate.id}`, { method: 'PUT', body: patch })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function createKey() {
    setError(null)
    try {
      const r = await apiFetch<{ key: string }>('/api-keys', { method: 'POST', body: { name: newKeyName } })
      setFreshKey(r.key)
      setNewKeyName('')
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function addWebhook() {
    setError(null)
    try {
      const events = newHook.events === '*' ? ['*'] : newHook.events.split(',').map((e) => e.trim()).filter(Boolean)
      const r = await apiFetch<{ secret: string }>('/webhooks', {
        method: 'POST',
        body: { url: newHook.url, events, secret: newHook.secret || undefined },
      })
      setFreshHookSecret(r.secret)
      setNewHook({ url: '', events: '*', secret: '' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <ErrorNote error={error} />

      <section className="panel settings-section">
        <h2>Business & MIRA details</h2>
        <p className="muted">Shown on every tax invoice. Fill in your TIN and GST TIN as registered with MIRA.</p>
        <div className="form-grid">
          <Field label="Business name"><input value={business.name} onChange={(e) => setBusiness({ ...business, name: e.target.value })} /></Field>
          <Field label="Address"><input value={business.address} onChange={(e) => setBusiness({ ...business, address: e.target.value })} /></Field>
          <Field label="Island / City"><input value={business.island} onChange={(e) => setBusiness({ ...business, island: e.target.value })} /></Field>
          <Field label="Phone"><input value={business.phone} onChange={(e) => setBusiness({ ...business, phone: e.target.value })} /></Field>
          <Field label="Email"><input value={business.email} onChange={(e) => setBusiness({ ...business, email: e.target.value })} /></Field>
          <Field label="TIN"><input value={business.tin} onChange={(e) => setBusiness({ ...business, tin: e.target.value })} placeholder="e.g. 1234567GST501" /></Field>
          <Field label="GST TIN"><input value={business.gst_tin} onChange={(e) => setBusiness({ ...business, gst_tin: e.target.value })} /></Field>
          <Field label="GST registered" hint="unregistered businesses print 'INVOICE' instead of 'TAX INVOICE'">
            <select value={business.gst_registered ? 'yes' : 'no'} onChange={(e) => setBusiness({ ...business, gst_registered: e.target.value === 'yes' })}>
              <option value="yes">Yes — GST registered</option>
              <option value="no">No</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="panel settings-section">
        <h2>Currency & invoicing</h2>
        <div className="form-grid">
          <Field label="USD → MVR rate" hint="used for USD invoices and MVR-equivalent reporting">
            <input type="number" step="0.01" value={usdRate} onChange={(e) => setUsdRate(e.target.value)} />
          </Field>
          <Field label="Invoice prefix"><input value={invoiceCfg.prefix} onChange={(e) => setInvoiceCfg({ ...invoiceCfg, prefix: e.target.value })} /></Field>
          <Field label="Next invoice number"><input type="number" min="1" value={invoiceCfg.next_number} onChange={(e) => setInvoiceCfg({ ...invoiceCfg, next_number: Number(e.target.value) })} /></Field>
          <Field label="Payment due (days)"><input type="number" min="0" value={invoiceCfg.due_days} onChange={(e) => setInvoiceCfg({ ...invoiceCfg, due_days: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Invoice footer note"><input value={invoiceCfg.footer_note} onChange={(e) => setInvoiceCfg({ ...invoiceCfg, footer_note: e.target.value })} /></Field>
        <Field label="Payment methods (comma-separated)" hint="Cash, Card, BML Transfer, Favara, m-Faisaa…">
          <input value={methods} onChange={(e) => setMethods(e.target.value)} />
        </Field>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={saveGeneral}>Save settings</button>
          {saved && <span className="ok"><Check size={15} /> Saved</span>}
        </div>
      </section>

      <section className="panel settings-section">
        <h2>GST rates</h2>
        <p className="muted">
          Rates follow the Maldives GST Act and change by amendment — update them here when MIRA announces a change.
        </p>
        <table className="table">
          <thead>
            <tr><th>Code</th><th>Label</th><th className="r">Rate %</th><th>Default</th><th>Active</th></tr>
          </thead>
          <tbody>
            {taxRates.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.code}</td>
                <td>
                  <input defaultValue={t.label} onBlur={(e) => e.target.value !== t.label && updateRate(t, { label: e.target.value })} />
                </td>
                <td className="r">
                  <input
                    type="number" step="0.1" style={{ width: 80, textAlign: 'right' }} defaultValue={t.rate_percent}
                    onBlur={(e) => Number(e.target.value) !== t.rate_percent && updateRate(t, { rate_percent: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input type="radio" name="default-rate" checked={!!t.is_default} onChange={() => updateRate(t, { is_default: true })} />
                </td>
                <td>
                  <input type="checkbox" checked={!!t.is_active} onChange={(e) => updateRate(t, { is_active: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="inline-form">
          <input placeholder="Code (e.g. TGST)" value={newRate.code} onChange={(e) => setNewRate({ ...newRate, code: e.target.value })} style={{ width: 130 }} />
          <input placeholder="Label" value={newRate.label} onChange={(e) => setNewRate({ ...newRate, label: e.target.value })} />
          <input placeholder="Rate %" type="number" value={newRate.rate_percent} onChange={(e) => setNewRate({ ...newRate, rate_percent: e.target.value })} style={{ width: 90 }} />
          <button className="btn" onClick={addRate}><Plus size={14} /> Add rate</button>
        </div>
      </section>

      <section className="panel settings-section">
        <h2>API keys</h2>
        <p className="muted">
          With no keys, the API is open (fine for local use). Create a key before exposing the server — after the first
          key exists, every request (including this dashboard) must authenticate.
        </p>
        {freshKey && (
          <div className="key-reveal">
            <span>New key (copy it now — it is shown only once):</span>
            <code>{freshKey}</code>
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard.writeText(freshKey)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
        )}
        {apiKeys.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr>
            </thead>
            <tbody>
              {apiKeys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">{k.key_prefix}…</td>
                  <td className="muted">{k.created_at}</td>
                  <td className="muted">{k.last_used_at ?? 'never'}</td>
                  <td>
                    <button
                      className="icon-btn"
                      title="Revoke"
                      onClick={async () => {
                        if (!confirm(`Revoke key '${k.name}'? Integrations using it will stop working.`)) return
                        await apiFetch(`/api-keys/${k.id}`, { method: 'DELETE' }).catch((e) => setError(e.message))
                        load()
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="inline-form">
          <input placeholder="Key name (e.g. shopify-store)" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
          <button className="btn" onClick={createKey} disabled={!newKeyName.trim()}><Plus size={14} /> Create key</button>
        </div>
      </section>

      <section className="panel settings-section">
        <h2>Webhooks</h2>
        <p className="muted">
          POSTed as JSON with an HMAC-SHA256 signature in <code>X-Fihaara-Signature</code>. Events: {webhookEvents.join(', ')} (or <code>*</code> for all).
        </p>
        {freshHookSecret && (
          <div className="key-reveal">
            <span>Webhook secret (used to verify signatures):</span>
            <code>{freshHookSecret}</code>
          </div>
        )}
        {webhooks.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>URL</th><th>Events</th><th></th></tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td className="mono">{w.url}</td>
                  <td>{w.events.join(', ')}</td>
                  <td className="row-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => apiFetch(`/webhooks/${w.id}/test`, { method: 'POST' }).catch((e) => setError(e.message))}
                    >
                      Send test
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm('Delete this webhook?')) return
                        await apiFetch(`/webhooks/${w.id}`, { method: 'DELETE' }).catch((e) => setError(e.message))
                        load()
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="inline-form">
          <input placeholder="https://your-store.example/webhooks/fihaara" value={newHook.url} onChange={(e) => setNewHook({ ...newHook, url: e.target.value })} />
          <input placeholder="Events (* or comma list)" value={newHook.events} onChange={(e) => setNewHook({ ...newHook, events: e.target.value })} style={{ width: 180 }} />
          <button className="btn" onClick={addWebhook} disabled={!newHook.url.trim()}><Plus size={14} /> Add webhook</button>
        </div>
      </section>
    </div>
  )
}
