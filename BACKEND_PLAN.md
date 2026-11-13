# Backend Plan: FastAPI

Tickets for the Taysha BMS backend, in build order. Do them one at a time, top to bottom. Each ticket says what it needs first (**Needs**) and when it is finished (**Done when**).

Feature list: [FEATURES_AND_TODO.md](FEATURES_AND_TODO.md) · Frontend tickets: [FRONTEND_PLAN.md](FRONTEND_PLAN.md)

---

## Stack (defaults, change if you prefer)

| Concern | Choice |
|---|---|
| Language / framework | Python 3.12, FastAPI |
| Database | PostgreSQL 16 |
| ORM / migrations | SQLAlchemy 2.0 (sync), Alembic |
| Validation / config | Pydantic v2, pydantic-settings (`.env`) |
| Auth | Server-side sessions in DB, opaque token in httpOnly cookie; argon2 password hashing; `pyotp` for 2FA |
| PDFs | Jinja2 HTML templates + WeasyPrint |
| Excel export | openpyxl |
| Barcodes / QR | python-barcode, segno |
| Tests / lint | pytest + FastAPI TestClient, ruff |
| Run locally | docker compose (api + postgres) |

## Decisions

| Topic | Decision |
|---|---|
| Currency | PKR only (no multi-currency) |
| Tax | Selling prices are **tax-inclusive**; tax is extracted from line totals |
| Costing | Weighted average cost |
| Timezone | Asia/Karachi for "today / this month" |
| Git | One commit per ticket |

## Conventions (apply to every ticket)

- **Money** is `NUMERIC(14,2)` / `Decimal`, **quantities** `NUMERIC(14,3)`. Never float.
- **All totals, costs and stock math happen on the server.** The frontend only displays them.
- **Every endpoint checks access** with `require_access("feature", "action")` (from BE-005).
- **Every write that touches multiple tables runs in one DB transaction.**
- **Important writes go to the audit log** (from BE-003).
- **No hard deletes** on business records: use `archived_at`.
- **Issued documents and history are never updated in place**: new version or correcting document instead.
- **Stock only changes through stock movements** (from BE-041).
- Each ticket ships with its Alembic migration and at least one test covering the main path and one permission-denied case.

---

## Phase 1: Core Foundation

### Setup & platform

- [ ] **BE-001 · Project skeleton** · Needs: none
  - FastAPI app, folder layout (`app/api`, `app/models`, `app/schemas`, `app/services`), settings from `.env`
  - `docker-compose.yml` with Postgres, `Dockerfile` for the API
  - `GET /health`, pytest + ruff configured, README with run instructions
  - **Done when:** `docker compose up` serves `/health` and `pytest` passes

- [ ] **BE-002 · Database & base model** · Needs: BE-001
  - SQLAlchemy engine/session, Alembic set up
  - Base columns: `id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `archived_at`
  - Test DB fixture (transaction rolled back per test)
  - **Done when:** first migration runs and a test can write/read a row

- [ ] **BE-003 · Audit log** · Needs: BE-002
  - `audit_log` table: user, action, entity type, entity id, before/after JSON, source (`manual` / `integration` / `system`), IP, timestamp
  - `audit(...)` helper called inside the same transaction as the change
  - `GET /audit?entity_type=&entity_id=` (record history)
  - **Done when:** a test change produces a correct audit row; history endpoint returns it

- [ ] **BE-004 · Users & login** · Needs: BE-003
  - `users` table (name, email, password hash, is_active, is_owner)
  - `sessions` table (hashed token, expires_at, last_seen); httpOnly + Secure + SameSite cookie
  - `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
  - Idle and absolute session expiry; deactivating a user kills all their sessions
  - Login rate limiting; logins and failed logins written to audit log
  - CLI command to create the first owner account
  - **Done when:** login/logout works, expired or deactivated sessions get 401

- [ ] **BE-005 · Feature access model** · Needs: BE-004
  - Feature catalogue defined in code: list of `feature` keys (e.g. `orders`, `invoices`, `products`, `product_costs`, `access_management`) each with allowed actions (`view`, `create`, `edit`, `archive`, `approve`, `export`)
  - `user_access` table (user, feature, action)
  - `require_access(feature, action)` FastAPI dependency; owner bypasses
  - `GET /auth/me/access` returns the user's grants
  - **Done when:** an endpoint guarded by `require_access` returns 403 without the grant and 200 with it

