import { PRODUCTS, type FieldDef } from '../../ui/Form'

export const TYPES = ['finished', 'raw', 'packaging', 'consumable', 'spare']
export const KINDS = ['standard', 'bundle', 'sample', 'promo']
export const STATUSES = ['draft', 'active', 'discontinued']

/** Essentials on create; the rest lives under "More details" on the product page. */
export const productFields: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'sku', label: 'SKU', required: true },
  { name: 'barcode', label: 'Barcode' },
  { name: 'type', label: 'Type', type: 'select', options: TYPES, required: true },
  { name: 'unit_id', label: 'Stock unit', type: 'lookup', lookup: 'units', required: true },
  { name: 'category_id', label: 'Category', type: 'lookup', lookup: 'product_categories' },
  { name: 'status', label: 'Status', type: 'select', options: STATUSES, required: true },
  { name: 'kind', label: 'Kind', type: 'select', options: KINDS, required: true, hint: 'Bundles are sold as a set of other items' },
  { name: 'tax_rate_id', label: 'Tax rate', type: 'lookup', lookup: 'tax_rates', hint: 'Empty uses the default rate' },
  { name: 'track_stock', label: 'Track stock', type: 'bool' },
  { name: 'track_batches', label: 'Track batches and expiry', type: 'bool' },
]

export const moreFields: FieldDef[] = [
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'shelf_life_days', label: 'Shelf life (days)', type: 'number' },
  { name: 'launch_date', label: 'Launch date', type: 'date' },
  { name: 'channels', label: 'Sold on', type: 'tags', hint: 'Channel codes, e.g. shopify, pos, wholesale' },
  { name: 'parent_id', label: 'Variant of', type: 'record', record: PRODUCTS },
  { name: 'packaging_spec', label: 'Packaging spec', type: 'textarea' },
  { name: 'label_info', label: 'Label information', type: 'textarea' },
]

export const productDefaults = { type: 'finished', kind: 'standard', status: 'active', track_stock: true }
