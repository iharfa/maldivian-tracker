const KEY_STORAGE = 'fihaara_api_key'

export function getStoredKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? ''
}

export function setStoredKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key)
  else localStorage.removeItem(KEY_STORAGE)
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export async function apiFetch<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = getStoredKey()
  if (key) headers['Authorization'] = `Bearer ${key}`
  const res = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 401) {
    onUnauthorized?.()
    throw new HttpError(401, 'API key required')
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new HttpError(res.status, String(data.error ?? `HTTP ${res.status}`))
  return data as T
}