- [ ] **BE-006 · Access management API** · Needs: BE-005
  - `GET /users`, `POST /users`, `PATCH /users/{id}`, `POST /users/{id}/deactivate`
  - `GET /users/{id}/access`, `PUT /users/{id}/access` (replace grants), `POST /users/{id}/access/copy-from/{other_id}`
  - `GET /access/features` (catalogue for the UI matrix)
  - All guarded by `access_management`; every grant/revoke audited
  - **Done when:** a manager can grant/revoke/copy access and it is reflected immediately

- [ ] **BE-007 · Two-factor authentication (optional per user)** · Needs: BE-004
  - TOTP setup (secret + QR URI), verify, disable; recovery codes
  - Login becomes two-step when 2FA is enabled
  - **Done when:** a user with 2FA cannot log in without a valid code

- [ ] **BE-008 · Shared API utilities** · Needs: BE-005
  - Pagination, sorting, filtering and text-search helpers for list endpoints
  - Standard error format (`{code, message, fields}`)
  - CSV/Excel export helper; requires `export` access and writes an audit row
  - **Done when:** used by one list endpoint with tests for paging, filter and export

- [ ] **BE-009 · Document numbering** · Needs: BE-002
  - `number_sequences` table per document type (prefix, next number, padding, yearly reset option)
  - `next_number(doc_type)` with row lock (safe under concurrency); unique constraint on every document number column
  - **Done when:** 50 concurrent calls in a test produce 50 unique, gap-free numbers

- [ ] **BE-010 · File attachments** · Needs: BE-005
  - Storage backend: local disk in dev, S3-compatible in prod (one interface, two impls)
  - `attachments` table linking a file to any record (entity type + id), uploaded_by, version
  - Upload (type and size validated), list, download (access checked against the parent record)
  - **Done when:** files upload, download, and are blocked for users without access to the parent record

- [ ] **BE-011 · Company settings & master data** · Needs: BE-005
  - Company profile (name, logo, address, tax numbers, contact), branches, departments
  - Currencies, tax rates, units of measure + conversion factors, financial periods
  - Numbering formats (edits BE-009 sequences)
  - **Done when:** all settings have CRUD endpoints guarded by `settings` access

### Products

- [ ] **BE-012 · Product categories & products** · Needs: BE-008
  - Categories; products with name, SKU (unique), barcode (unique), description, type (finished / raw / packaging / consumable / spare), unit, status, launch date
  - Images via attachments; archive instead of delete
  - **Done when:** CRUD + search/filter work; duplicate SKU/barcode rejected

- [ ] **BE-013 · Variants & bundles** · Needs: BE-012
  - Variants (own SKU/barcode), bundles/kits with component lines, samples/promo packs as product types
  - **Done when:** a bundle lists its components and quantities

- [ ] **BE-014 · Prices & price history** · Needs: BE-012
  - Price types (retail, wholesale, cafe, distributor, special); prices with `effective_from`. A new price creates a new row, old ones are kept
  - `GET /products/{id}/price?type=&date=` resolves the price in effect
  - Channel availability per product
  - **Done when:** changing a price keeps history and the resolver returns the correct price for any date

- [ ] **BE-015 · Product costs & margins** · Needs: BE-014
  - Cost breakdown (ingredients, packaging, labour, delivery, other) with history
  - Margin calculation endpoint for any selling price
  - Cost fields only returned to users with `product_costs` access
  - **Done when:** users without `product_costs` never see cost or margin fields

### Customers & suppliers

- [ ] **BE-016 · Customers** · Needs: BE-008
  - Profile: name, phone, email, type, multiple addresses, tags (New, Returning, VIP, Wholesale, Cafe, Corporate, custom), preferences, notes
  - Computed stats: total spend, order count, AOV, last purchase date
  - Customer list export guarded by `export` access
  - **Done when:** CRUD, tags, search and stats work

