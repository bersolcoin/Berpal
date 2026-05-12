const { query } = require('./db');

async function findOrCreate(ownerUserId, { name, nickname, phone, email, taxId } = {}) {
  if (!name && !phone && !nickname) return null;

  let existing = null;

  // Phone is the most reliable key
  if (phone) {
    const r = await query(
      'SELECT * FROM counterparties WHERE owner_user_id = $1 AND phone = $2',
      [ownerUserId, phone]
    );
    existing = r.rows[0] || null;
  }

  // Then exact name (case-insensitive)
  if (!existing && name) {
    const r = await query(
      'SELECT * FROM counterparties WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2)',
      [ownerUserId, name]
    );
    existing = r.rows[0] || null;
  }

  // Then nickname (case-insensitive) — supports "tall mike" lookup
  if (!existing && nickname) {
    const r = await query(
      'SELECT * FROM counterparties WHERE owner_user_id = $1 AND LOWER(nickname) = LOWER($2)',
      [ownerUserId, nickname]
    );
    existing = r.rows[0] || null;
  }

  // Also try matching nickname against the name field (user might have stored "tall mike" as name first)
  if (!existing && nickname) {
    const r = await query(
      'SELECT * FROM counterparties WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2)',
      [ownerUserId, nickname]
    );
    existing = r.rows[0] || null;
  }

  const now = new Date().toISOString();

  if (existing) {
    const updates = {};
    if (!existing.phone && phone) updates.phone = phone;
    if (!existing.email && email) updates.email = email;
    if (!existing.tax_id && taxId) updates.tax_id = taxId;
    if (!existing.nickname && nickname && nickname.toLowerCase() !== existing.name.toLowerCase()) {
      updates.nickname = nickname;
    }

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const params = [...keys.map((k) => updates[k]), now, existing.id];
      await query(
        `UPDATE counterparties SET ${setClause}, updated_at = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
        params
      );
    }
    return existing.id;
  }

  const result = await query(
    `INSERT INTO counterparties (owner_user_id, name, nickname, phone, email, tax_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      ownerUserId,
      name || nickname || 'Unknown',
      nickname || null,
      phone || null,
      email || null,
      taxId || null,
      now,
      now,
    ]
  );

  return result.rows[0].id;
}

module.exports = { findOrCreate };
