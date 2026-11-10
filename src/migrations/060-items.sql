-- Stock Items the bot created in ERPNext for a user's SKU / stone ids (src/erp-sync/items.js).
-- item_code is the user's code ("PA2293"); erpnext_name is the ERPNext Item ("PA2293-TC"),
-- namespaced by company abbreviation because Items are global across Companies.
-- Lookup cache only: stock quantities and values live in ERPNext (Bin), never here.
CREATE TABLE IF NOT EXISTS item_cache (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_code TEXT NOT NULL,
  item_name TEXT,
  erpnext_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_item_cache_user ON item_cache(user_id);
