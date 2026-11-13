# Frontend Plan: React

Tickets for the Taysha BMS frontend, in build order. Do them one at a time. Each feature ticket lists the backend ticket(s) it needs (**Needs**). The usual rhythm is: finish a `BE-` ticket, then its matching `FE-` ticket.

Feature list: [FEATURES_AND_TODO.md](FEATURES_AND_TODO.md) · Backend tickets: [BACKEND_PLAN.md](BACKEND_PLAN.md)

---

## Stack (defaults, change if you prefer)

| Concern | Choice |
|---|---|
| Build / language | Vite, React, TypeScript |
| Styling / components | Tailwind CSS + a small shared component kit (shadcn/ui is a good starting point) |
| Routing | React Router |
| Server data | TanStack Query (caching, loading/error states, refetch) |
| API types | Generated from FastAPI's OpenAPI schema with `openapi-typescript` |
| Charts | Recharts |
| Forms | Plain controlled forms + server validation errors; add react-hook-form only if forms get heavy |
| Tests | Vitest + React Testing Library for logic-heavy components; Playwright for the 6 core workflows later |

## Conventions (apply to every ticket)

- **Never calculate money, totals or stock in the browser.** Show what the API returns (use preview endpoints for live totals).
- **Gate everything with `can(feature, action)`** (from FE-006): nav items, routes, buttons, columns, widgets. The backend still enforces it.
- **Every list page** uses the shared data table (FE-009): server-side paging, sorting, filtering, search.
- **Every record page** shows its attachments (FE-011) and history (FE-012) where relevant.
- **Responsive**: works on desktop, tablet and phone. Stock counts, production and POS screens are designed tablet-first.
- **Simple first**: essentials visible, advanced fields in a collapsible section or detail tab.
- Archive instead of delete in the UI; confirmation dialogs for destructive or high-impact actions.

---

## Phase 1: Core Foundation

### Setup & platform

- [ ] **FE-001 · Project skeleton** · Needs: none
  - Vite + React + TypeScript + Tailwind, ESLint/Prettier, folder layout (`src/pages`, `src/components`, `src/api`, `src/lib`)
  - API base URL from env; dev proxy to the FastAPI server
  - **Done when:** `npm run dev` shows a page and `npm run build` succeeds

- [ ] **FE-002 · API client & types** · Needs: FE-001, BE-001
  - `fetch` wrapper with `credentials: 'include'`, standard error parsing (`{code, message, fields}`), 401 → redirect to login
  - TanStack Query provider; script to regenerate types from `/openapi.json`
  - **Done when:** a typed `useQuery` call to `/health` works

- [ ] **FE-003 · App shell & navigation** · Needs: FE-001
  - Layout: sidebar (collapsible, drawer on mobile), top bar (user menu, notifications slot), content area
  - React Router routes with lazy-loaded pages; 404 page
  - **Done when:** navigation works on desktop and phone widths

- [ ] **FE-004 · Shared component kit** · Needs: FE-001
  - Button, Input, Select, Textarea, Checkbox, DateInput / DateRange (native inputs), Modal, ConfirmDialog, Tabs, Badge/StatusPill, Toast, EmptyState, Spinner, Card
  - Money and quantity display formatters (from API strings, no float math)
  - **Done when:** all components used on a dev-only `/kit` page

- [ ] **FE-005 · Login & session** · Needs: FE-002, FE-003, BE-004
  - Login page, logout, change password; load `/auth/me` on start; protected routes; session-expired message
  - **Done when:** unauthenticated users always land on login and return to their page after logging in

- [ ] **FE-006 · Feature access gating** · Needs: FE-005, BE-005
  - Load `/auth/me/access`; `useCan()` hook / `can(feature, action)`; `<Can>` wrapper; route guard + "No access" page
  - Sidebar only shows features the user can view
  - **Done when:** a user with partial access sees only their features and cannot open others by URL