- [ ] **BE-017 · Suppliers** · Needs: BE-008, BE-010
  - Profile, contacts, addresses, payment terms, supplied items (link to products), documents via attachments
  - **Done when:** CRUD and supplied-items list work

### Sales orders

- [ ] **BE-018 · Sales orders (draft)** · Needs: BE-009, BE-014, BE-016
  - `orders` + `order_lines`; order number from BE-009; order type (retail, wholesale, corporate, cafe, stall, sample, promotional), channel, source
  - Server-side totals: line price (resolved from price list, overridable with access), line/order discounts, taxes, delivery charge
  - `POST /orders/preview` returns computed totals without saving (for the form)
  - Notes, internal comments, customer instructions; attachments
  - **Done when:** a draft order computes correct totals in tests with discounts and tax

- [ ] **BE-019 · Order status workflow** · Needs: BE-018
  - Statuses: Draft → Confirmed → Processing → Packed → Dispatched → Delivered; plus Cancelled, Returned, Refunded
  - Allowed-transition table; `order_status_history` (who, when, note)
  - **Done when:** illegal transitions return 409; every change is in history and audit

- [ ] **BE-020 · Order payments** · Needs: BE-019
  - Record payments (method, amount, date, reference); partial payments
  - Payment status derived: Unpaid, Partially Paid, Paid, COD Pending, Refunded, Failed
  - **Done when:** payment status updates correctly after each payment/refund

- [ ] **BE-021 · Delivery details** · Needs: BE-019
  - Courier, tracking number, dispatch date, delivery status on the order
  - **Done when:** dispatch requires courier info and is filterable

- [ ] **BE-022 · Order search & export** · Needs: BE-019
  - Filters: date, status, customer, product, channel, payment status; CSV/Excel export
  - **Done when:** filters combine correctly and export respects `export` access

- [ ] **BE-023 · Discount codes & promotions** · Needs: BE-018
  - Codes (percent / fixed, validity dates, usage limits), promotional pricing, bundle pricing
  - **Done when:** an expired or used-up code is rejected; valid code applies in preview and save

### Invoices & documents

- [ ] **BE-024 · PDF service + order prints** · Needs: BE-011, BE-019
  - Jinja2 + WeasyPrint render helper; base template with Taysha branding from company settings; A4 default
  - First templates: order summary, packing slip, dispatch list (multi-order)
  - **Done when:** the three order PDFs render with logo and company details

- [ ] **BE-025 · Invoices** · Needs: BE-019, BE-024
  - Create invoice from an order (lines and customer details snapshotted); editable billing/delivery address and tax info while Draft
  - Issue → number assigned, becomes immutable
  - Statuses: Draft, Issued, Partially Paid, Paid, Overdue, Cancelled, Credited
  - PDF download; searchable history
  - **Done when:** issued invoices cannot be edited (409) and PDFs match the data

- [ ] **BE-026 · Other sales documents** · Needs: BE-025
  - Quotation, pro-forma, receipt, credit note, debit note, delivery challan (shared document model with a `type`)
  - Quotation → order conversion; credit note against an invoice updates its status
  - **Done when:** each type numbers separately and renders its own PDF

- [ ] **BE-027 · Email documents** · Needs: BE-025
  - SMTP settings; send invoice/statement PDF to customer; log sent emails on the record
  - **Done when:** sending works against a test SMTP server and is logged

- [ ] **BE-028 · Scheduled jobs** · Needs: BE-025
  - One simple job runner (APScheduler in-process or cron calling a CLI command)
  - First job: mark unpaid invoices past due date as Overdue
  - **Done when:** the overdue job runs on schedule and is idempotent

### Expenses

- [ ] **BE-029 · Expense categories & cost centres** · Needs: BE-011
  - Categories, subcategories, departments, cost centres
  - **Done when:** CRUD with archive works

- [ ] **BE-030 · Expenses & approval** · Needs: BE-029, BE-010
  - Expense with amount, tax, date, category, cost centre, receipt attachment
  - Flow: Submitted → Approved / Rejected (needs `expenses.approve`); approval limits from settings
  - Approver cannot approve own expense
  - **Done when:** expenses above the limit cannot be approved without the right access

