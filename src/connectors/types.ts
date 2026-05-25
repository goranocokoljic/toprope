import type Database from 'better-sqlite3';

export interface SyncResult {
    connector: string;
    snapshotsWritten: number;
    snapshotsSkipped: number;
    errors: string[];
    lastSyncTime: string;
}

export interface ConnectorInterface {
    getName(): string;
    getLastSyncTime(db: Database.Database): string | null;
    sync(db: Database.Database): Promise<SyncResult>;
}
