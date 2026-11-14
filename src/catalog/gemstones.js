/**
 * Gemstone catalog definition — the source of truth for the gemstones
 * industry: category tree (family → variety, with lot-code prefixes) and
 * the per-lot attribute fields with their option lists.
 *
 * Option lists and prefixes mirror the shop's (MedusaJS) import pipeline
 * and storefront filters, so lots created here can feed the website later.
 *
 * Seeded into Postgres by src/db.js (item_categories +
 * industry_attribute_schema). Edit here, restart, and the seed UPSERTs.
 *
 * Stock model: one Item per lot, stock UOM = Carat. Buying and selling are
 * per carat (line qty = carats, rate = price per carat). Pieces is a lot
 * attribute.
 */

const INDUSTRY = 'gemstones';
// Top-level category these varieties live under, and its stock unit.
const CATEGORY = 'Gemstones';
const UOM = 'Carat';

// [family, variety, codePrefix]. Single-variety families repeat the name.
// Prefixes are the leading letters of lot codes (AQ1405 → AQ); several
// varieties may share one (RD covers the rhodolite group).
const VARIETIES = [
  ['Tourmaline', 'Paraiba Tourmaline', 'PA'],
  ['Tourmaline', 'Cuprian Tourmaline', 'MZ'],
  ['Tourmaline', 'Rubellite Tourmaline', 'RL'],
  ['Tourmaline', 'Chrome Tourmaline', 'CT'],
  ['Tourmaline', 'Green Tourmaline', 'TG'],
  ['Tourmaline', 'Pink Tourmaline', 'PT'],
  ['Tourmaline', 'Blue Tourmaline', 'TB'],
  ['Tourmaline', 'Yellow Tourmaline', 'YT'],
  ['Tourmaline', 'Orange Tourmaline', 'OT'],
  ['Tourmaline', 'Bi Colour Tourmaline', 'BT'],
  ['Tourmaline', 'Mix Tourmaline', 'MT'],

  ['Garnet', 'Spessartite Garnet', 'ST'],
  ['Garnet', 'Tsavorite Garnet', 'TS'],
  ['Garnet', 'Grossular Garnet', 'GG'],
  ['Garnet', 'Demantoid Garnet', 'DG'],
  ['Garnet', 'Malaya Garnet', 'MG'],
  ['Garnet', 'Colour Change Garnet', 'CG'],
  ['Garnet', 'Rhodolite Garnet', 'RD'],
  ['Garnet', 'Umbalite Garnet', 'RD'],
  ['Garnet', 'Rose Garnet', 'RD'],
  ['Garnet', 'Pink Garnet', 'RD'],

  ['Ruby', 'Mozambique Ruby', 'MR'],
  ['Ruby', 'Burma Ruby', 'WC'],
  ['Ruby', 'Star Ruby', 'SR'],

  ['Sapphire', 'Blue Sapphire', 'BS'],
  ['Sapphire', 'Pink Sapphire', 'PS'],
  ['Sapphire', 'Yellow Sapphire', 'YS'],
  ['Sapphire', 'Teal Sapphire', 'TL'],
  ['Sapphire', 'Purple Sapphire', 'PU'],
  ['Sapphire', 'Padparadscha Sapphire', 'PP'],
  ['Sapphire', 'Star Sapphire', 'SS'],
  ['Sapphire', 'Blue Star Sapphire', 'BR'],
  ['Sapphire', 'Black Star Sapphire', 'BL'],

  ['Spinel', 'Red Spinel', 'SP'],
  ['Spinel', 'Pink Spinel', 'SP'],
  ['Spinel', 'Blue Spinel', 'SP'],
  ['Spinel', 'Purple Spinel', 'SP'],
  ['Spinel', 'Grey Spinel', 'SP'],
  ['Spinel', 'Spinel', 'SP'],

  ['Emerald', 'Zambian Emerald', 'PG'],
  ['Emerald', 'Colombian Emerald', 'EM'],

  ['Zircon', 'Blue Zircon', 'ZI'],
  ['Zircon', 'Zircon', 'ZI'],

  ['Moonstone', 'Rainbow Moonstone', 'RM'],
  ['Moonstone', 'Blue Moonstone', 'AB'],
  ['Moonstone', 'White Moonstone', 'WM'],
  ['Moonstone', 'Green Moonstone', 'GM'],
  ['Moonstone', 'Orange Moonstone', 'OM'],

  ['Chrysoberyl', 'Chrysoberyl', 'CB'],
  ['Chrysoberyl', 'Chrysoberyl Cats Eye', 'CE'],
  ['Chrysoberyl', 'Alexandrite', 'AL'],

  ['Topaz', 'Blue Topaz', 'TO'],
  ['Topaz', 'Champagne Topaz', 'CZ'],

  ['Quartz', 'Amethyst', 'AY'],
  ['Quartz', 'Ametrine', 'AM'],

  ['Aquamarine', 'Aquamarine', 'AQ'],
  ['Tanzanite', 'Tanzanite', 'TN'],
  ['Peridot', 'Peridot', 'PD'],
  ['Sphene', 'Sphene', 'SH'],
  ['Opal', 'Ethiopian Opal', 'OP'],
  ['Apatite', 'Apatite Cats Eye', 'AC'],
];

