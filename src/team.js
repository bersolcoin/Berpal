/**
 * Team — who can use a business, and invites.
 *
 * Roles: owner (whoever set the business up — exactly one, can't be
 * changed or removed), admin, manager, staff. Only owner + admin see and
 * manage the Team (canManageTeam); otherwise every role has the same
 * access for now — per-role permissions come later.
 *
 * Invites are the ONLY way into someone else's business: a member invites
 * a phone number with a role. Signing in with that number shows "Join
 * business [n]" on /onboarding (and invites in the business switcher);
 * accepting creates the membership. There is no business search and no
 * "request to join" — nobody can approve a stranger by mistake. If
 * INVITE_SMS_ENABLED=true the number also gets a text.
 *
 *   listTeam(userId)                                → { members, invites }
 *   inviteMember({ business, phone, role, inviter }) → { invite, sms }
 *   resendInvite(business, inviteId, inviter)       → { sms }
 *   revokeInvite(userId, inviteId)
 *   changeRole(userId, personId, role)
 *   removeMember(userId, personId, actingPhone)
 *   listInvitesForPhone(phone)                      → pending invites to this number
 *   respondToInvite(phone, inviteId, accept, name)  → business id joined (accept) | null
 *     (name: the person's own — required when accepting if we don't have one yet)
 */

const { query, withTransaction } = require('./db');
const { sendSms } = require('./sms');

const ROLES = ['owner', 'admin', 'manager', 'staff'];
const INVITE_ROLES = ['admin', 'manager', 'staff'];
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', manager: 'Manager', staff: 'Staff' };

