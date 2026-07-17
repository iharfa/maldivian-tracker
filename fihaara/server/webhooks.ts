import { createHmac } from 'node:crypto'
import { db } from './db.js'

export const WEBHOOK_EVENTS = [
  'invoice.created',
  'invoice.paid',
  'invoice.voided',
  'stock.updated',
  'stock.low',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

interface WebhookRow {
  id: number
  url: string
  secret: string
  events: string
  is_active: number
}

/**
 * Fire-and-forget webhook dispatch. Each delivery is signed with
 * HMAC-SHA256 of the raw body using the endpoint's secret, sent in
 * the X-Fihaara-Signature header so receivers can verify authenticity.
 */
export function fireWebhook(event: WebhookEvent, data: Record<string, unknown>): void {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE is_active = 1').all() as unknown as WebhookRow[]
  const targets = hooks.filter((h) => {
    try {
      const events = JSON.parse(h.events) as string[]
      return events.includes(event) || events.includes('*')
    } catch {
      return false
    }
  })
  if (targets.length === 0) return
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data })
  for (const hook of targets) {
    void deliver(hook, event, body)
  }
}

async function deliver(hook: WebhookRow, event: string, body: string): Promise<void> {
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex')
  let statusCode: number | null = null
  let ok = 0
  let error: string | null = null
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fihaara-Event': event,
        'X-Fihaara-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    statusCode = res.status
    ok = res.ok ? 1 : 0
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  try {
    db.prepare(
      'INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, ok, error) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(hook.id, event, body, statusCode, ok, error)
    // keep the delivery log bounded
    db.prepare(
      `DELETE FROM webhook_deliveries WHERE id NOT IN (SELECT id FROM webhook_deliveries ORDER BY id DESC LIMIT 200)`,
    ).run()
  } catch {
    // logging failure must never break the request path
  }
}
