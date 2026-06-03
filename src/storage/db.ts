import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export function openDb(dbPath: string): Database.Database {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Wait (rather than fail immediately with SQLITE_BUSY) if another writer holds
    // the lock. Matters for the scheduler: the quarterly and yearly aggregation
    // jobs both fire Jan 1 05:00 UTC, and a future async step could let two writers
    // overlap. A short bounded wait removes that footgun at no cost to the common
    // single-writer case.
    db.pragma('busy_timeout = 5000');
    return db;
}