- [ ] **FE-007 · Users & access management** · Needs: FE-006, FE-009, BE-006
  - User list, create user, deactivate/reactivate
  - Access matrix per user: rows = features, columns = actions (view, create, edit, archive, approve, export); save; "copy access from…" picker
  - **Done when:** granting/revoking from the matrix takes effect on the target user's next request

- [ ] **FE-008 · Two-factor authentication** · Needs: FE-005, BE-007
  - Enable 2FA (QR code + verify), recovery codes, disable; second login step
  - **Done when:** a 2FA user is prompted for a code at login

- [ ] **FE-009 · Data table** · Needs: FE-004, BE-008
  - Server-side pagination, sorting, search, filter bar, column visibility, row click → detail, Export button (shown only with `export` access)
  - Filters stored in the URL so views can be shared/bookmarked
  - **Done when:** used on the users list with all features working

- [ ] **FE-010 · Form patterns** · Needs: FE-004
  - Form layout, field-level errors from API, unsaved-changes warning, save/cancel bar, line-items editor (reusable for orders, invoices, POs, BOMs)
  - **Done when:** a sample form shows server validation errors next to the right fields

- [ ] **FE-011 · Attachments component** · Needs: FE-004, BE-010
  - Upload (drag/drop + picker), list, download, version info, uploaded by/when
  - **Done when:** reusable on any record page by passing entity type + id

- [ ] **FE-012 · Record history panel** · Needs: FE-004, BE-003
  - Timeline of audit entries for a record (who, what changed, when; manual vs integration)
  - **Done when:** reusable on any record page

- [ ] **FE-013 · Settings screens** · Needs: FE-010, BE-011
  - Company profile (logo upload), branches, departments, currencies, tax rates, units & conversions, financial periods, numbering formats
  - **Done when:** all settings are editable by users with `settings` access

### Products

- [ ] **FE-014 · Product list** · Needs: FE-009, BE-012
  - Table with category/type/status filters, search by name/SKU/barcode, thumbnail
  - **Done when:** list, filter and export work

- [ ] **FE-015 · Product detail & edit** · Needs: FE-010, FE-011, BE-012, BE-013
  - Tabs: Overview, Variants, Bundle components, Images/Documents, History
  - **Done when:** products, variants and bundles can be created and edited

- [ ] **FE-016 · Pricing, costs & margins** · Needs: FE-015, BE-014, BE-015
  - Pricing tab: current prices per type, add new price (effective date), price history
  - Costs tab (only with `product_costs` access): cost breakdown, history, margin calculator at any selling price
  - **Done when:** users without cost access never see the Costs tab or margin columns

### Customers & suppliers

- [ ] **FE-017 · Customers** · Needs: FE-009, FE-010, BE-016
  - List with tag/type filters; detail with profile, addresses, tags, notes, stats (spend, AOV, last purchase), order history, history panel
  - **Done when:** customer CRUD and tags work; order history links to orders

- [ ] **FE-018 · Suppliers** · Needs: FE-009, FE-010, FE-011, BE-017
  - List and detail: contacts, payment terms, supplied items, documents
  - **Done when:** supplier CRUD and documents work

### Sales orders

- [ ] **FE-019 · Order list** · Needs: FE-009, BE-018, BE-022
  - Filters: date range, status, customer, product, channel, payment status; status pills; bulk select for printing
  - **Done when:** filters combine and export works

- [ ] **FE-020 · Create / edit order** · Needs: FE-010, FE-017, BE-018, BE-023
  - Customer picker (with quick-create), order type, channel, line items (product search by name/SKU/barcode), discounts, discount code, delivery charge, notes
  - Totals come from `/orders/preview` (debounced), not calculated locally
  - **Done when:** totals shown always equal the saved order's totals

- [ ] **FE-021 · Order detail & status actions** · Needs: FE-020, FE-011, FE-012, BE-019, BE-020, BE-021
  - Header with status and next-action buttons (only allowed transitions), payments panel (record payment), delivery panel (courier, tracking), notes, attachments, timeline
  - **Done when:** an order can go from Draft to Delivered with payment recorded, entirely from this page

