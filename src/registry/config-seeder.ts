import Database from 'better-sqlite3';
import type {TeamConfig} from '../config/types';
import {addTeam, teamExists} from './teams';

export function seedTeamsFromConfig(db: Database.Database, teams: TeamConfig[]): void {
    for (const teamCfg of teams) {
        if (!teamExists(db, teamCfg.name)) {
            addTeam(db, teamCfg.name, teamCfg.department, teamCfg.manager);
        }
    }
}
