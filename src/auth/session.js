/**
 * Cookie-based session via iron-session (encrypted + signed).
 *
 * Usage in API routes:
 *   const sess = await getSession();
 *   sess.user_id = 7;
 *   await sess.save();
 *
 * Usage in pages (server components):
 *   const sess = await getSession();
 *   if (!sess.user_id) redirect('/login');
 */

const { getIronSession } = require('iron-session');
const { cookies } = require('next/headers');

const SESSION_NAME = 'berpal_session';

function getSessionOptions() {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 chars (set in .env)');
  }
  return {
    cookieName: SESSION_NAME,
    password,
    cookieOptions: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
  };
}

async function getSession() {
  const cookieStore = await cookies();
  return getIronSession(cookieStore, getSessionOptions());
}

async function destroySession() {
  const sess = await getSession();
  sess.destroy();
}

module.exports = { getSession, destroySession, SESSION_NAME };
