/**
 * Inventory table columns. `on` = shown by default; users pick their own
 * set with the Columns chooser (saved per person in people.ui_prefs).
 * `field` = the row property; `type` drives sorting (text / number / date);
 * `filter` = how the header filter works — 'list' (tick values, like Excel)
 * or 'range' (min / max). Plain data — shared by the server page and the
 * client table.
 */

export const STATUS_LABELS = { in_stock: 'In stock', partly_sold: 'Partly sold', sold: 'Sold' };

export const COLUMN_GROUPS = [
  {
    label: 'Lot',
    columns: [
      { key: 'image', label: 'Photo', on: true, locked: true },
      { key: 'code', label: 'Code', on: true, locked: true, field: 'item_code', type: 'text' },
      { key: 'name', label: 'Name', on: false, field: 'item_name', type: 'text' },
      { key: 'variety', label: 'Variety', on: true, field: 'gem_type', type: 'text', filter: 'list' },
      { key: 'family', label: 'Family', on: false, field: 'gem_family', type: 'text', filter: 'list' },
      { key: 'media', label: 'Media', on: false },
      { key: 'created', label: 'Added', on: false, field: 'creation', type: 'date' },
    ],
  },
  {
    label: 'Gem details',
    columns: [
      { key: 'weight', label: 'Weight (ct)', on: true, align: 'right', field: 'weight_ct', type: 'number', filter: 'range' },
      { key: 'pieces', label: 'Pcs', on: true, align: 'right', field: 'pieces', type: 'number', filter: 'range' },
      { key: 'shape', label: 'Shape', on: true, field: 'shape', type: 'text', filter: 'list' },
      { key: 'base_color', label: 'Colour', on: true, field: 'base_color', type: 'text', filter: 'list' },
      { key: 'color', label: 'Colour description', on: false, field: 'color', type: 'text', filter: 'list' },
      { key: 'trade_name', label: 'Trade name', on: false, field: 'trade_name', type: 'text', filter: 'list' },
      { key: 'clarity', label: 'Clarity', on: true, field: 'clarity', type: 'text', filter: 'list' },
      { key: 'treatment', label: 'Treatment', on: true, field: 'treatment', type: 'text', filter: 'list' },
      { key: 'origin', label: 'Origin', on: true, field: 'origin', type: 'text', filter: 'list' },
      { key: 'cut', label: 'Cut', on: false, field: 'cut', type: 'text', filter: 'list' },
      { key: 'meas1', label: 'L (mm)', on: true, align: 'right', field: 'meas1', type: 'number', filter: 'range' },
      { key: 'meas2', label: 'W (mm)', on: true, align: 'right', field: 'meas2', type: 'number', filter: 'range' },
      { key: 'meas3', label: 'H (mm)', on: true, align: 'right', field: 'meas3', type: 'number', filter: 'range' },
      { key: 'lab', label: 'Lab', on: false, field: 'lab', type: 'text', filter: 'list' },
      { key: 'certificate_no', label: 'Certificate', on: false, field: 'certificate_no', type: 'text' },
      { key: 'parcel_type', label: 'Parcel', on: false, field: 'parcel_type', type: 'text', filter: 'list' },
      { key: 'calibrated', label: 'Calibrated', on: false, field: 'calibrated', type: 'text', filter: 'list' },
    ],
  },
  {
    label: 'Stock & price',
    columns: [
      { key: 'cost_rate', label: 'Cost / unit', on: false, align: 'right', field: 'cost_rate', type: 'number', filter: 'range' },
      { key: 'stock_value', label: 'Value', on: true, align: 'right', field: 'stock_value', type: 'number', filter: 'range' },
      // Pinned to the right edge (with Status) while the table scrolls.
      { key: 'selling_price', label: 'Selling price', on: true, align: 'right', pin: 'right', field: 'selling_price', type: 'number', filter: 'range' },
      { key: 'status', label: 'Status', on: true, locked: true, align: 'center', pin: 'right', field: 'status', type: 'text', filter: 'list' },
    ],
  },
];

export const ALL_COLUMNS = COLUMN_GROUPS.flatMap((g) => g.columns);
export const DEFAULT_COLUMNS = ALL_COLUMNS.filter((c) => c.on).map((c) => c.key);

/** A saved column list, cleaned: known keys, locked ones always present, catalog order. */
export function resolveColumns(saved) {
  const keys = new Set(Array.isArray(saved) && saved.length ? saved : DEFAULT_COLUMNS);
  return ALL_COLUMNS.filter((c) => c.locked || keys.has(c.key)).map((c) => c.key);
}