- [ ] **FE-022 · Order printing** · Needs: FE-019, BE-024
  - Print order summary / packing slip from detail; dispatch list for selected orders from the list
  - **Done when:** PDFs open in a new tab ready to print

### Invoices & documents

- [ ] **FE-023 · Invoice list** · Needs: FE-009, BE-025
  - Filters by status, customer, date, overdue; search by number
  - **Done when:** list, filter and export work

- [ ] **FE-024 · Invoice create, issue & PDF** · Needs: FE-021, BE-025, BE-027
  - "Create invoice" from order; edit draft (addresses, tax lines, charges); Issue (confirm dialog, becomes read-only); PDF preview/download; email to customer
  - **Done when:** an issued invoice shows read-only with PDF and send options

- [ ] **FE-025 · Other documents** · Needs: FE-024, BE-026
  - Quotations (convert to order), pro-formas, receipts, credit notes (from invoice), debit notes, delivery challans
  - **Done when:** each document type can be created, viewed and printed

### Expenses

- [ ] **FE-026 · Expense categories & cost centres** · Needs: FE-013, BE-029
  - Managed inside Settings
  - **Done when:** categories/subcategories/cost centres are editable

- [ ] **FE-027 · Expenses & approvals** · Needs: FE-009, FE-011, BE-030
  - Submit expense (receipt upload, phone camera friendly), my expenses list, all expenses list
  - Approvals inbox for users with `expenses.approve`: approve / reject with note
  - **Done when:** the expense-approval workflow runs end to end from the UI

### Dashboard & reports

- [ ] **FE-028 · Dashboard** · Needs: FE-006, BE-031
  - Date range selector (Today, This Week, This Month, This Year, Custom) + comparison vs previous period
  - Compact KPI cards (clickable → filtered list), charts (sales trend, sales by channel/product), small tables (top products, overdue payments)
  - Widgets the user has no access to are not shown
  - **Done when:** numbers match the API and cards link to the right filtered lists

- [ ] **FE-029 · Customizable widgets** · Needs: FE-028, BE-032
  - Add/remove/reorder widgets; saved per user
  - **Done when:** layout persists across logins

- [ ] **FE-030 · Basic reports** · Needs: FE-009, BE-033
  - Sales, expense and P&L report pages with filters, charts and Excel/CSV/PDF export
  - **Done when:** each report exports what is on screen

---

## Phase 2: Inventory & Purchasing

- [ ] **FE-040 · Warehouses & locations** · Needs: FE-013, BE-040
  - Warehouse and shelf/location management; stock level settings (min, reorder, max, safety) per product per warehouse
  - **Done when:** levels are editable from the product page and warehouse page

- [ ] **FE-041 · Stock overview** · Needs: FE-009, BE-041, BE-042
  - Stock by product / warehouse / batch: on hand, reserved, available, in transit, expiry; low/out/over-stock badges
  - Product page gets a Stock tab
  - **Done when:** stock numbers match the API and filters work

- [ ] **FE-042 · Stock movement ledger** · Needs: FE-009, BE-041
  - Movement history with filters (product, warehouse, batch, reason, user, date); links to source documents
  - **Done when:** every movement links to the document that caused it

- [ ] **FE-043 · Stock operations** · Needs: FE-010, BE-043
  - Forms: receive, issue, transfer (send/receive in-transit), adjustment (reason required), damage, wastage
  - **Done when:** each operation updates the stock overview

- [ ] **FE-044 · Barcode scanning** · Needs: FE-004, BE-053
  - Scan input that works with USB/Bluetooth scanners (keyboard wedge) and phone camera (BarcodeDetector API where supported)
  - Wire into product search, stock operations and order line entry
  - **Done when:** scanning a barcode selects the right product/batch/location

