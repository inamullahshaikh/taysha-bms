"""Imports every model module so Alembic and the app see the full schema."""

from app import attachments, audit, company, customers, expenses, numbering, suppliers  # noqa: F401
from app.auth import access, models  # noqa: F401
from app.products import models as product_models  # noqa: F401
from app.orders import models as order_models  # noqa: F401
from app.documents import models as document_models  # noqa: F401
from app import reports  # noqa: F401
from app.inventory import models as inventory_models  # noqa: F401
from app.purchasing import models as purchasing_models  # noqa: F401
from app import notifications  # noqa: F401
from app import returns  # noqa: F401
from app.production import models as production_models  # noqa: F401
from app.integrations import shopify  # noqa: F401
from app import pos  # noqa: F401
from app import wholesale  # noqa: F401
from app import crm, marketing  # noqa: F401
from app.accounting import models as accounting_models  # noqa: F401
