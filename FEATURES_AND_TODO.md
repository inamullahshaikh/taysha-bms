# Taysha Business Management System: Features & To-Do

One central internal system (BMS/ERP) for Taysha covering sales, orders, invoices, inventory, production, purchasing, customers, suppliers, expenses, marketing, employees, partners, documents and reporting. It must support **Muglicious today** and more products, channels, warehouses, branches and brands later.

> **How to use this file**
> - `[ ]` = to do, `[x]` = done. Tick items as they ship.
> - Each module is tagged with its suggested roadmap phase (**P1–P5**). Some modules span phases; items inside are tagged where they differ.
> - This is the wishlist and blueprint. Do not build everything at once (see [Roadmap](#roadmap)).

---

## Table of Contents

- [0. Before Development (Planning Tasks)](#0-before-development-planning-tasks)
- [Ground Rules (Apply to Every Module)](#ground-rules-apply-to-every-module)
- [Technical Foundation](#technical-foundation)
- [Roadmap](#roadmap)
- [1. Users, Feature Access & Security](#1-users-feature-access--security--p1)
- [2. Settings & System Administration](#2-settings--system-administration--p1-grows-each-phase)
- [3. Main Dashboard](#3-main-dashboard--p1-widgets-added-per-phase)
- [4. Product & Pricing Management](#4-product--pricing-management--p1)
- [5. Customer Relationship Management (CRM)](#5-customer-relationship-management-crm--p1)
- [6. Sales & Order Management](#6-sales--order-management--p1)
- [7. Invoice & Document Generation](#7-invoice--document-generation--p1)
- [8. Accounting & Financial Records](#8-accounting--financial-records--p1-expenses-p5-budgets)
- [9. Inventory & Warehouse Management](#9-inventory--warehouse-management--p2)
- [10. Purchasing & Supplier Management](#10-purchasing--supplier-management--p1-suppliers-p2-purchasing)
- [11. Barcode & Label Management](#11-barcode--label-management--p2)
- [12. Notifications & Alerts](#12-notifications--alerts--p2-expands-later)
- [13. Returns, Refunds & Complaints](#13-returns-refunds--complaints--p2)
- [14. Manufacturing & Production](#14-manufacturing--production--p3)
- [15. Quality Control & Food Safety](#15-quality-control--food-safety--p3)
- [16. Shopify & E-commerce Integration](#16-shopify--e-commerce-integration--p4)
- [17. POS, Stalls & Offline Sales](#17-pos-stalls--offline-sales--p4)
- [18. Wholesale, Cafes & Distribution](#18-wholesale-cafes--distribution--p4)
- [19. Marketing & Advertising Management](#19-marketing--advertising-management--p4)
- [20. Partner & Shareholder Management](#20-partner--shareholder-management--p5)
- [21. Tasks, Projects & Internal Communication](#21-tasks-projects--internal-communication--p5)
- [22. Document & File Management](#22-document--file-management--p5)
- [23. Assets & Equipment Management](#23-assets--equipment-management--p5)
- [24. Reports, Analytics & Forecasting](#24-reports-analytics--forecasting--p1-basic-p5-advanced)
- [25. Research & Development (R&D)](#25-research--development-rd--p5)
- [26. End-to-End Workflows (Acceptance Checks)](#26-end-to-end-workflows-acceptance-checks)

> **Out of scope:** AI assistant / AI features, and employee/HR management (attendance, leave, payroll, etc.).

---

## 0. Before Development (Planning Tasks)

For **each module**, before building it:

- [ ] Define screens (list, detail, create/edit, reports)
- [ ] Define database tables and relationships
- [ ] Define user permissions (who can view / create / edit / approve / export)
- [ ] Define workflows and status transitions
- [ ] Define validations (required fields, uniqueness, limits)
- [ ] Write acceptance tests

Project-level:

- [ ] Confirm Phase 1 scope with management
- [ ] Design the core database schema (orders, stock movements, batches, invoices, payments) so later modules connect without a rebuild
- [ ] Design the per-user access model up front (feature/action/record/field grants, no fixed roles)
- [ ] Decide inventory costing method (weighted average or FIFO)
- [ ] Decide tax setup, currencies and numbering rules
- [ ] Set up staging and production environments
- [ ] Set up backups and test a restore

---

## Ground Rules (Apply to Every Module)

- [ ] One central database; one source of truth for each business record
- [ ] Unique ID for every order, invoice, purchase order, production batch and stock movement
- [ ] Never update inventory silently: every stock change creates a traceable stock movement
- [ ] Never overwrite historical recipes, costs, prices or issued documents; keep versions and history
- [ ] Financial and inventory calculations run on the server, not only in the browser
- [ ] Database transactions for any operation that touches multiple records
- [ ] Idempotency and unique external IDs to prevent duplicate imports and repeated webhook events
- [ ] Record who performed each important action and when
- [ ] Enforce permissions on the backend, not just by hiding buttons
- [ ] Provide exports and backups, and prove backups restore
- [ ] Design for future products, locations, channels, brands and users; nothing hardcoded to one product
- [ ] Keep the UI simple: essentials first, advanced controls in detail views
- [ ] Soft-delete or archive important records instead of permanently deleting them

---

## Technical Foundation

- [ ] Responsive web app (desktop, tablet, mobile)
- [ ] Frontend: React (Vite + TypeScript) + Tailwind CSS (consistent component system), see [FRONTEND_PLAN.md](FRONTEND_PLAN.md)
- [ ] Database: PostgreSQL with clear relationships
- [ ] Backend: FastAPI (Python) with secure server-side business logic and REST APIs, see [BACKEND_PLAN.md](BACKEND_PLAN.md)
- [ ] Auth: individual accounts, per-user feature access, optional 2FA
- [ ] Secure file storage (invoices, receipts, images, documents)
- [ ] Server-side PDF generation (invoices, reports)
- [ ] Charting library with downloadable reports
- [ ] Managed hosting with backups, monitoring and a staging environment
- [ ] Integrations: Shopify first, then courier, payment, accounting and marketing as needed

---

## Roadmap

| Phase | Focus | Modules |
|---|---|---|
| **P1: Core foundation** | Daily essentials | Login & permissions, settings, dashboard, products, customers, suppliers, sales orders, invoice printing, expenses, basic reports |
| **P2: Inventory & purchasing** | Stock control | Warehouses, stock ledger, purchase orders, receiving, stock alerts, barcodes, supplier bills, returns |
| **P3: Production** | Making product | Recipes/BOM, production planning, batch tracking, expiry dates, material usage, wastage, quality checks |
| **P4: Integrations & growth** | Channels | Shopify sync, POS/stall sales, courier tracking, wholesale accounts, marketing performance |
| **P5: Advanced management** | Running the company | Partners, budgets, tasks, documents, assets, advanced analytics, forecasting, workflow automation, R&D |

**Priority:** start with what Taysha uses every day: products, orders, invoices, inventory, purchases, production, expenses and reports. Build the database and permissions properly from day one.

---

## 1. Users, Feature Access & Security · `P1`

No fixed roles. Each account is granted access to individual features, and access can be granted or revoked per person at any time.

- [ ] Individual user accounts (no shared logins)
- [ ] Per-user feature access: grant each account access to specific modules/features
- [ ] Per-feature actions granted separately: view, create, edit, archive, approve, export
- [ ] Access to sensitive fields and records granted separately (e.g. costs, margins, partner/ownership data, confidential formulas)
- [ ] Access management screen: see who has access to what, grant and revoke per person
- [ ] Only accounts with the "manage access" permission can grant or revoke access
- [ ] Copy access from an existing user when setting up a new account
- [ ] Menus, dashboard widgets and buttons only show features the user has access to
- [ ] Access checked on the backend for every request, not just hidden in the UI
- [ ] Every access grant/revoke recorded in the audit log (who, to whom, what, when)
- [ ] Approval required for selected high-impact actions
- [ ] Audit log: logins, edits, deletions, exports, approvals, important actions
- [ ] Secure authentication + optional two-factor authentication
- [ ] Automatic session expiry
- [ ] Account deactivation when staff leave
- [ ] Regular backups + tested restore procedure
- [ ] Soft-delete / archive for important records

## 2. Settings & System Administration · `P1, grows each phase`

- [ ] Company details, branches, warehouses, departments, financial periods
- [ ] Invoice formats and numbering rules
- [ ] Units, tax settings, currencies
- [ ] Configurable order statuses
- [ ] Approval limits, notification rules, stock policies
- [ ] Integrations, API credentials and webhook health (stored securely)
- [ ] Import / export of approved data
- [ ] Backups, system logs, error reports, maintenance notices
- [ ] Multi-brand, multi-company, multi-warehouse, multi-location support

## 3. Main Dashboard · `P1, widgets added per phase`

**Design**
- [ ] Clean overview, not every metric as a big card
- [ ] Clickable cards, charts, tables
- [ ] Customizable widgets (users choose what they see)
- [ ] Date filter: Today, This Week, This Month, This Year, Custom Range

**Sales & orders** `P1`
- [ ] Sales: today, yesterday, weekly, monthly, yearly
- [ ] Total revenue, net sales, order count, average order value
- [ ] Orders by status: pending, processing, completed, cancelled, returned
- [ ] Sales growth vs previous period
- [ ] Sales by product, channel, location, order source

**Profitability** `P1`
- [ ] Gross profit, net profit
- [ ] Gross margin %, net margin %
- [ ] COGS
- [ ] Discounts, refunds, tax collected
- [ ] Profitability by product, order, sales channel

**Inventory** `P2`
- [ ] Total products, total stock quantity
- [ ] Inventory valuation
- [ ] Low-stock and out-of-stock alerts
- [ ] Overstocked items, reserved stock, stock in transit
- [ ] Expiring, expired, damaged and rejected stock
- [ ] Raw-material and packaging availability
- [ ] Inventory turnover

**Production** `P3`
- [ ] Production completed this month
- [ ] Active, pending, completed production orders
- [ ] Production efficiency and wastage
- [ ] Rejected units, average production cost
- [ ] Upcoming production schedule

**Customers** `P1`
- [ ] Total, new and returning customers
- [ ] VIP customers, customer retention
- [ ] Average customer lifetime value
- [ ] Outstanding and overdue customer payments

**Purchasing & suppliers** `P2`
- [ ] Total and active suppliers
- [ ] Purchases this month
- [ ] Pending purchase orders and supplier deliveries
- [ ] Outstanding and overdue supplier payments
- [ ] Supplier price changes

**Expenses** `P1`
- [ ] Expenses today, this month, this year
- [ ] Top expense categories, expense growth
- [ ] Pending expense approvals
- [ ] Budget vs actual `P5`

**Marketing** `P4`
- [ ] Marketing and ad spend
- [ ] Total and active campaigns
- [ ] Leads generated, orders attributed to marketing
- [ ] CAC, ROAS, marketing revenue

**Tasks & operations** `P5`
- [ ] Pending, overdue, completed tasks
- [ ] Upcoming deadlines

**Management & analytics** `P5`
- [ ] Shareholders and capital invested
- [ ] Pending approvals, upcoming meetings
- [ ] Upcoming payments, document expirations
- [ ] Important notifications, recent business activity
- [ ] Best-selling, least-selling, most-profitable, weakest products
- [ ] Best-performing sales channel
- [ ] Monthly revenue, profit and expense trends
- [ ] Sales and production forecasts

## 4. Product & Pricing Management · `P1`

- [ ] Product name, SKU, barcode, description, images, category
- [ ] Variants, bundles, kits, samples, promotional packs
- [ ] Prices: retail, wholesale, cafe, distributor, special customer
- [ ] Product cost breakdown
- [ ] Pricing history (never overwritten)
- [ ] Margin calculator at different selling prices
- [ ] Launch date, status, availability by channel
- [ ] Product performance tracking
- [ ] Discontinue / archive without losing history
- [ ] Product labels, packaging specs, product documents

## 5. Customer Relationship Management (CRM) · `P1`

- [ ] Customer profile: name, phone, email, addresses, customer type
- [ ] Order history, total spend, average order value, last purchase date
- [ ] Tags: New, Returning, VIP, Wholesale, Cafe, Corporate, custom
- [ ] Preferences, notes, complaints, communication history
- [ ] Leads and prospects (pre-customer) `P4`
- [ ] Follow-up reminders and customer segments
- [ ] Identify inactive customers and customers due for repeat purchase
- [ ] Loyalty points, referral codes, coupons, customer-specific pricing `P4`
- [ ] Export customer lists with permission controls and privacy safeguards

## 6. Sales & Order Management · `P1`

- [ ] Create orders manually
- [ ] Import orders from Shopify / connected channels `P4`
- [ ] Unique order number
- [ ] Record: order date, customer, items, quantities, prices, discounts, taxes, delivery charges, payment method
- [ ] Order statuses: Draft, Confirmed, Processing, Packed, Dispatched, Delivered, Cancelled, Returned, Refunded
- [ ] Order types: retail, wholesale, corporate, cafe, stall, sample, promotional
- [ ] Order notes, internal comments, attachments, customer instructions
- [ ] Partial fulfilments, split shipments, backorders
- [ ] Delivery company, tracking number, dispatch date, delivery status
- [ ] Payment status: Unpaid, Partially Paid, Paid, COD Pending, Refunded, Failed
- [ ] Discount codes, manual discounts, bundles, promotional pricing
- [ ] Search and filter by date, status, customer, product, channel, payment status
- [ ] Print / export order summaries, packing slips, dispatch lists

## 7. Invoice & Document Generation · `P1`

- [ ] Branded Taysha invoices with automatic invoice numbers
- [ ] Quotations, pro-forma invoices, receipts, credit notes, debit notes, delivery challans
- [ ] Editable customer details, billing address, delivery address, tax info
- [ ] Add/remove tax lines, discounts, delivery charges, other charges
- [ ] PDF generation; print A4 and other formats
- [ ] Invoice templates (logo, colors, address, contact details)
- [ ] Create invoice directly from an order
- [ ] Prevent duplicate invoice numbers (DB constraint)
- [ ] Invoice status: Draft, Issued, Partially Paid, Paid, Overdue, Cancelled, Credited
- [ ] Email / share invoices and statements with customers
- [ ] Searchable history of every issued document
- [ ] Issued documents are never edited in place (use credit/debit notes)

## 8. Accounting & Financial Records · `P1 expenses, P5 budgets`

- [ ] Record income, expenses, purchases, sales, refunds, adjustments
- [ ] Expense categories, subcategories, departments, cost centres
- [ ] Expense submission with receipt attachment and approval
- [ ] Accounts receivable and accounts payable
- [ ] Customer payments, supplier payments, payment allocations
- [ ] Sales, purchase, expense and general ledgers
- [ ] Profit & loss statement for any period
- [ ] Balance sheet and cash-flow reports (where accounting setup supports)
- [ ] Tax collected, tax paid, withholding tax, other tax entries
- [ ] Budgets, spending limits, budget-vs-actual reports `P5`
- [ ] Cost components: product, packaging, labour, delivery, other
- [ ] Product-level gross margin and contribution margin
- [ ] Accountant review and controlled adjustment entries
- [ ] Full audit trail for financial changes

## 9. Inventory & Warehouse Management · `P2`

- [ ] Separate records: finished goods, raw materials, packaging, consumables, spare parts
- [ ] Track stock by warehouse, location, shelf, batch, expiry date
- [ ] Movements: received, issued, transfers, adjustments, returns, damage, wastage
- [ ] Barcode / QR scanning for products, materials, batches, locations
- [ ] Min stock, reorder point, max stock, safety stock
- [ ] Alerts: low stock, out of stock, overstock, expiry
- [ ] Reserve stock for confirmed orders; release on cancellation
- [ ] Stock in transit between locations
- [ ] Stock movement ledger (date, quantity, reason, responsible user)
- [ ] Physical stock counts and reconciliation against system quantities
- [ ] Unit conversions: g, kg, ml, L, pieces, cartons
- [ ] Inventory valuation by chosen costing method (weighted average / FIFO)

## 10. Purchasing & Supplier Management · `P1 suppliers, P2 purchasing`

- [ ] Supplier profiles: contacts, addresses, payment terms, supplied items `P1`
- [ ] Store supplier quotations, price lists, invoices, agreements
- [ ] Purchase requests and purchase orders
- [ ] Approval limits; approval required where configured
- [ ] PO status: Requested, Approved, Ordered, Partially Received, Received, Cancelled
- [ ] Goods received, compared with PO quantities
- [ ] Record supplier batch numbers, expiry dates, quality results
- [ ] Supplier bills, due dates, partial payments, outstanding amounts
- [ ] Supplier price history and price-change detection
- [ ] Supplier rating: price, quality, delivery time, reliability

## 11. Barcode & Label Management · `P2`

- [ ] Store product barcodes (e.g. EAN-13) against the correct SKU and variant
- [ ] Generate internal barcodes / QR codes for batches, shelves, documents
- [ ] Print product, batch, expiry and warehouse location labels
- [ ] Scanning for receiving, picking, stock counts, POS
- [ ] Enforce barcode uniqueness (no barcode on multiple products)

## 12. Notifications & Alerts · `P2, expands later`

- [ ] Low-stock and reorder alerts
- [ ] Expiring and expired stock alerts
- [ ] Pending orders, delayed dispatches, failed deliveries
- [ ] Overdue customer invoices and supplier bills
- [ ] Pending approvals, overdue tasks, upcoming deadlines
- [ ] Failed Shopify / integration syncs
- [ ] Unusual wastage, stock adjustments, repeated order issues
- [ ] User preferences: which alerts and which channel (in-app, email, etc.)

## 13. Returns, Refunds & Complaints · `P2`

- [ ] Return requests linked to the original order
- [ ] Return reason, quantity, condition, inspection result
- [ ] Stock disposition: sellable, damaged, dispose
- [ ] Full or partial refunds; issue credit notes
- [ ] Replacements, reshipments, customer compensation
- [ ] Complaint register: owner, status, resolution, response time
- [ ] Reports: return rate, refund rate, common complaint reasons

## 14. Manufacturing & Production · `P3`

- [ ] Recipes / Bills of Materials (BOM) for every manufactured product
- [ ] Ingredient quantities, packaging requirements, expected yield, standard cost
- [ ] Production plans and production orders (from demand or stock levels)
- [ ] Auto-calculate required raw materials before production
- [ ] Check material availability and flag shortages
- [ ] Record actual quantities used, output, wastage, rejected units
- [ ] Production stages: Mixing, Filling, Packing, Labelling, Quality Check
- [ ] Assign jobs to staff; record start/end times
- [ ] Batch / lot number for every production run
- [ ] Manufacturing date, best-before/expiry date, batch notes
- [ ] Planned vs actual cost per batch
- [ ] Yield, wastage %, production time, labour usage
- [ ] Recipe version history (old production records keep their recipe version)
- [ ] Print batch sheets, ingredient pick lists, production labels, finished-goods labels

## 15. Quality Control & Food Safety · `P3`

- [ ] QC checklists: incoming materials, production, finished products
- [ ] Checks: weight, appearance, packaging seal, label accuracy, condition
- [ ] Pass/fail, defects, corrective actions, responsible staff
- [ ] Link supplier batch numbers to finished-product batches
- [ ] Full traceability: supplier material → production batch → customer order
- [ ] Complaints, recalls, product holds, disposal decisions
- [ ] Food-safety procedures, cleaning schedules, inspection records
- [ ] Expiry alerts for ingredients, packaging, finished products

## 16. Shopify & E-commerce Integration · `P4`

- [ ] Sync orders, products, customers, discounts, fulfilment status
- [ ] Stock sync to reduce overselling
- [ ] Map Shopify products/variants to internal products
- [ ] Sync tracking details and fulfilment updates
- [ ] Record Shopify fees, gateway fees, refunds for reconciliation
- [ ] Failed-sync log with retry
- [ ] Unique external IDs + idempotent webhooks (no duplicate orders/customers)
- [ ] Audit history distinguishes manual edits from integration updates

## 17. POS, Stalls & Offline Sales · `P4`

- [ ] Simple POS screen for stalls, pop-ups, direct sales
- [ ] Quick product selection, quantities, discounts, receipt printing
- [ ] Sales by event, stall, branch, cashier, date
- [ ] Opening and closing stock count per event
- [ ] Samples, complimentary items, wastage, event consumption tracked separately from sales
- [ ] Offline order capture with later sync (if feasible)
- [ ] Compare event revenue, product mix, stock usage, event expenses

## 18. Wholesale, Cafes & Distribution · `P4`

- [ ] Wholesale, cafe, retailer and distributor accounts
- [ ] Customer-specific price lists, minimum order quantities, credit terms
- [ ] Recurring / scheduled orders
- [ ] Delivery routes, dispatches, proof of delivery, outstanding invoices
- [ ] Distributor territories and assigned sales reps
- [ ] Sell-in, sell-through and returns (where customers share data)
- [ ] Customer statements and wholesale sales reports

## 19. Marketing & Advertising Management · `P4`

- [ ] Calendar: campaigns, launches, promotions, content
- [ ] Record Meta Ads, Google Ads, influencer, event, offline activity
- [ ] Budget, spend, reach, impressions, clicks, leads, conversions
- [ ] Attributed orders, revenue, CAC, ROAS, campaign profitability
- [ ] Creative assets, captions, links, audience details, notes
- [ ] Compare performance by date, platform, product, audience
- [ ] Influencer fees, samples, deliverables, posting dates
- [ ] Promo codes and their sales impact
- [ ] Content pipeline: Idea, Planned, In Production, Approved, Scheduled, Published

## 20. Partner & Shareholder Management · `P5`

- [ ] Partner/shareholder profiles and approved ownership %
- [ ] Capital contributions, additional investments, agreed loans
- [ ] Profit distributions, drawings, approved reimbursements
- [ ] Partnership agreements, resolutions, meeting minutes
- [ ] Voting rights, approvals and decisions
- [ ] Ownership and contribution reports (verified records only)
- [ ] Restricted to authorized users

## 21. Tasks, Projects & Internal Communication · `P5`

- [ ] Tasks: title, description, priority, assignee, due date, status
- [ ] Assign to individuals, teams or departments
- [ ] Projects: launches, campaigns, events, product development, operations
- [ ] Checklists, subtasks, comments, attachments, activity history
- [ ] Overdue tasks, blockers, upcoming deadlines
- [ ] Approval workflows: purchases, discounts, expenses, refunds, document changes
- [ ] Internal notifications and reminders

## 22. Document & File Management · `P5`

- [ ] Store supplier docs, invoices, contracts, recipes, designs, certificates, policies
- [ ] Organize by department, product, supplier, campaign, project
- [ ] Version history; record who uploaded or changed each file
- [ ] Expiry reminders for licenses, contracts, certificates
- [ ] Access permissions for confidential files
- [ ] Search by filename, category, date, linked business record

## 23. Assets & Equipment Management · `P5`

- [ ] Register: equipment, furniture, computers, appliances, other assets
- [ ] Purchase date, supplier, cost, serial number, location, assigned person
- [ ] Warranties, maintenance schedules, service history
- [ ] Repairs, downtime, replacement decisions
- [ ] Depreciation (if in accounting setup)

## 24. Reports, Analytics & Forecasting · `P1 basic, P5 advanced`

- [ ] Reports: sales, profit, products, customers, inventory, production, purchasing, expenses `P1+`
- [ ] Compare periods, channels, locations, products, customer groups
- [ ] Trend charts; export to Excel, CSV, PDF
- [ ] Scheduled reports for management `P5`
- [ ] Demand forecasting and suggested production quantities `P5`
- [ ] Identify slow-moving stock, high-wastage products, changing costs `P5`
- [ ] Custom report builder and saved views for authorized users `P5`

## 25. Research & Development (R&D) · `P5`

- [ ] Product ideas, experiments, test batches
- [ ] Recipe versions, ingredient changes, test results, feedback
- [ ] Compare ingredient costs and performance across versions
- [ ] Packaging trials, shelf-life tests, storage observations
- [ ] Approval step before a recipe/spec becomes the active production version
- [ ] Confidential formulas and files permission-controlled

---

## 26. End-to-End Workflows (Acceptance Checks)

Each workflow must run end to end with every step linked and traceable.

- [ ] **Order to delivery:** Order received → stock checked/reserved → invoice generated → packed → dispatched → delivered → payment/settlement recorded
- [ ] **Purchase to stock:** Purchase request → approval → PO → goods received → quality check → stock updated → supplier bill recorded
- [ ] **Production to finished goods:** Demand identified → production order → materials reserved/issued → batch produced → quality approved → finished stock added
- [ ] **Customer return:** Return requested → original order checked → goods inspected → stock disposition decided → refund/replacement processed
- [ ] **Marketing to sale:** Campaign created → spend recorded → leads/orders attributed → revenue and performance measured
- [ ] **Expense approval:** Expense submitted → receipt attached → manager approval → accounting record created → reports updated
