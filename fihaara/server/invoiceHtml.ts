import { getSetting, DEFAULTS } from './db.js'
import type { BusinessSettings, InvoiceSettings } from './db.js'

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function money(v: unknown, currency: string): string {
  const n = Number(v ?? 0)
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Standalone printable tax invoice (MIRA GST Regulation layout: the words
 * "TAX INVOICE", seller name/address/TIN/GST TIN, sequential invoice number,
 * date, customer identification, per-line description/qty/price, GST shown
 * separately, and totals). Open in a browser and print to PDF.
 */
export function renderInvoiceHtml(invoice: Record<string, unknown>): string {
  const business = getSetting<BusinessSettings>('business', DEFAULTS.business)
  const invoiceCfg = getSetting<InvoiceSettings>('invoice', DEFAULTS.invoice)
  const currency = String(invoice.currency)
  const lines = (invoice.lines ?? []) as Record<string, unknown>[]
  const payments = (invoice.payments ?? []) as Record<string, unknown>[]
  const isVoid = invoice.status === 'void'
  const title = business.gst_registered ? 'TAX INVOICE' : 'INVOICE'
  const usdRate = Number(invoice.usd_rate)
  const totalMvr = currency === 'USD' ? Number(invoice.total) * usdRate : Number(invoice.total)

  const gstByRate = new Map<string, { rate: number; amount: number }>()
  for (const l of lines) {
    const code = String(l.tax_code ?? '—')
    const entry = gstByRate.get(code) ?? { rate: Number(l.tax_rate_percent), amount: 0 }
    entry.amount += Number(l.line_gst)
    gstByRate.set(code, entry)
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(invoice.number)} — ${esc(business.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1a2b33; background: #f2f5f6; padding: 24px; }
  .sheet { max-width: 800px; margin: 0 auto; background: #fff; padding: 48px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.08); position: relative; }
  .void-stamp { position: absolute; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg); font-size: 96px; font-weight: 800; color: rgba(200,30,30,.18); letter-spacing: 8px; pointer-events: none; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #0d7d8c; padding-bottom: 20px; margin-bottom: 24px; }
  h1 { font-size: 22px; letter-spacing: 3px; color: #0d7d8c; }
  .biz-name { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .muted { color: #5b6d75; font-size: 13px; line-height: 1.5; }
  .meta { text-align: right; }
  .meta .num { font-size: 16px; font-weight: 700; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #81959d; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: #5b6d75; border-bottom: 2px solid #d7e0e3; padding: 8px 6px; }
  td { padding: 9px 6px; border-bottom: 1px solid #e8eef0; vertical-align: top; }
  .r { text-align: right; }
  .totals { margin-top: 16px; margin-left: auto; width: 300px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 5px 6px; }
  .totals .grand { border-top: 2px solid #0d7d8c; font-weight: 700; font-size: 16px; margin-top: 4px; }
  .totals .due { color: #b3261e; font-weight: 700; }
  .paid-badge { color: #1c7c39; font-weight: 700; }
  .fx { font-size: 12px; color: #5b6d75; text-align: right; margin-top: 6px; }
  .payments { margin-top: 24px; }
  .payments h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #5b6d75; margin-bottom: 6px; }
  footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #d7e0e3; font-size: 12.5px; color: #5b6d75; }
  .actions { max-width: 800px; margin: 16px auto 0; text-align: right; }
  .actions button { background: #0d7d8c; color: #fff; border: 0; padding: 10px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; border-radius: 0; padding: 24px; max-width: none; }
    .actions { display: none; }
  }
</style>
</head>
<body>
<div class="sheet">
  ${isVoid ? '<div class="void-stamp">VOID</div>' : ''}
  <header>
    <div>
      <div class="biz-name">${esc(business.name)}</div>
      <div class="muted">
        ${esc(business.address)}${business.address ? ', ' : ''}${esc(business.island)}, Republic of Maldives<br>
        ${business.phone ? `Tel: ${esc(business.phone)}<br>` : ''}
        ${business.email ? `${esc(business.email)}<br>` : ''}
        ${business.tin ? `TIN: ${esc(business.tin)}<br>` : ''}
        ${business.gst_registered && business.gst_tin ? `GST TIN: ${esc(business.gst_tin)}` : ''}
      </div>
    </div>
    <div class="meta">
      <h1>${title}</h1>
      <div class="num">${esc(invoice.number)}</div>
      <div class="muted">
        Date: ${esc(invoice.issue_date)}<br>
        ${invoice.due_date ? `Due: ${esc(invoice.due_date)}<br>` : ''}
        Currency: ${esc(currency)}
      </div>
    </div>
  </header>

  <div class="parties">
    <div>
      <div class="label">Billed to</div>
      <div><strong>${esc(invoice.customer_name ?? 'Walk-in customer')}</strong></div>
      <div class="muted">
        ${invoice.customer_address ? `${esc(invoice.customer_address)}<br>` : ''}
        ${invoice.customer_phone ? `Tel: ${esc(invoice.customer_phone)}<br>` : ''}
        ${invoice.customer_tin ? `TIN: ${esc(invoice.customer_tin)}` : ''}
      </div>
    </div>
    ${invoice.external_ref ? `<div class="meta"><div class="label">Order reference</div><div>${esc(invoice.external_ref)}</div></div>` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:44%">Description</th>
        <th class="r">Qty</th>
        <th class="r">Unit price</th>
        <th class="r">GST</th>
        <th class="r">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lines
        .map(
          (l) => `<tr>
        <td>${esc(l.description)}${l.sku ? `<br><span class="muted">SKU: ${esc(l.sku)}</span>` : ''}</td>
        <td class="r">${esc(l.qty)}</td>
        <td class="r">${money(l.unit_price, currency)}</td>
        <td class="r">${Number(l.tax_rate_percent) > 0 ? `${money(l.line_gst, currency)} <span class="muted">(${esc(l.tax_rate_percent)}%)</span>` : '—'}</td>
        <td class="r">${money(l.line_total, currency)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal (excl. GST)</span><span>${money(invoice.subtotal, currency)}</span></div>
    ${[...gstByRate.entries()]
      .filter(([, v]) => v.amount > 0)
      .map(([code, v]) => `<div><span>${esc(code)} ${esc(v.rate)}%</span><span>${money(v.amount, currency)}</span></div>`)
      .join('')}
    <div class="grand"><span>Total</span><span>${money(invoice.total, currency)}</span></div>
    ${Number(invoice.amount_paid) > 0 ? `<div><span>Paid</span><span>${money(invoice.amount_paid, currency)}</span></div>` : ''}
    ${
      invoice.status === 'paid'
        ? `<div class="paid-badge"><span>PAID IN FULL</span><span></span></div>`
        : Number(invoice.balance_due) > 0 && invoice.status !== 'draft' && !isVoid
          ? `<div class="due"><span>Balance due</span><span>${money(invoice.balance_due, currency)}</span></div>`
          : ''
    }
  </div>
  ${currency === 'USD' ? `<div class="fx">Equivalent: MVR ${totalMvr.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} at USD 1 = MVR ${usdRate}</div>` : ''}

  ${
    payments.length > 0
      ? `<div class="payments"><h3>Payments received</h3><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead><tbody>${payments
          .map(
            (p) =>
              `<tr><td>${esc(p.paid_at)}</td><td>${esc(p.method)}</td><td>${esc(p.reference ?? '—')}</td><td class="r">${money(p.amount, currency)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : ''
  }

  <footer>
    ${invoice.notes ? `${esc(invoice.notes)}<br><br>` : ''}
    ${esc(invoiceCfg.footer_note)}
  </footer>
</div>
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
</body>
</html>`
}