### Dashboard & reports

- [ ] **BE-031 · Dashboard metrics API (P1)** · Needs: BE-020, BE-030
  - Date range param (today, week, month, year, custom) + previous-period comparison
  - Sales & orders, profitability (using product costs), customers, expenses metrics
  - Each widget's data only returned if the user has access to that feature
  - **Done when:** numbers match a hand-calculated test dataset

- [ ] **BE-032 · Dashboard widget preferences** · Needs: BE-031
  - Per-user saved widget list and order
  - **Done when:** layout persists per user

- [ ] **BE-033 · Basic reports** · Needs: BE-031, BE-008
  - Sales report (by product, channel, customer, period), expense report, simple P&L
  - Export CSV / Excel / PDF
  - **Done when:** each report exports and totals match the dashboard

### Ops

- [ ] **BE-034 · Backups & restore** · Needs: BE-001
  - Scheduled `pg_dump` to off-server storage; documented restore; a script that restores into a scratch DB and runs a sanity check
  - **Done when:** a restore has been tested and documented

- [ ] **BE-035 · Deployment** · Needs: BE-034
  - Staging + production environments, migrations run on deploy, structured logging, error monitoring, HTTPS
  - **Done when:** staging deploy works from a single command / CI pipeline

---

## Phase 2: Inventory & Purchasing

- [ ] **BE-040 · Warehouses & locations** · Needs: BE-011
  - Warehouses, storage locations/shelves; min, reorder, max and safety stock per product per warehouse
  - **Done when:** CRUD works and levels are stored per warehouse

- [ ] **BE-041 · Stock movement ledger** · Needs: BE-040, BE-012
  - Append-only `stock_movements` (product, warehouse, location, batch, qty ±, unit, reason, reference doc, user, timestamp)
  - `stock_balances` updated **only** inside the same transaction as a movement (row lock); no other code path may change it
  - Unit conversion to base unit on write
  - **Done when:** balances always equal the sum of movements (tested), including concurrent writes

- [ ] **BE-042 · Batches & expiry** · Needs: BE-041
  - Batch/lot table (number, mfg date, expiry date, supplier batch no.); stock tracked per batch
  - **Done when:** stock can be queried by batch and by expiry window

- [ ] **BE-043 · Stock operations** · Needs: BE-042
  - Receive, issue, transfer (with in-transit state), adjustment (reason required), damage, wastage
  - **Done when:** each operation creates the correct movements and audit rows

- [ ] **BE-044 · Order stock reservation & fulfilment** · Needs: BE-043, BE-019
  - Confirm order reserves stock; cancel releases; dispatch issues stock (FEFO batch pick)
  - Available = on hand − reserved
  - **Done when:** reserved/available numbers are correct across confirm → cancel / dispatch

- [ ] **BE-045 · Partial fulfilment, split shipments, backorders** · Needs: BE-044
  - Shipments as children of an order; backorder lines when stock is short
  - **Done when:** an order can ship in two parts with correct stock and status

- [ ] **BE-046 · Stock counts** · Needs: BE-043
  - Count sessions, counted vs system quantity, approve → adjustment movements
  - **Done when:** an approved count reconciles balances

- [ ] **BE-047 · Inventory valuation** · Needs: BE-041
  - Weighted average cost updated on receipts (or FIFO layers if chosen); valuation report by warehouse/type
  - **Done when:** valuation matches a hand-calculated test scenario

- [ ] **BE-048 · Purchase requests** · Needs: BE-017
  - Request → approval (limits from settings) → convert to PO
  - **Done when:** requests above the limit need `purchasing.approve`

- [ ] **BE-049 · Purchase orders** · Needs: BE-048, BE-024
  - PO lines, statuses (Requested, Approved, Ordered, Partially Received, Received, Cancelled), PDF
  - **Done when:** status follows receipts automatically

- [ ] **BE-050 · Goods receipt** · Needs: BE-049, BE-043
  - Receive against PO (qty vs ordered), supplier batch no., expiry, QC result field → stock movements
  - **Done when:** receiving updates stock, batches and PO status in one transaction

