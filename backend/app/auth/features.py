"""Catalogue of features and the actions that can be granted on each. Users get access per (feature, action).

Add a feature here when a module ships; the access-management UI reads this list.
Owners (users.is_owner) bypass all checks.
"""

V, C, E, A, AP, X = "view", "create", "edit", "archive", "approve", "export"
ALL_ACTIONS = (V, C, E, A, AP, X)

FEATURES: dict[str, tuple[str, tuple[str, ...]]] = {
    "access_management": ("Users & access", (V, E)),
    "settings": ("Settings", (V, E)),
    "audit": ("Full audit log", (V, X)),
}

# Table name -> feature that guards it (for record history and attachments)
ENTITY_FEATURE: dict[str, str] = {
    "users": "access_management",
}

