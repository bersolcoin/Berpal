-- One unfinished lot operation per user, enforced by the database as well as by store.beginOp:
-- two operations begun at the same moment cannot both get in, and an undo cannot start on a
-- finished operation while another one is still open. 'pending' | 'partial' | 'undoing' are the
-- unfinished states (store.UNFINISHED). Idempotent like every migration.
-- An expression index, not a partial one (WHERE status IN (...)): the expression is NULL for a
-- finished operation and NULLs never collide, so the same rule holds, and pg-mem (the tests)
-- answers queries on a partial index wrongly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lot_ops_one_unfinished
  ON lot_ops ((CASE WHEN status IN ('pending', 'partial', 'undoing') THEN user_id END));