- [ ] **FE-045 · Stock counts** · Needs: FE-044, BE-046
  - Tablet-first count screen: scan or pick item, enter counted qty; variance review; approve → adjustments
  - **Done when:** a full count can be done on a tablet and reconciled

- [ ] **FE-046 · Inventory valuation** · Needs: FE-030, BE-047
  - Valuation report by warehouse/type with export
  - **Done when:** report matches API totals

- [ ] **FE-047 · Purchase requests** · Needs: FE-009, FE-010, BE-048
  - Create request, approvals inbox, convert to PO
  - **Done when:** approval limits are respected in the UI

- [ ] **FE-048 · Purchase orders** · Needs: FE-047, BE-049
  - PO list/detail/edit with line items, status, PDF, send to supplier
  - **Done when:** PO status reflects receipts

- [ ] **FE-049 · Goods receipt** · Needs: FE-048, FE-044, BE-050
  - Receive against PO: qty received vs ordered, supplier batch, expiry, QC result, scan support
  - **Done when:** partial and full receipts update stock and PO status

- [ ] **FE-050 · Supplier bills & payments** · Needs: FE-048, BE-051, BE-052
  - Bills list (due/overdue), record payment, supplier balance; supplier page shows price history and rating
  - **Done when:** outstanding balances match the API

- [ ] **FE-051 · Labels** · Needs: FE-044, BE-053
  - Print product, batch, expiry and location labels (choose items + quantity)
  - **Done when:** label PDFs print correctly

- [ ] **FE-052 · Notifications** · Needs: FE-003, BE-054
  - Bell with unread count and dropdown, notifications page, mark read, preferences page (which alerts, in-app/email)
  - **Done when:** alerts appear and preferences are respected

- [ ] **FE-053 · Returns & refunds** · Needs: FE-021, BE-055
  - Start return from order; inspection and disposition; refund / credit note / replacement
  - **Done when:** the customer-return workflow runs end to end from the UI

- [ ] **FE-054 · Complaints** · Needs: FE-009, BE-056
  - Complaint register with owner, status, resolution; linked from customer and order pages
  - **Done when:** complaints can be logged, assigned and resolved

- [ ] **FE-055 · Receivables & payables** · Needs: FE-030, BE-057
  - AR/AP aging reports, payment allocation, customer statements (PDF/email)
  - **Done when:** statements can be generated and sent

- [ ] **FE-056 · Inventory & purchasing widgets** · Needs: FE-029, BE-058
  - **Done when:** new widgets are available in the dashboard picker

---

## Phase 3: Production & Quality

- [ ] **FE-060 · Recipes / BOM editor** · Needs: FE-010, BE-060
  - Ingredient and packaging lines, yield, standard cost; version list with diff view; approve to activate
  - Only visible with `recipes` access
  - **Done when:** editing creates a new version and older versions remain viewable

- [ ] **FE-061 · Production orders** · Needs: FE-060, BE-061
  - Create from product + qty or from suggestions; material requirements and shortages shown before release
  - **Done when:** shortages are visible before the order is started

- [ ] **FE-062 · Production run screen** · Needs: FE-061, BE-062
  - Tablet-first: stage tracker, assign staff, start/stop times, actual material used, output, wastage, rejected units
  - **Done when:** a run can be completed on a tablet and finished stock appears

- [ ] **FE-063 · Batches & costing** · Needs: FE-062, BE-063
  - Batch list/detail: dates, planned vs actual cost, yield, wastage
  - **Done when:** variance is visible per batch

- [ ] **FE-064 · Quality control** · Needs: FE-010, BE-064
  - Checklist templates, run a check (pass/fail, defects, corrective action), hold/release batch
  - **Done when:** a failed check visibly holds the batch

- [ ] **FE-065 · Traceability & recalls** · Needs: FE-063, BE-065
  - Trace view (supplier batch → production batch → orders) both directions; start recall; food-safety records
  - **Done when:** tracing a supplier batch lists every affected order

