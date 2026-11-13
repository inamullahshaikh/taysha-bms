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
}

# Table name -> feature that guards it (for record history and attachments)
ENTITY_FEATURE: dict[str, str] = {
    "users": "access_management",
    **{t: "settings" for t in ("company", "branches", "departments", "tax_rates", "units", "financial_periods",
                               "number_sequences", "sales_channels", "price_lists")},
    **{t: "products" for t in ("products", "product_categories", "product_prices", "bundle_components",
                               "product_units")},
    "product_costs": "product_costs",
}
