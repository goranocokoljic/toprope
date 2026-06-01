-- One user account per developer (Task 2.13 / #48).
-- The admin API checks this at the application layer, but create has an async
-- gap (password hashing) between the check and the insert. A partial unique
-- index makes the invariant hold unconditionally: a developer maps to at most
-- one account, so deactivating that account fully severs access to the
-- developer's private data. NULL developer_id (pure admins) is excluded.
CREATE UNIQUE INDEX idx_users_developer_id_unique
    ON users(developer_id)
    WHERE developer_id IS NOT NULL;
