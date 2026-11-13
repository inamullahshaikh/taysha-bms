"""Catalogue of features and the actions that can be granted on each. Users get access per (feature, action).

Add a feature here when a module ships; the access-management UI reads this list.
Owners (users.is_owner) bypass all checks.
"""

V, C, E, A, AP, X = "view", "create", "edit", "archive", "approve", "export"
ALL_ACTIONS = (V, C, E, A, AP, X)
CRUD = (V, C, E, A, X)

FEATURES: dict[str, tuple[str, tuple[str, ...]]] = {
    "access_management": ("Users & access", (V, E, X)),
    "settings": ("Settings", (V, E)),
    "audit": ("Full audit log", (V, X)),
    "products": ("Products", CRUD),
    "product_prices": ("Change product prices", (E,)),
    "product_costs": ("Product costs & margins", (V, E)),
    "customers": ("Customers", CRUD),
    "suppliers": ("Suppliers", CRUD),
    "orders": ("Sales orders", (V, C, E, X)),
    "order_pricing": ("Change order prices & give discounts", (E,)),
    "order_payments": ("Customer payments & refunds", (V, C)),
    "discount_codes": ("Discount codes", CRUD),
    "invoices": ("Invoices & sales documents", (V, C, E, X)),
    "expenses": ("Expenses", (V, C, E, AP, X)),
    "inventory": ("Stock & warehouses", (V, C, E, AP, X)),
    "purchasing": ("Purchase requests & orders", (V, C, E, AP, X)),
    "supplier_bills": ("Supplier bills & payments", (V, C, E, X)),
    "returns": ("Returns & refunds", (V, C, E, X)),
    "complaints": ("Complaints", (V, C, E, X)),
    "recipes": ("Recipes & formulas (confidential)", (V, E, AP)),
    "production": ("Production", (V, C, E, X)),
    "quality": ("Quality & food safety", (V, C, E, X)),
    "pos": ("Point of sale & events", (V, C, E, X)),
    "distribution": ("Delivery routes & territories", (V, E)),
    "marketing": ("Marketing & campaigns", (V, E)),
}

# Table name -> feature that guards it (for record history and attachments)
ENTITY_FEATURE: dict[str, str] = {
    "users": "access_management",
    **{t: "settings" for t in ("company", "branches", "departments", "tax_rates", "units", "financial_periods",
                               "number_sequences", "sales_channels", "price_lists")},
    **{t: "products" for t in ("products", "product_categories", "product_prices", "bundle_components",
                               "product_units")},
    "product_costs": "product_costs",
    **{t: "customers" for t in ("customers", "customer_addresses", "customer_notes")},
    **{t: "suppliers" for t in ("suppliers", "supplier_contacts", "supplier_items")},
    "orders": "orders",
    "payments": "order_payments",
    "discount_codes": "discount_codes",
    "sales_documents": "invoices",
    "expenses": "expenses",
    **{t: "settings" for t in ("expense_categories", "cost_centres")},
    **{t: "inventory" for t in ("warehouses", "locations", "batches", "stock_transfers", "stock_counts",
                                "stock_movements", "stock_balances")},
    "shipments": "orders",
    **{t: "purchasing" for t in ("purchase_requests", "purchase_orders", "goods_receipts", "supplier_ratings")},
    **{t: "supplier_bills" for t in ("supplier_bills", "supplier_payments")},
    "returns": "returns",
    "complaints": "complaints",
    "recipes": "recipes",
    "production_orders": "production",
    **{t: "quality" for t in ("qc_templates", "qc_checks", "recalls", "food_safety_records")},
    **{t: "pos" for t in ("pos_events", "pos_sessions")},
    **{t: "distribution" for t in ("delivery_routes", "route_stops", "territories")},
    **{t: "orders" for t in ("recurring_orders", "sell_through")},
    **{t: "marketing" for t in ("campaigns", "influencers", "influencer_deals", "content_items")},
    **{t: "customers" for t in ("leads", "follow_ups", "segments")},
}
