-- The user's own VAT status (src/tools/set-tax-settings.js). Decides whether VAT on a purchase is
-- claimable Input VAT and whether they may charge VAT on a sale at all (Revenue Code s.86/13).
-- vat_registered: 1 = registered, 0 = not, NULL = never asked (the bot asks before posting VAT).
ALTER TABLE users ADD COLUMN IF NOT EXISTS vat_registered INTEGER;
-- 13-digit Thai tax id, for the tax-invoice print format / WHT certificates.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id TEXT;
