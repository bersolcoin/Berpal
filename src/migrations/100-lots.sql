-- Gem lots (src/lots/): parcels of stones, per user. Design: docs/parcel-lot-stock-design.md.
-- Berpal holds what ERPNext cannot: piece counts, stone attributes, lineage and custody.
-- ERPNext holds carats and money (one Batch per lot). ERPNext is the authority on carats and
-- value, Berpal on pieces; a nightly job compares the two (src/lots/reconcile.js).
-- Money and weights are NUMERIC (node-postgres returns them as strings: Number() on read).
-- Dates are TEXT 'YYYY-MM-DD', timestamps TEXT ISO, like the rest of the schema.

ALTER TABLE users ADD COLUMN IF NOT EXISTS niche TEXT;            -- null = general ledger | 'gems'
ALTER TABLE users ADD COLUMN IF NOT EXISTS lot_cost_method TEXT;  -- null = default ('value') | 'value' | 'weight'

CREATE TABLE IF NOT EXISTS lots (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                          -- the trader's own code or L<n>; upper-cased
  status TEXT NOT NULL DEFAULT 'active',       -- 'active' | 'closed' (nothing left: sold, split away, cut, written off)
  ownership TEXT NOT NULL DEFAULT 'owned',     -- 'owned' | 'memo_in' (held for someone else; not built yet)
  erpnext_item TEXT,                           -- GEM-ROUGH-<abbr> | GEM-CUT-<abbr>
  erpnext_batch TEXT,                          -- <CODE>-<abbr>, or <CODE>-r<revision>-<abbr> after a recut / re-weigh
  revision INTEGER NOT NULL DEFAULT 0,         -- bumped each time the lot takes a new batch under the same code
  carats NUMERIC NOT NULL DEFAULT 0,           -- on hand, 3 dp
  weight_estimated BOOLEAN NOT NULL DEFAULT FALSE,
  pieces INTEGER,                              -- null = not counted
  cost NUMERIC NOT NULL DEFAULT 0,             -- total cost on hand, company currency, 2 dp
  location TEXT NOT NULL DEFAULT 'stores',     -- 'stores' | 'work' | 'memo'
  holder TEXT,                                 -- who has it when location is work / memo
  form TEXT,                                   -- 'rough' | 'preform' | 'cut' | 'cabochon' | 'bead'
  species TEXT,
  variety TEXT,
  shape TEXT,
  size TEXT,
  colour TEXT,
  clarity TEXT,
  origin TEXT,
  grade TEXT,
  description TEXT,
  treatment TEXT,                              -- 'none' | 'H' | 'H-FH' | 'H-D' | 'H-GF' | 'FF-O' | 'LGH' | 'unknown'
  treatment_source TEXT,                       -- who says so: 'seller' | 'lab' | 'own' | free text
  purchase_unit TEXT,                          -- the unit the trader bought in: 'ct' | 'g' | 'kg' | 'piece'
  pricing_basis TEXT,                          -- 'per_ct' | 'per_g' | 'per_kg' | 'per_piece' | 'total'
  supplier TEXT,
  supplier_doc BOOLEAN,                        -- a supplier document is attached / exists
  vat_exempt BOOLEAN,                          -- bought under the exemption (phase 4 reads this)
  ask_per_ct NUMERIC,
  bottom_per_ct NUMERIC,
  price_currency TEXT,
  last_op_date TEXT,                           -- date of the newest posted operation touching this lot
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, code)
);
CREATE INDEX IF NOT EXISTS idx_lots_user_status ON lots(user_id, status);

-- One row per operation, written BEFORE anything is sent to ERPNext (status 'pending') and
-- settled afterwards. reference goes into the remarks of every ERPNext document of the operation.
CREATE TABLE IF NOT EXISTS lot_ops (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- 'buy' | 'sell' | 'split' | 'merge' | 'transform' | 'move' | 'write_off'
  job TEXT,                                    -- transform: 'cutting' | 'sawing' | 'heating' | 'preform' | 'recut' | 'reweigh'
  direction TEXT,                              -- move: 'out_work' | 'out_memo' | 'return'
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'partial' | 'posted' | 'failed' | 'undoing' | 'undone'
  reference TEXT NOT NULL UNIQUE,
  op_date TEXT NOT NULL,
  plan TEXT NOT NULL,                          -- JSON { op: ResolvedOp, draft } — enough to resume without the chat draft
  steps_done INTEGER NOT NULL DEFAULT 0,
  erpnext_docs TEXT NOT NULL DEFAULT '[]',     -- JSON [{ step, doctype, name, cancelled? }] in posting order
  before TEXT,                                 -- JSON written when the operation posts: what undo needs to put back
                                               --   { lots: [rows of existing lots it re-used as outputs], created: [lot ids],
                                               --     custody: [{ id, returned, sold }], certificates: [ids marked outdated] }
  fee_amount NUMERIC,                          -- the part of the fee that went into stock, company currency
  fee_basis TEXT,
  yield_pct NUMERIC,
  holder TEXT,
  note TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  posted_at TEXT,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lot_ops_user_status ON lot_ops(user_id, status);

-- Lineage: what went into an operation and what came out. Written when the operation posts.
CREATE TABLE IF NOT EXISTS lot_op_lines (
  id SERIAL PRIMARY KEY,
  op_id INTEGER NOT NULL REFERENCES lot_ops(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                          -- 'in' | 'out'
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  lot_code TEXT NOT NULL,
  carats NUMERIC NOT NULL,
  pieces INTEGER,
  damaged_pieces INTEGER,
  value NUMERIC NOT NULL DEFAULT 0,            -- cost carried, company currency (ERPNext's figure)
  place TEXT                                   -- 'stores' | 'work' | 'memo': where it was taken from / put
);
CREATE INDEX IF NOT EXISTS idx_lot_op_lines_op ON lot_op_lines(op_id);
CREATE INDEX IF NOT EXISTS idx_lot_op_lines_lot ON lot_op_lines(lot_id);

-- Who holds what outside the trader's own hands. One open row per lot at a time.
CREATE TABLE IF NOT EXISTS lot_custody (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  purpose TEXT NOT NULL,                       -- 'work' | 'memo' | 'lab'
  carats_out NUMERIC NOT NULL,
  pieces_out INTEGER,
  date_out TEXT NOT NULL,
  due_date TEXT,
  memo_price_per_ct NUMERIC,
  currency TEXT,
  out_op_id INTEGER REFERENCES lot_ops(id),
  status TEXT NOT NULL DEFAULT 'out',          -- 'out' | 'returned' | 'sold' | 'lost'
  closed_at TEXT,                              -- date the row closed
  close_op_id INTEGER REFERENCES lot_ops(id),
  carats_returned NUMERIC NOT NULL DEFAULT 0,
  carats_sold NUMERIC NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_lot_custody_user_status ON lot_custody(user_id, status);
CREATE INDEX IF NOT EXISTS idx_lot_custody_lot ON lot_custody(lot_id);

CREATE TABLE IF NOT EXISTS lot_certificates (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  lab TEXT NOT NULL,
  report_no TEXT,
  report_date TEXT,
  stated_carats NUMERIC,
  url TEXT,
  media_id INTEGER,
  outdated BOOLEAN NOT NULL DEFAULT FALSE,     -- the lot was recut / re-treated after the report
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lot_certificates_lot ON lot_certificates(lot_id);
