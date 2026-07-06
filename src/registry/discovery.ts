import https from 'https';
import type {Developer} from './types';
import Database from 'better-sqlite3';
import {addDeveloper, findByGithubUsername} from './developers';
import {teamExists} from './teams';

interface GithubMember {
    login: string;
    name?: string | null;
}

interface GithubUserDetail {
    login: string;
    name: string | null;
}

function httpsGet(url: string, token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'toprope/0.1.0',
                Accept: 'application/vnd.github+json',
            },
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => {
                data += chunk.toString('utf8');
            });
            res.on('error', reject);
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`GitHub API error ${res.statusCode}: ${data}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function fetchOrgMembers(org: string, token: string): Promise<GithubMember[]> {
    const members: GithubMember[] = [];
    let page = 1;
    while (true) {
        const url = `https://api.github.com/orgs/${org}/members?per_page=100&page=${page}`;
        const batch = (await httpsGet(url, token)) as GithubMember[];
        if (!Array.isArray(batch) || batch.length === 0) break;
        members.push(...batch);
        if (batch.length < 100) break;
        page++;
    }
    return members;
}

async function fetchUserDetail(login: string, token: string): Promise<GithubUserDetail> {
    const url = `https://api.github.com/users/${login}`;
    const user = (await httpsGet(url, token)) as GithubUserDetail;
    return user;
}

export interface DiscoveryResult {
    created: Developer[];
    skipped: string[];
}

export async function discoverOrgMembers(
    db: Database.Database,
    org: string,
    token: string,
    defaultTeam?: string,
): Promise<DiscoveryResult> {
    const members = await fetchOrgMembers(org, token);
    const created: Developer[] = [];
    const skipped: string[] = [];

    const team = defaultTeam ?? 'discovered';

    // Create default team if it doesn't exist
    if (!teamExists(db, team)) {
        db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(
            team,
            new Date().toISOString(),
        );
    }

    for (const member of members) {
        const existing = findByGithubUsername(db, member.login);
        if (existing) {
            skipped.push(member.login);
            continue;
        }

        let displayName = member.login;
        try {
            const detail = await fetchUserDetail(member.login, token);
            if (detail.name) displayName = detail.name;
        } catch {
            // fall back to login as name
        }

        const dev = addDeveloper(db, displayName, team, undefined, member.login);
        created.push(dev);
    }

    return {created, skipped};
}