class TeamError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Owner + admin manage the team (sidebar Team, /team, /api/team/*).
const canManageTeam = (role) => role === 'owner' || role === 'admin';

const smsEnabled = () => process.env.INVITE_SMS_ENABLED === 'true';
const now = () => new Date().toISOString();

async function listTeam(userId) {
  const [members, invites] = await Promise.all([
    query(
      `SELECT p.id AS person_id, p.phone, p.display_name, m.role, m.created_at AS joined_at,
              inv.display_name AS invited_by_name
         FROM memberships m
         JOIN people p ON p.id = m.person_id
         LEFT JOIN people inv ON inv.id = m.invited_by
        WHERE m.user_id = $1
        ORDER BY (m.role = 'owner') DESC, lower(COALESCE(p.display_name, p.phone))`,
      [userId]
    ),
    query(
      `SELECT i.id, i.phone, i.role, i.created_at, i.sms_sent_at, inv.display_name AS invited_by_name
         FROM business_invites i LEFT JOIN people inv ON inv.id = i.invited_by
        WHERE i.user_id = $1 AND i.status = 'pending'
        ORDER BY i.created_at DESC`,
      [userId]
    ),
  ]);
  return { members: members.rows, invites: invites.rows };
}

function inviteText(businessName, inviterName) {
  const app = (process.env.APP_URL || '').replace(/\/$/, '');
  const who = inviterName ? `${inviterName} invited you` : 'You’ve been invited';
  return `${who} to join ${businessName} on Berpal. Sign in with this number${app ? ` at ${app}/login` : ''} to accept.`;
}

/** Send (or skip, when disabled) the invite SMS; stamps sms_sent_at when it went out. */
async function notify(invite, business, inviter) {
  if (!smsEnabled()) return { sent: false, reason: 'disabled' };
  const sms = await sendSms(invite.phone, inviteText(business.erpnext_company, inviter?.display_name));
  if (sms.sent) await query(`UPDATE business_invites SET sms_sent_at = $2 WHERE id = $1`, [invite.id, now()]);
  return sms;
}

/** business = users row; inviter = people row; phone = E.164. */
async function inviteMember({ business, phone, role, inviter }) {
  if (!INVITE_ROLES.includes(role)) throw new TeamError('Pick a role.');
  const already = await query(
    `SELECT 1 FROM memberships m JOIN people p ON p.id = m.person_id WHERE m.user_id = $1 AND p.phone = $2`,
    [business.id, phone]
  );
  if (already.rowCount) throw new TeamError('That number is already on the team.');

  let invite;
  try {
    const r = await query(
      `INSERT INTO business_invites (user_id, phone, role, invited_by, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [business.id, phone, role, inviter?.id || null, now()]
    );
    invite = r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new TeamError('That number already has an invite waiting.');
    throw err;
  }
  const sms = await notify(invite, business, inviter);
  return { invite, sms };
}

async function resendInvite(business, inviteId, inviter) {
  const r = await query(`SELECT * FROM business_invites WHERE id = $1 AND user_id = $2 AND status = 'pending'`, [
    inviteId,
    business.id,
  ]);
  if (!r.rows[0]) throw new TeamError('Invite not found.', 404);
  return { sms: await notify(r.rows[0], business, inviter) };
}

async function revokeInvite(userId, inviteId) {
  const r = await query(
    `UPDATE business_invites SET status = 'revoked', responded_at = $3
      WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [inviteId, userId, now()]
  );
  if (!r.rowCount) throw new TeamError('Invite not found.', 404);
}

async function memberRole(userId, personId) {
  const r = await query(`SELECT role FROM memberships WHERE user_id = $1 AND person_id = $2`, [userId, personId]);
  return r.rows[0]?.role || null;
}

async function changeRole(userId, personId, role) {
  if (!INVITE_ROLES.includes(role)) throw new TeamError('Pick a role.');
  const current = await memberRole(userId, personId);
  if (!current) throw new TeamError('Member not found.', 404);
  if (current === 'owner') throw new TeamError('The owner’s role can’t be changed.');
  await query(`UPDATE memberships SET role = $3 WHERE user_id = $1 AND person_id = $2`, [userId, personId, role]);
}

async function removeMember(userId, personId, actingPhone) {
  const current = await memberRole(userId, personId);
  if (!current) throw new TeamError('Member not found.', 404);
  if (current === 'owner') throw new TeamError('The owner can’t be removed.');
  const self = await query(`SELECT 1 FROM people WHERE id = $1 AND phone = $2`, [personId, actingPhone]);
  if (self.rowCount) throw new TeamError('You can’t remove yourself.');
  await query(`DELETE FROM memberships WHERE user_id = $1 AND person_id = $2`, [userId, personId]);
}

/** Pending invites to this number (businesses they're not already in), newest first. */
async function listInvitesForPhone(phone) {
  if (!phone) return [];
  const r = await query(
    `SELECT i.id, i.role, i.created_at, u.erpnext_company AS business_name, inv.display_name AS invited_by_name
       FROM business_invites i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN people inv ON inv.id = i.invited_by
      WHERE i.phone = $1 AND i.status = 'pending' AND u.erpnext_company IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM memberships m JOIN people p ON p.id = m.person_id
           WHERE m.user_id = i.user_id AND p.phone = i.phone
        )
      ORDER BY i.created_at DESC`,
    [phone]
  );
  return r.rows;
}

/** Accept / decline an invite addressed to this (SMS-verified) phone. Accept → the business id joined. */
async function respondToInvite(phone, inviteId, accept, name = '') {
  return withTransaction(async (tx) => {
    const r = await tx.query(
      `SELECT * FROM business_invites WHERE id = $1 AND phone = $2 AND status = 'pending' FOR UPDATE`,
      [inviteId, phone]
    );
    const invite = r.rows[0];
    if (!invite) throw new TeamError('This invite is no longer available.', 404);
    const at = now();
    const ownName = String(name || '').trim().slice(0, 80);
    if (accept) {
      const known = await tx.query(`SELECT display_name FROM people WHERE phone = $1`, [phone]);
      if (!known.rows[0]?.display_name && !ownName) throw new TeamError('Please enter your name.');
    }
    await tx.query(`UPDATE business_invites SET status = $2, responded_at = $3 WHERE id = $1`, [
      invite.id,
      accept ? 'accepted' : 'declined',
      at,
    ]);
    if (!accept) return null;
    // Their own name, given here — never the inviter's guess.
    const person = await tx.query(
      `INSERT INTO people (phone, display_name, created_at, updated_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (phone) DO UPDATE SET
         display_name = COALESCE(NULLIF(people.display_name, ''), EXCLUDED.display_name),
         updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [phone, ownName || null, at]
    );
    await tx.query(
      `INSERT INTO memberships (person_id, user_id, role, invited_by, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (person_id, user_id) DO NOTHING`,
      [person.rows[0].id, invite.user_id, invite.role, invite.invited_by, at]
    );
    return invite.user_id;
  });
}

module.exports = {
  ROLES,
  INVITE_ROLES,
  ROLE_LABELS,
  TeamError,
  canManageTeam,
  smsEnabled,
  listTeam,
  inviteMember,
  resendInvite,
  revokeInvite,
  changeRole,
  removeMember,
  listInvitesForPhone,
  respondToInvite,
};
