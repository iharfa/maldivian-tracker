# Fihaara — Inventory & Invoicing for Maldivian E-commerce

**Fihaara** (ފިހާރަ, Dhivehi for *shop*) is a self-contained inventory management and
invoicing tool built for the Maldivian context. It runs anywhere Node.js runs, stores
everything in a single SQLite file (no cloud database account needed), and exposes a
REST API + webhooks so you can plug it into **any e-commerce application** — Shopify,
WooCommerce, a custom store, or several stores at once.

## Maldivian localization

- **MIRA-compliant tax invoices** — "TAX INVOICE" heading, seller TIN & GST TIN,
  sequential invoice numbers, per-line GST shown separately, customer TIN for
  GST-registered buyers.
- **Configurable GST rates** — seeded with GST 8% (general sector), TGST 17%
  (tourism sector), zero-rated and exempt. Rates are *data, not code*: when MIRA
  amends a rate, change it in Settings → GST rates.
- **GST report** — `GET /api/v1/reports/gst?from&to` gives taxable value and GST
  collected per rate, in MVR, for filling in your MIRA GST return.
- **MVR + USD dual currency** — prices are kept in Rufiyaa; invoices can be issued
  in USD using a configurable rate (default 15.42). USD invoices snapshot the rate
  used, and all reporting converts back to MVR.
- **Local payment methods** — Cash, Card, BML Transfer, Favara, m-Faisaa, Cheque
  (editable list), each payment stored with its transfer reference.

## Feature scope

- Products with SKUs, optional variants (`group_name` + `variant_name`), categories,
  units, cost & sale prices, per-product GST rate.
- Stock levels with a **full audit trail** — every movement (sale, receive, return,
  stocktake correction, damage, void restock) records who-what-when and the balance after.
- Low-stock thresholds with dashboard alerts and a `stock.low` webhook.
- Invoices: draft → issued → partially paid → paid, plus void (with automatic restock).
  Issuing an invoice assigns the sequential number and deducts stock.
- Payments with method + reference; partial payments supported.
- Printable tax invoice (browser print → PDF), served standalone at
  `/api/v1/invoices/:id/html`.
- Customers with TIN, island/atoll; auto-created from incoming e-commerce orders.

## Quick start

```bash
cd fihaara
npm install
npm run build
npm start          # http://localhost:4646
```

Development (API on :4646, hot-reloading dashboard on :5173):

```bash
npm run dev
```

Configuration is via environment variables:

| Variable     | Default            | Meaning                          |
| ------------ | ------------------ | -------------------------------- |
| `PORT`       | `4646`             | HTTP port                        |
| `FIHAARA_DB` | `data/fihaara.db`  | SQLite file path                 |

First steps: open **Settings**, fill in your business name, TIN and GST TIN, check
the USD rate, then add products.

> Backup = copy the SQLite file. Moving to a new server = copy the folder + the DB file.

## Authentication

Out of the box the API is **open** — fine while everything runs on one machine.
Before exposing the server to a network, create an API key in **Settings → API keys**.
As soon as at least one key exists, *every* request must send it:

```
Authorization: Bearer fhr_xxxxxxxx...
```

(or `X-API-Key: fhr_...`). Keys are stored hashed; the plaintext is shown once at
creation. The dashboard will prompt you for a key and remember it in the browser.

## REST API

Base URL: `http://your-server:4646/api/v1`. All bodies are JSON. Monetary amounts
are decimals in the invoice currency (e.g. `120.50`).

### Order intake (the main e-commerce hook)

`POST /orders` — turn a store order into an issued invoice and deduct stock.
**Idempotent** on `external_ref`: replaying the same order (retries, duplicate
webhooks) returns the existing invoice instead of double-billing.

```json
{
  "external_ref": "SHOP-1001",
  "source": "shopify",
  "currency": "MVR",
  "customer": { "name": "Aishath Ali", "phone": "+960 7771234", "island": "Hulhumale'" },
  "lines": [
    { "sku": "TSHIRT-RED-L", "qty": 2 },
    { "sku": "MUG-CORAL", "qty": 1, "unit_price": 80.00 }
  ],
  "payment": { "method": "BML Transfer", "reference": "BML123456" }
}
```

