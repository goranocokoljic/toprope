import https from 'https';
import type {Developer} from './types';
import Database from 'better-sqlite3';
import {addDeveloper, findByGithubUsername} from './developers';
import {ensureTeam} from './teams';
import {replayDevelopers} from '../connectors/git/projection';

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
    /** Distinct UTC days the created developers' retained history was re-projected over. */
    datesAttributed: number;
}

export async function discoverOrgMembers(
    db: Database.Database,
    org: string,
    token: string,
    defaultTeam?: string,
): Promise<DiscoveryResult> {
    const team = defaultTeam ?? 'discovered';

    // Resolve the target team BEFORE the network fetch: creating it when absent, refusing
    // it when ARCHIVED. Shared with DO1.6's auto-create via `ensureTeam` rather than an
    // inline INSERT, so both hands-off onboarding paths agree about what a usable default
    // team is — previously this path would have happily created developers into an archived
    // team, where they are invisible to every team aggregate.
    //
    // Checked first so an unusable team costs zero API calls and fails immediately, rather
    // than after paginating a whole org's membership.
    if (!ensureTeam(db, team)) {
        throw new Error(
            `Team '${team}' is archived; discovered developers would be invisible in every team aggregate. Un-archive it or pass a different --team.`,
        );
    }

    const members = await fetchOrgMembers(org, token);
    const created: Developer[] = [];
    const skipped: string[] = [];

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

    // Attribute the retained history the new logins now resolve. Without this, org
    // discovery would be the ONE onboarding path that silently opts out of the epic's
    // guarantee — `dev add`, `dev discover-repo --promote` and the admin create route
    // all replay, and the docs state the guarantee universally. It would not self-heal
    // either: sync projects in `cells` mode, which never revisits a past day.
    //
    // Batched into one whole-day rebuild rather than one per developer, for the same
    // reason `promoteAllCandidates` batches — a `dates`-mode projection's cost is driven
    // by the day set, not by whose replay asked for it, and a freshly-discovered org
    // shares almost all of its active days.
    const replay =
        created.length > 0
            ? replayDevelopers(db, created.map((d) => d.id)).result
            : {cellsWritten: 0, cellsRetracted: 0, cellsSkippedLegacy: 0, datesCovered: 0};

    return {created, skipped, datesAttributed: replay.datesCovered};
}
