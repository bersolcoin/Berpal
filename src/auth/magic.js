/**
 * Magic (magic.link) server-side helper — validates the DID token the
 * browser gets from magic.auth.loginWithSMS() and returns the verified
 * identity. Phone comes from Magic's metadata, never from the client body,
 * so a user can't claim a number they didn't receive the SMS on.
 *
 * Keys and wallets live with Magic; we only store the issuer (stable user
 * id) and the public wallet address.
 */

const { Magic } = require('@magic-sdk/admin');

let _magic = null;
async function getMagicAdmin() {
  if (!_magic) {
    const secret = process.env.MAGIC_SECRET_KEY;
    if (!secret) throw new Error('MAGIC_SECRET_KEY not set');
    _magic = await Magic.init(secret);
  }
  return _magic;
}

/**
 * @returns {Promise<{ issuer: string, phone: string|null, email: string|null, wallet_address: string|null }>}
 * Throws on an invalid / expired token.
 */
async function verifyDidToken(didToken) {
  const magic = await getMagicAdmin();
  await magic.token.validate(didToken);
  const meta = await magic.users.getMetadataByToken(didToken);
  return {
    issuer: meta.issuer,
    phone: meta.phoneNumber || null,
    email: meta.email || null,
    wallet_address: meta.publicAddress || null,
  };
}

module.exports = { verifyDidToken };
