/**
 * Import lots from the shop's Google-Shopping product feed
 * (e.g. https://shop.example.com/feed/products.xml, saved locally) as
 * opening stock for one business — with images, video and the web price.
 *
 *   node scripts/import-shop-feed.js --file products.xml --user 1 --count 10 [--seed 7] [--dry]
 *
 * Per <item>:
 *   g:id → lot code (shop SKU)        g:title → lot name
 *   g:product_type "Gemstones > X" → variety X (must exist in the catalog)
 *   product_detail: Carat weight, Shape, Colour, Origin, Measurements,
 *   Clarity, Treatment, Certificate → gem attributes; g:color → base colour
 *   g:image_link / g:additional_image_link / <video><url> → media
 *   g:price → selling price (Item Price, in the feed currency)
 *
 * COST: the feed has no cost data. Opening stock is valued at a PLACEHOLDER
 * cost of --cost-pct (default 60) % of the web price, converted to the
 * company currency. Use only for test data — real costs come from the ERP.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const { query } = require('../src/db');
const erpnext = require('../src/erpnext');
const { createLot, listVarieties } = require('../src/catalog');
const { postOpeningStock } = require('../src/erp-sync/stock');
const { fetchRate } = require('../src/exchange');
const gem = require('../src/catalog/gemstones');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const unescape = (s) =>
  String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (xml, name) => unescape((xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]);
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => unescape(m[1]));

function parseItem(xml) {
  const details = {};
  for (const d of xml.match(/<g:product_detail>[\s\S]*?<\/g:product_detail>/g) || []) {
    details[tag(d, 'g:attribute_name')] = tag(d, 'g:attribute_value');
  }
  const [amount, currency] = (tag(xml, 'g:price') || '').split(/\s+/);
  return {
    id: tag(xml, 'g:id'),
    title: tag(xml, 'g:title'),
    variety: (tag(xml, 'g:product_type').split('>').pop() || '').trim(),
    baseColor: tag(xml, 'g:color'),
    details,
    image: tag(xml, 'g:image_link'),
    images: tags(xml, 'g:additional_image_link'),
    video: (xml.match(/<video>\s*<url>([^<]+)<\/url>/) || [])[1] || null,
    price: { amount: Number(amount) || 0, currency: currency || 'USD' },
  };
}

const ORIGIN_ALIAS = { Columbia: 'Colombia' };
const opt = (key) => gem.ATTRIBUTES.find((a) => a[0] === key)?.[4] || [];
const pick = (key, v) => (v && opt(key).includes(v) ? v : undefined);

function toAttributes(it) {
  const d = it.details;
  const [l, w, h] = (d.Measurements || '').replace(/mm/i, '').split('x').map((x) => Number(x.trim()) || undefined);
  const colour = d.Colour;
  return {
    pieces: 1,
    weight_ct: Number(String(d['Carat weight'] || '').replace(/[^\d.]/g, '')) || undefined,
    shape: pick('shape', d.Shape),
    base_color: pick('base_color', it.baseColor) || pick('base_color', colour),
    trade_name: pick('trade_name', colour),
    color: colour || undefined,
    clarity: pick('clarity', d.Clarity),
    treatment: pick('treatment', d.Treatment),
    origin: pick('origin', ORIGIN_ALIAS[d.Origin] || d.Origin),
    lab: pick('lab', (d.Certificate || '').toUpperCase()),
    meas1: l,
    meas2: w,
    meas3: h,
  };
}

// Small seeded PRNG so a run is repeatable with --seed.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

(async () => {
  const file = arg('file');
  const userId = parseInt(arg('user'), 10);
  const count = parseInt(arg('count', '10'), 10);
  const costPct = Number(arg('cost-pct', '60')) / 100;
  const dry = process.argv.includes('--dry');
  if (!file || !userId) {
    console.error('Usage: node scripts/import-shop-feed.js --file products.xml --user <id> [--count 10] [--seed 7] [--dry]');
    process.exit(1);
  }

  const user = (await query(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user) throw new Error(`no user ${userId}`);
  user.reporting_currency = user.reporting_currency || user.default_currency;
  const erp = erpnext.forUser(user);
  const enabled = new Map((await listVarieties(user.id)).map((v) => [v.variety.toLowerCase(), v.variety]));

  const all = (fs.readFileSync(file, 'utf8').match(/<item>[\s\S]*?<\/item>/g) || []).map(parseItem);
  // Candidates: variety in this business's catalog, has weight, image and video.
  const candidates = all.filter((it) => enabled.has(it.variety.toLowerCase()) && it.image && it.video && toAttributes(it).weight_ct);
  // One per variety first (variety spread), random order.
  const rand = rng(parseInt(arg('seed', String(Date.now() % 100000)), 10));
  const shuffled = candidates.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const seen = new Set();
  const chosen = [];
  for (const it of shuffled) if (chosen.length < count && !seen.has(it.variety)) (seen.add(it.variety), chosen.push(it));
  for (const it of shuffled) if (chosen.length < count && !chosen.includes(it)) chosen.push(it);
  console.log(`feed: ${all.length} items, ${candidates.length} importable, picking ${chosen.length}`);

  const fxCache = {};
  const created = [];
  for (const it of chosen) {
    const attributes = toAttributes(it);
    const variety = enabled.get(it.variety.toLowerCase());
    if (!fxCache[it.price.currency]) {
      const fx = await fetchRate(it.price.currency, user.default_currency);
      if (fx.error) throw new Error(fx.error);
      fxCache[it.price.currency] = fx.rate;
    }
    const costPerCt = Math.round(((it.price.amount * fxCache[it.price.currency] * costPct) / attributes.weight_ct) * 100) / 100;
    console.log(`  ${it.id.padEnd(10)} ${variety.padEnd(24)} ${String(attributes.weight_ct).padStart(6)} ct  ${it.price.amount} ${it.price.currency}  cost ${costPerCt}/ct`);
    if (dry) continue;
    try {
      const lot = await createLot(user, erp, {
        variety,
        code: it.id,
        name: it.title,
        attributes,
        media: { image: it.image, images: it.images, video: it.video },
        sellingPrice: it.price,
      });
      created.push({ itemCode: lot.erpnext_name, qty: lot.weight_ct, valuationRate: costPerCt });
    } catch (err) {
      console.log(`    × skipped: ${err.userMessage || err.message}`);
    }
  }
  if (dry || !created.length) process.exit(0);

  const sr = await postOpeningStock(user, erp, { items: created });
  console.log(`\nopening stock: ${created.length} lot(s) → ${sr}  (cost = ${costPct * 100}% of web price — PLACEHOLDER)`);
  process.exit(0);
})().catch((err) => {
  console.error('import failed:', String(err.message).replace(/<[^>]+>/g, '').slice(0, 300));
  process.exit(1);
});