const SHAPES = ['Oval', 'Cushion', 'Pear', 'Round', 'Rectangular', 'Square', 'Heart', 'Marquise', 'Trilliant', 'Fancy', 'Mix'];
const BASE_COLORS = ['Blue', 'Green', 'Pink', 'Red', 'Yellow', 'Orange', 'Purple', 'White', 'Black', 'Grey', 'Brown', 'Tan', 'Bi Colour', 'Mixed Colour'];
const TRADE_NAMES = [
  'AA', 'AAA+', 'Cats Eye', 'Color Change', 'Cornflower Blue', 'Crimson Red', 'D-Block', 'Fanta', 'Indicolite',
  'Muzo', 'Neon', 'Peacock Blue', 'Pigeons Blood', 'Royal Blue', 'Santa Maria', 'Sunrise', 'Sunset',
  'Super Dark Blue', 'Vivid', 'Watermelon',
];
const CLARITY = ['IF', 'VVS', 'VS', 'SI-1', 'SI-2', 'I', 'O', 'TS', 'Mix'];
const TREATMENTS = [
  'Unheated', 'Heated', 'Heated (a)', 'Minor (CE)', 'Moderate (CE)', 'Insignificant (CE)',
  'Irradiated', 'Clarity Enhanced', 'None',
];
const ORIGINS = [
  'Africa', 'Australia', 'Bolivia', 'Brazil', 'Burma', 'Cambodia', 'China', 'Colombia', 'Congo', 'Ethiopia',
  'India', 'Kenya', 'Madagascar', 'Mozambique', 'Namibia', 'Nigeria', 'Pakistan', 'Russia', 'Sri Lanka',
  'Tajikistan', 'Tanzania', 'Thailand', 'Zambia', 'Zimbabwe', 'Unknown',
];
const CUTS = [
  'Fine Step Cut', 'Step Cut', 'Mixed Cut', 'Modified Brilliant Cut', 'Brilliant Diamond Cut', 'Emerald Cut',
  'Asscher Cut', 'Radiant Cut', 'Princess Cut', 'Cushion Cut', 'Antique Cushion Cut', 'Scissor Cut',
  'Checkered Cut', 'Designer Cut', 'Laser Cut', 'Rose Cut', 'Buff Top', 'Sugarloaf Cut', 'Cabochon',
];
const LABS = ['GRS', 'AIGS', 'GIA', 'GIT', 'GIL', 'GUBELIN', 'SSEF', 'LOTUS', 'GUILD', 'ICALAB', 'AGL'];
const PARCEL_TYPES = ['Single', 'Pair', 'Parcel', 'Layout'];

// Attribute fields. ui: 'essential' (always on the form) | 'more' (behind
// "+ More details") | 'system' (set by the server, not typed).
// [field_key, label, type, required, options, ui]
const ATTRIBUTES = [
  ['gem_family', 'Gem Family', 'data', false, null, 'system'],
  ['gem_type', 'Gem Variety', 'data', false, null, 'system'],
  // Values of extra (non-standard) attributes, as JSON.
  ['extra_attributes', 'Extra Attributes', 'json', false, null, 'system'],
  // Lot media beyond the main Item image: { images: [url…], video: url }.
  ['media', 'Media', 'json', false, null, 'system'],
  ['pieces', 'Pieces', 'int', true, null, 'essential'],
  ['weight_ct', 'Weight (ct)', 'float', true, null, 'essential'],
  ['shape', 'Shape', 'select', false, SHAPES, 'essential'],
  ['base_color', 'Colour', 'select', false, BASE_COLORS, 'essential'],
  ['parcel_type', 'Parcel Type', 'select', false, PARCEL_TYPES, 'more'],
  ['calibrated', 'Calibrated', 'check', false, null, 'more'],
  ['color', 'Colour Description', 'data', false, null, 'more'],
  ['trade_name', 'Trade Name', 'select', false, TRADE_NAMES, 'more'],
  ['clarity', 'Clarity', 'select', false, CLARITY, 'more'],
  ['treatment', 'Treatment', 'select', false, TREATMENTS, 'more'],
  ['origin', 'Origin', 'select', false, ORIGINS, 'more'],
  ['cut', 'Cut', 'select', false, CUTS, 'more'],
  ['meas1', 'Length (mm)', 'float', false, null, 'more'],
  ['meas2', 'Width (mm)', 'float', false, null, 'more'],
  ['meas3', 'Height (mm)', 'float', false, null, 'more'],
  ['lab', 'Certificate Lab', 'select', false, LABS, 'more'],
  ['certificate_no', 'Certificate No', 'data', false, null, 'more'],
];

/** Default parcel type from piece count (shop rule: 1 Single, 2 Pair, 3+ Parcel). */
function parcelTypeForPieces(pieces) {
  const n = Number(pieces) || 0;
  if (n <= 1) return 'Single';
  if (n === 2) return 'Pair';
  return 'Parcel';
}

/** Shop rule: calibrated when round(L) − round(W) is 0 or 2 (mm). */
function isCalibrated(meas1, meas2) {
  if (!(Number(meas1) > 0) || !(Number(meas2) > 0)) return null;
  const d = Math.round(Number(meas1)) - Math.round(Number(meas2));
  return d === 0 || d === 2;
}

module.exports = {
  INDUSTRY,
  CATEGORY,
  UOM,
  VARIETIES,
  ATTRIBUTES,
  parcelTypeForPieces,
  isCalibrated,
};
