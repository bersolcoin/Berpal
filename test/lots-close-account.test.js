/**
 * Closing the account takes the gem lot records with it: they name suppliers, cutters and memo
 * holders, and the stored plans carry the drafts. ERPNext keeps the carats and the ledger.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lots-helpers');
const db = require('../src/db');
const { FakeErpNext } = require('./fake-erpnext');
const onboarding = require('../src/onboarding');

const erp = new FakeErpNext();
let user;
let client;
let other;

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  other = await h.addUser();
});

const count = async (sql, id) => Number((await db.query(sql, [id])).rows[0].n);
const LOTS = 'SELECT COUNT(*) AS n FROM lots WHERE user_id = $1';
const OPS = 'SELECT COUNT(*) AS n FROM lot_ops WHERE user_id = $1';

test('closing the account removes this trader\'s lots and operations, and nobody else\'s', async () => {
  await h.seedLot(user, client, { code: 'L1', carats: 10, cost: 1000 });
  await h.seedLot(other, client, { code: 'L2', carats: 5, cost: 500 });
  assert.equal(await count(LOTS, user.id), 1);
  assert.ok(await count(OPS, user.id) >= 1);

  await onboarding.handleRegistered(user, 'delete my account');
  await onboarding.handleRegistered(user, 'DELETE');
  assert.equal((await db.query('SELECT subscription_status FROM users WHERE id = $1', [user.id])).rows[0].subscription_status, 'deleted');

  assert.equal(await count(LOTS, user.id), 0);
  assert.equal(await count(OPS, user.id), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM lot_custody WHERE user_id = $1', user.id), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM lot_mismatches WHERE user_id = $1', user.id), 0);
  assert.equal(await count(LOTS, other.id), 1);
});