- `lines[].sku` or `lines[].product_id` links a line to inventory (deducts stock and
  uses the product's price/GST rate unless overridden). Lines without a product
  reference need `description` + `unit_price`.
- `payment` is optional — include it when the order is already paid online; omit it
  for cash-on-delivery and record the payment later.
- Unknown customers are created automatically (matched on name + phone).

### Stock sync

- `GET /stock` — flat `{sku, name, qty, low_stock}` list, made for pushing stock
  levels back to your store.
- `POST /products/:id/adjust-stock` — `{"delta": 5, "reason": "receive"}` or
  `{"set": 12, "reason": "correction"}` (stocktake). Every call is logged.
- `GET /products/:id/movements` — the audit trail.

### Everything else

| Method & path | Purpose |
| --- | --- |
| `GET /health` | liveness check (never requires auth) |
| `GET/POST /products`, `GET/PUT/DELETE /products/:id` | product CRUD (delete = deactivate) |
| `GET/POST /customers`, `PUT/DELETE /customers/:id` | customer CRUD |
| `GET/POST /tax-rates`, `PUT /tax-rates/:id` | GST rates (label, %, default, active) |
| `GET/POST /invoices`, `GET /invoices/:id` | list/create/fetch invoices |
| `POST /invoices/:id/issue` | issue a draft (assigns number, deducts stock) |
| `POST /invoices/:id/void` | void + restock (blocked while payments exist) |
| `POST /invoices/:id/payments`, `DELETE /invoices/:id/payments/:paymentId` | record/remove payments |
| `GET /invoices/:id/html` | standalone printable tax invoice |
| `GET/PUT /settings` | business/MIRA details, currency rate, numbering, payment methods |
| `GET/POST/DELETE /api-keys` | API key management |
| `GET/POST/DELETE /webhooks`, `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries` | webhook management |
| `GET /reports/summary` | dashboard numbers (revenue, outstanding, stock value…) |
| `GET /reports/gst?from=YYYY-MM-DD&to=YYYY-MM-DD` | GST collected per rate, in MVR |

### Webhooks

Register a URL and the events you care about (`invoice.created`, `invoice.paid`,
`invoice.voided`, `stock.updated`, `stock.low`, or `*`). Deliveries are JSON:

```json
{ "event": "stock.low", "timestamp": "…", "data": { "product": { … } } }
```

Each request carries `X-Fihaara-Event` and `X-Fihaara-Signature: sha256=<hmac>` —
the HMAC-SHA256 of the raw body with your webhook secret. Verify it before trusting
the payload. The last 200 delivery attempts are inspectable via the API.

## Wiring up a store

The pattern is the same everywhere:

1. **Orders in** — from your platform's "order created/paid" webhook, POST the order
   to `/api/v1/orders` with the platform order id as `external_ref`.
2. **Stock out** — either poll `GET /stock` on a schedule and update your store's
   quantities, or subscribe to the `stock.updated` webhook and push on change.
3. Use one API key per store (Settings → API keys) so you can revoke them independently.

Example (WooCommerce → Fihaara, from a `woocommerce_order_status_processing` hook):

```php
wp_remote_post('https://your-server:4646/api/v1/orders', [
  'headers' => ['Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . FIHAARA_KEY],
  'body' => wp_json_encode([
    'external_ref' => 'WOO-' . $order->get_id(),
    'source' => 'woocommerce',
    'customer' => ['name' => $order->get_formatted_billing_full_name(), 'phone' => $order->get_billing_phone()],
    'lines' => array_map(fn($item) => ['sku' => $item->get_product()->get_sku(), 'qty' => $item->get_quantity()], $order->get_items()),
    'payment' => ['method' => 'Card', 'reference' => $order->get_transaction_id()],
  ]),
]);
```

## Layout

```text
server/          Express API — db.ts (schema), core.ts (business logic),
                 api.ts (routes), webhooks.ts, invoiceHtml.ts
web/             React dashboard (Vite)
scripts/dev.mjs  runs API + dashboard together in dev
data/            SQLite database (created on first run, not committed)
```

Requires Node.js ≥ 22.13 (uses the built-in `node:sqlite` — no native modules).

## Notes & limits

- Single-warehouse stock. Multi-location, suppliers/purchase orders and customer
  statements are natural next steps.
- GST rates are seeded per the GST Act as amended (8% general / 17% tourism as of
  July 2025) — **verify current rates with MIRA** and adjust in Settings.
- This tool records tax invoices and GST figures; it is not tax advice. Confirm your
  registration and filing obligations with MIRA.