- [ ] **BE-051 · Supplier bills & payments** · Needs: BE-050
  - Bills linked to POs/receipts, due dates, partial payments, outstanding balance, overdue job
  - **Done when:** AP balance per supplier is correct

- [ ] **BE-052 · Supplier price history & rating** · Needs: BE-050
  - Price per item per supplier over time from POs/price lists; price-change flags; rating (price, quality, delivery, reliability)
  - **Done when:** a price change between two POs is reported

- [ ] **BE-053 · Barcodes & labels** · Needs: BE-042, BE-024
  - Lookup by barcode (product, batch, location); generate internal barcodes/QR; label PDFs (product, batch, expiry, location)
  - **Done when:** scanning a barcode resolves to the right record; label PDFs print

- [ ] **BE-054 · Notifications & alerts** · Needs: BE-028, BE-045
  - `notifications` table (in-app), email delivery, per-user preferences
  - Jobs: low stock, out of stock, overstock, expiring/expired, overdue invoices/bills, pending approvals, delayed dispatch
  - **Done when:** each alert fires once per condition (no duplicates) and respects preferences

- [ ] **BE-055 · Returns & refunds** · Needs: BE-044, BE-026
  - Return request linked to order; reason, qty, condition, inspection; disposition (sellable / damaged / dispose) → stock movement
  - Full/partial refund, credit note, replacement/reshipment
  - **Done when:** the full customer-return workflow runs end to end

- [ ] **BE-056 · Complaints register** · Needs: BE-016
  - Complaint with owner, status, resolution, response time; link to order/batch
  - **Done when:** response time is calculated and reportable

- [ ] **BE-057 · Receivables & payables** · Needs: BE-051, BE-020
  - Customer and supplier payment allocation, aging reports (AR/AP), customer statements
  - **Done when:** aging buckets match a test dataset

- [ ] **BE-058 · Inventory dashboard & purchasing widgets** · Needs: BE-047, BE-051
  - Add inventory and purchasing metrics to the dashboard API
  - **Done when:** widgets return data with access checks

---

## Phase 3: Production & Quality

- [ ] **BE-060 · Recipes / BOM with versions** · Needs: BE-012
  - BOM lines (ingredient, qty, unit), packaging, expected yield, standard cost; versioned. Edits create a new version, approval sets the active one
  - `recipes` feature access separate (confidential formulas)
  - **Done when:** old production orders keep pointing at their original version

- [ ] **BE-061 · Production orders & material check** · Needs: BE-060, BE-042
  - Create from demand/stock levels; required materials computed; availability and shortages
  - **Done when:** shortages are listed correctly for a test BOM

- [ ] **BE-062 · Production execution** · Needs: BE-061
  - Reserve/issue materials (movements), stages (Mixing, Filling, Packing, Labelling, QC), staff assignment, start/end times
  - Output → new finished-goods batch (mfg/expiry), wastage, rejected units
  - **Done when:** a completed run issues materials and adds finished stock in one transaction

- [ ] **BE-063 · Batch costing & yield** · Needs: BE-062, BE-047
  - Planned vs actual cost per batch, yield %, wastage %, production time
  - **Done when:** variance is reported per batch

- [ ] **BE-064 · Quality control** · Needs: BE-050, BE-062
  - Checklist templates (incoming, production, finished), results (pass/fail, defects, corrective action, staff)
  - Batch holds: held stock cannot be issued/sold
  - **Done when:** a failed QC puts the batch on hold

- [ ] **BE-065 · Traceability & recalls** · Needs: BE-064, BE-044
  - Trace forward (supplier batch → production batches → orders/customers) and backward
  - Recall, disposal decisions; food-safety records (procedures, cleaning, inspections)
  - **Done when:** a trace query returns every affected order for a supplier batch

- [ ] **BE-066 · Production documents** · Needs: BE-062, BE-053
  - Batch sheet, ingredient pick list, production and finished-goods labels (PDF)
  - **Done when:** all four documents render

- [ ] **BE-067 · Production dashboard widgets** · Needs: BE-063
  - **Done when:** production metrics are in the dashboard API

---

## Phase 4: Integrations & Growth