- [ ] **FE-066 · Production printing & widgets** · Needs: FE-062, BE-066, BE-067
  - Batch sheet, pick list, labels; production dashboard widgets
  - **Done when:** documents print and widgets show

---

## Phase 4: Integrations & Growth

- [ ] **FE-070 · Shopify settings & mapping** · Needs: FE-013, BE-070
  - Connect store, product/variant mapping screen (unmapped items highlighted)
  - **Done when:** every Shopify product can be mapped from the UI

- [ ] **FE-071 · Sync log** · Needs: FE-009, BE-073
  - Sync history, error details, retry button; fees/refunds reconciliation view
  - **Done when:** failed syncs can be retried from the UI

- [ ] **FE-072 · POS screen** · Needs: FE-044, BE-074
  - Touch-friendly: product grid/search/scan, cart, discounts, payment, receipt print
  - Event/stall + cashier session open/close with opening/closing counts; samples/comps buttons
  - Offline queue (sales stored locally and synced with their IDs) if feasible
  - **Done when:** a full event can be run from a tablet

- [ ] **FE-073 · Event reports** · Needs: FE-072, BE-074
  - Revenue, product mix, stock usage, expenses and variance per event
  - **Done when:** events can be compared side by side

- [ ] **FE-074 · Wholesale accounts** · Needs: FE-017, BE-075
  - Customer price lists, MOQ, credit terms, recurring orders, statements
  - **Done when:** recurring orders can be set up and viewed

- [ ] **FE-075 · Distribution** · Needs: FE-074, BE-076
  - Routes, dispatch runs, proof of delivery capture (phone camera/signature), territories and reps
  - **Done when:** a driver can capture POD on a phone

- [ ] **FE-076 · Marketing campaigns** · Needs: FE-009, BE-077
  - Campaign list/detail, spend and metrics entry, attributed orders, CAC/ROAS, comparison views
  - **Done when:** campaign performance is visible and comparable

- [ ] **FE-077 · Content calendar & influencers** · Needs: FE-076, BE-078
  - Calendar view, pipeline board (Idea → Published), creative assets, influencer tracking
  - **Done when:** content can be moved through the pipeline

- [ ] **FE-078 · CRM extras** · Needs: FE-017, BE-079
  - Leads, follow-up reminders, segments, inactive / due-for-repeat lists, loyalty and referrals
  - **Done when:** a segment can be built and exported

---

## Phase 5: Advanced Management

- [ ] **FE-080 · Budgets** · Needs: BE-080: budget setup, budget vs actual views
- [ ] **FE-081 · Financial statements** · Needs: BE-081: ledgers, balance sheet, cash flow, tax reports, adjustment entries
- [ ] **FE-082 · Partners & shareholders** · Needs: BE-082: profiles, contributions, distributions, decisions, ownership report
- [ ] **FE-083 · Tasks & projects** · Needs: BE-083: task list + board view, project pages, subtasks, comments, "My tasks"
- [ ] **FE-084 · Approvals inbox (unified)** · Needs: BE-084: one inbox for all approval types
- [ ] **FE-085 · Documents** · Needs: BE-085: folder/category browser, versions, expiry reminders, search
- [ ] **FE-086 · Assets & equipment** · Needs: BE-086: register, maintenance schedule, repair log
- [ ] **FE-087 · Advanced reports** · Needs: BE-087: comparisons, scheduled reports, custom saved views
- [ ] **FE-088 · Forecasting** · Needs: BE-088: demand forecast charts, suggested production/reorder quantities
- [ ] **FE-089 · R&D** · Needs: BE-089: ideas, experiments, test batches, trials, approve-to-production
- [ ] **FE-090 · Automation rules** · Needs: BE-090: create/edit simple automation rules
- [ ] **FE-091 · End-to-end tests** · Needs: all core flows: Playwright tests for the 6 workflows in [FEATURES_AND_TODO.md](FEATURES_AND_TODO.md#26-end-to-end-workflows-acceptance-checks)
