import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { apiFetch } from '../api'
import { Modal, Field, EmptyState, ErrorNote } from '../ui'

interface Customer {
  id: number
  name: string
  tin: string | null
  phone: string | null
  email: string | null
  address: string | null
  island: string | null
}

const emptyForm = { name: '', tin: '', phone: '', email: '', address: '', island: '' }

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)
  const [form, setForm] = useState(emptyForm)

  const load = useCallback(() => {
    apiFetch<{ customers: Customer[] }>(`/customers?q=${encodeURIComponent(q)}`)
      .then((r) => setCustomers(r.customers))
      .catch((e) => setError(e.message))
  }, [q])

  useEffect(load, [load])

  function openEdit(c: Customer | 'new') {
    setError(null)
    setEditing(c)
    setForm(
      c === 'new'
        ? emptyForm
        : { name: c.name, tin: c.tin ?? '', phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '', island: c.island ?? '' },
    )
  }

  async function save() {
    try {
      const body = {
        name: form.name, tin: form.tin || null, phone: form.phone || null,
        email: form.email || null, address: form.address || null, island: form.island || null,
      }
      if (editing === 'new') await apiFetch('/customers', { method: 'POST', body })
      else if (editing) await apiFetch(`/customers/${editing.id}`, { method: 'PUT', body })
      setEditing(null)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(c: Customer) {
    if (!confirm(`Delete ${c.name}? Customers with invoices cannot be deleted.`)) return
    try {
      await apiFetch(`/customers/${c.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Customers</h1>
        <div className="page-actions">
          <input className="search" placeholder="Search name, phone, email…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" onClick={() => openEdit('new')}>
            <Plus size={15} /> New customer
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
      {customers.length === 0 ? (
        <EmptyState>No customers yet. They are also created automatically from e-commerce orders.</EmptyState>
      ) : (
        <table className="table panel">
          <thead>
            <tr><th>Name</th><th>TIN</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.tin ?? '—'}</td>
                <td>{c.phone ?? '—'}</td>
                <td>{c.email ?? '—'}</td>
                <td className="muted">{[c.address, c.island].filter(Boolean).join(', ') || '—'}</td>
                <td className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => openEdit(c)}><Pencil size={16} /></button>
                  <button className="icon-btn" title="Delete" onClick={() => remove(c)}><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'New customer' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ErrorNote error={error} />
          <div className="form-grid">
            <Field label="Name *"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="TIN" hint="shown on tax invoices for GST-registered customers"><input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} /></Field>
            <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
            <Field label="Island / Atoll"><input value={form.island} onChange={(e) => setForm({ ...form, island: e.target.value })} placeholder="Male', Hulhumale', Addu…" /></Field>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={save}>Save customer</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