- [ ] **BE-070 · Shopify connection & product mapping** · Needs: BE-013
  - Store credentials encrypted; map Shopify products/variants to internal products
  - **Done when:** mapping can be created and validated

- [ ] **BE-071 · Shopify order import** · Needs: BE-070, BE-044
  - Webhooks (HMAC verified) + polling fallback; idempotent by Shopify ID; creates customers and orders with source `integration`
  - **Done when:** replaying the same webhook never duplicates an order

- [ ] **BE-072 · Shopify stock & fulfilment sync** · Needs: BE-071
  - Push available stock; sync fulfilment status and tracking
  - **Done when:** a stock change updates Shopify within one sync cycle

- [ ] **BE-073 · Sync log & reconciliation** · Needs: BE-071
  - Sync log with errors + retry endpoint; Shopify fees, gateway fees and refunds recorded
  - **Done when:** a failed sync can be retried from the log

- [ ] **BE-074 · POS & events** · Needs: BE-044
  - Events/stalls, cashier sessions, quick-sale endpoint, receipts, opening/closing counts, samples/comps/wastage as separate movement reasons
  - Idempotent sale IDs (generated on the device) for offline sync
  - **Done when:** an event shows revenue, stock used and variance

- [ ] **BE-075 · Wholesale accounts** · Needs: BE-014, BE-057
  - Customer-specific price lists, MOQ, credit terms/limits, recurring orders (job), statements
  - **Done when:** a recurring order generates on schedule with customer pricing

- [ ] **BE-076 · Distribution** · Needs: BE-075
  - Delivery routes, proof of delivery (photo/signature attachment), territories, sales reps, sell-in/sell-through data
  - **Done when:** POD is attached to a delivered order

- [ ] **BE-077 · Marketing campaigns** · Needs: BE-023
  - Campaigns (platform, budget, spend, reach, impressions, clicks, leads, conversions), promo code attribution, CAC / ROAS / profitability
  - **Done when:** ROAS is computed from attributed orders

- [ ] **BE-078 · Content pipeline & influencers** · Needs: BE-077
  - Calendar items with pipeline status (Idea → Published), creative assets, influencer fees/samples/deliverables
  - **Done when:** content moves through statuses with history

- [ ] **BE-079 · CRM extras** · Needs: BE-016
  - Leads/prospects → convert to customer, follow-up reminders, segments, inactive / due-for-repeat lists, loyalty points, referral codes
  - **Done when:** segments filter customers correctly

---

## Phase 5: Advanced Management

- [ ] **BE-080 · Budgets** · Needs: BE-030: budgets per category/cost centre/period, spending limits, budget vs actual
- [ ] **BE-081 · Full accounting** · Needs: BE-057: general ledger, balance sheet, cash flow, tax reports (collected, paid, withholding), controlled adjustment entries with accountant review
- [ ] **BE-082 · Partners & shareholders** · Needs: BE-010: ownership %, contributions, loans, distributions, drawings, resolutions, votes; restricted feature access
- [ ] **BE-083 · Tasks & projects** · Needs: BE-054: tasks, subtasks, checklists, comments, assignees, projects, overdue tracking
- [ ] **BE-084 · Generic approval workflows** · Needs: BE-083: one approval engine for purchases, discounts, expenses, refunds, document changes (migrate BE-030/BE-048 onto it)
- [ ] **BE-085 · Document management** · Needs: BE-010: folders/categories, versions, expiry reminders, search by linked record
- [ ] **BE-086 · Assets & equipment** · Needs: BE-010: register, warranties, maintenance schedules, repairs/downtime, depreciation
- [ ] **BE-087 · Advanced reports** · Needs: BE-033: period/channel/location comparisons, scheduled emailed reports, saved custom report views, slow-moving and high-wastage reports
- [ ] **BE-088 · Forecasting** · Needs: BE-063: demand forecast from sales history (moving average / seasonal), suggested production and reorder quantities
- [ ] **BE-089 · R&D** · Needs: BE-060: ideas, experiments, test batches, shelf-life/packaging trials, approve recipe → becomes active BOM version
- [ ] **BE-090 · Workflow automation** · Needs: BE-084: rule-based automatic status updates, reminders and report delivery
