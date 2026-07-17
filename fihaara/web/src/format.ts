export function fmtMoney(value: number | null | undefined, currency = 'MVR'): string {
  const n = Number(value ?? 0)
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtQty(value: number | null | undefined): string {
  const n = Number(value ?? 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  return value.slice(0, 10)
}

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
}
