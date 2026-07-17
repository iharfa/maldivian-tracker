import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { STATUS_LABELS } from './format'

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function StatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue && (status === 'issued' || status === 'partially_paid')) {
    return <span className="badge badge-overdue">Overdue</span>
  }
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="error-note">{error}</div>
}
