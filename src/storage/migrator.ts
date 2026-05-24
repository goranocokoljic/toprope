import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface MigrationRecord {
    id: number;
    name: string;
    applied_at: string;
}

export interface MigrationStatus {
    id: number;
    name: string;
    applied: boolean;
    applied_at: string | null;
}

function ensureMigrationsTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
    `);
}

function getAppliedIds(db: Database.Database): Set<number> {
    const rows = db.prepare('SELECT id FROM schema_migrations').all() as {id: number}[];
    return new Set(rows.map((r) => r.id));
}

function parseMigrationFiles(migrationsDir: string): {id: number; name: string; file: string}[] {
    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => /^\d{3}_.*\.sql$/.test(f))
        .sort();

    return files.map((f) => ({
        id: parseInt(f.slice(0, 3), 10),
        name: f,
        file: path.join(migrationsDir, f),
    }));
}

export function runMigrations(db: Database.Database, migrationsDir: string): number {
    ensureMigrationsTable(db);
    const applied = getAppliedIds(db);
    const migrations = parseMigrationFiles(migrationsDir);
    let count = 0;

    for (const migration of migrations) {
        if (applied.has(migration.id)) {
            continue;
        }

        const sql = fs.readFileSync(migration.file, 'utf-8');
        db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
                migration.id,
                migration.name,
                new Date().toISOString(),
            );
        })();

        count++;
    }

    return count;
}

export function getMigrationStatus(
    db: Database.Database,
    migrationsDir: string,
): MigrationStatus[] {
    ensureMigrationsTable(db);
    const applied = new Map<number, string>();

    const rows = db
        .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
        .all() as {id: number; applied_at: string}[];
    for (const row of rows) {
        applied.set(row.id, row.applied_at);
    }

    const migrations = parseMigrationFiles(migrationsDir);

    return migrations.map((m) => ({
        id: m.id,
        name: m.name,
        applied: applied.has(m.id),
        applied_at: applied.get(m.id) ?? null,
    }));
}
