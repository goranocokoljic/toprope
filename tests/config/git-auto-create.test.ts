import {describe, it, expect} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    resolveAutoCreateSettings,
    GitAutoCreateConfigError,
    AUTO_CREATE_TEAM_MAX_LENGTH,
    AUTO_CREATE_EXCLUDE_MAX_PATTERNS,
    AUTO_CREATE_EXCLUDE_MAX_PATTERN_LENGTH,
    AUTO_CREATE_EXCLUDE_MAX_WILDCARDS,
} from '../../src/config/git-auto-create';
import {loadConfig} from '../../src/config/loader';
import type {GitConnectorConfig} from '../../src/config/types';

function git(overrides: Partial<GitConnectorConfig> = {}): GitConnectorConfig {
    return {enabled: true, ...overrides};
}

describe('resolveAutoCreateSettings', () => {
    describe('default OFF', () => {
        it('is disabled when the connector config is absent entirely', () => {
            expect(resolveAutoCreateSettings(undefined)).toEqual({enabled: false, team: null, exclude: []});
        });

        it('is disabled when the flag is absent', () => {
            const settings = resolveAutoCreateSettings(git());
            expect(settings.enabled).toBe(false);
            expect(settings.team).toBeNull();
        });

        it('is disabled when the flag is explicitly false, even with a team set', () => {
            const settings = resolveAutoCreateSettings(
                git({auto_create_developers: false, auto_create_team: 'discovered'}),
            );
            expect(settings.enabled).toBe(false);
            // The disabled shape cannot carry a team — no caller can pick one up by accident.
            expect(settings.team).toBeNull();
        });

        it('is disabled when the flag is null', () => {
            expect(resolveAutoCreateSettings(git({auto_create_developers: null})).enabled).toBe(false);
        });
    });

    describe('the flag is narrowed at runtime, not by the type', () => {
        // The real vector: `auto_create_developers: "${ONBOARD}"` expands to a STRING.
        // "false" is truthy, so a truthiness check would silently enable the feature.
        it.each(['false', 'true', '', 'yes', '0'])('rejects the string %o rather than coercing it', (value) => {
            expect(() => resolveAutoCreateSettings(git({auto_create_developers: value}))).toThrow(
                GitAutoCreateConfigError,
            );
        });

        it.each([0, 1, [], {}])('rejects the non-boolean %o', (value) => {
            expect(() => resolveAutoCreateSettings(git({auto_create_developers: value}))).toThrow(
                GitAutoCreateConfigError,
            );
        });

        it('names the offending key in the message', () => {
            expect(() => resolveAutoCreateSettings(git({auto_create_developers: 'false'}))).toThrow(
                /auto_create_developers must be a boolean/,
            );
        });
    });

    describe('team is required and fail-closed when enabled', () => {
        it('accepts a valid team', () => {
            const settings = resolveAutoCreateSettings(
                git({auto_create_developers: true, auto_create_team: 'discovered'}),
            );
            expect(settings).toEqual({enabled: true, team: 'discovered', exclude: []});
        });

        it('trims the team', () => {
            expect(
                resolveAutoCreateSettings(git({auto_create_developers: true, auto_create_team: '  eng  '})).team,
            ).toBe('eng');
        });

        it('rejects a missing team', () => {
            expect(() => resolveAutoCreateSettings(git({auto_create_developers: true}))).toThrow(
                /auto_create_team is required/,
            );
        });

        it('rejects a null team', () => {
            expect(() =>
                resolveAutoCreateSettings(git({auto_create_developers: true, auto_create_team: null})),
            ).toThrow(/auto_create_team is required/);
        });

        it.each(['', '   ', '\t\n'])('rejects the blank team %o', (value) => {
            expect(() =>
                resolveAutoCreateSettings(git({auto_create_developers: true, auto_create_team: value})),
            ).toThrow(/auto_create_team is blank/);
        });

        it('rejects a non-string team', () => {
            expect(() =>
                resolveAutoCreateSettings(git({auto_create_developers: true, auto_create_team: 42})),
            ).toThrow(/auto_create_team must be a string/);
        });

        it('accepts a team exactly at the length bound and rejects one past it', () => {
            const atBound = 'a'.repeat(AUTO_CREATE_TEAM_MAX_LENGTH);
            expect(
                resolveAutoCreateSettings(git({auto_create_developers: true, auto_create_team: atBound})).team,
            ).toBe(atBound);
            expect(() =>
                resolveAutoCreateSettings(
                    git({auto_create_developers: true, auto_create_team: `${atBound}b`}),
                ),
            ).toThrow(/maximum is 100/);
        });
    });

    describe('exclude patterns', () => {
        function compile(patterns: unknown): readonly RegExp[] {
            return resolveAutoCreateSettings(
                git({auto_create_developers: true, auto_create_team: 'eng', auto_create_exclude: patterns}),
            ).exclude;
        }

        it('defaults to empty', () => {
            expect(compile(undefined)).toEqual([]);
        });

        it('matches whole strings, case-insensitively', () => {
            const [re] = compile(['Renovate']);
            expect(re.test('renovate')).toBe(true);
            expect(re.test('RENOVATE')).toBe(true);
            // Anchored: a prefix match must NOT fire, or an operator excluding a bot
            // silently excludes a human whose login starts the same way.
            expect(re.test('renovate-fan')).toBe(false);
            expect(re.test('xrenovate')).toBe(false);
        });

        it('supports * as the only wildcard', () => {
            const [re] = compile(['svc-*']);
            expect(re.test('svc-deploy')).toBe(true);
            expect(re.test('svc-')).toBe(true);
            expect(re.test('mysvc-deploy')).toBe(false);
        });

        it('treats regex metacharacters as literals, not as a pattern language', () => {
            // If `.` compiled as "any char", this would match 'axb'; if `[bot]` compiled as
            // a character class, 'dependabotb' would match. Both are operator surprises.
            const [dot] = compile(['a.b']);
            expect(dot.test('a.b')).toBe(true);
            expect(dot.test('axb')).toBe(false);

            const [cls] = compile(['dependabot[bot]']);
            expect(cls.test('dependabot[bot]')).toBe(true);
            expect(cls.test('dependabotb')).toBe(false);
        });

        it('matches an email-domain pattern', () => {
            const [re] = compile(['*@bots.corp.example']);
            expect(re.test('deploy@bots.corp.example')).toBe(true);
            expect(re.test('alice@corp.example')).toBe(false);
        });

        it('is validated even when the flag is OFF', () => {
            // A typo'd denylist must not lie in wait until the day the flag is flipped on.
            expect(() =>
                resolveAutoCreateSettings(git({auto_create_developers: false, auto_create_exclude: [42]})),
            ).toThrow(/auto_create_exclude\[0\] must be a string/);
        });

        it('rejects a non-array', () => {
            expect(() => compile('renovate')).toThrow(/must be an array of strings/);
        });

        it.each(['', '   '])('rejects the blank pattern %o', (value) => {
            expect(() => compile([value])).toThrow(/is blank/);
        });

        it('rejects more patterns than the cap', () => {
            const tooMany = Array.from({length: AUTO_CREATE_EXCLUDE_MAX_PATTERNS + 1}, (_, i) => `bot${i}`);
            expect(() => compile(tooMany)).toThrow(/the maximum is 200/);
            // The bound itself is accepted — the check is > not >=.
            expect(compile(tooMany.slice(0, AUTO_CREATE_EXCLUDE_MAX_PATTERNS))).toHaveLength(
                AUTO_CREATE_EXCLUDE_MAX_PATTERNS,
            );
        });

        it('rejects a pattern longer than the cap', () => {
            const atBound = 'a'.repeat(AUTO_CREATE_EXCLUDE_MAX_PATTERN_LENGTH);
            expect(compile([atBound])).toHaveLength(1);
            expect(() => compile([`${atBound}b`])).toThrow(/the maximum is 200/);
        });

        it('rejects a pattern with too many wildcards', () => {
            const atBound = '*'.repeat(AUTO_CREATE_EXCLUDE_MAX_WILDCARDS);
            expect(compile([atBound])).toHaveLength(1);
            expect(() => compile([`${atBound}*`])).toThrow(
                new RegExp(`'\\*' wildcards; the maximum is ${AUTO_CREATE_EXCLUDE_MAX_WILDCARDS}`),
            );
        });
    });
});

describe('loadConfig fails closed on invalid auto-create config', () => {
    function writeConfig(body: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toprope-cfg-'));
        const file = path.join(dir, 'toprope.config.yaml');
        fs.writeFileSync(file, body, 'utf-8');
        return file;
    }

    const base = `
server:
  port: 8080
  host: localhost
storage:
  type: sqlite
  sqlite_path: ./data/toprope.db
connectors:
  copilot:
    enabled: false
  claude_code:
    enabled: false
  windsurf:
    enabled: false
  cursor:
    enabled: false
  git:
    enabled: true
`;

    it('loads a valid auto-create config', () => {
        const file = writeConfig(`${base}    auto_create_developers: true\n    auto_create_team: discovered\n`);
        const config = loadConfig(file);
        expect(resolveAutoCreateSettings(config.connectors.git)).toEqual({
            enabled: true,
            team: 'discovered',
            exclude: [],
        });
    });

    it('rejects the flag on with no team, at load time', () => {
        const file = writeConfig(`${base}    auto_create_developers: true\n`);
        expect(() => loadConfig(file)).toThrow(/auto_create_team is required/);
    });

    it('rejects the flag on with a blank team, at load time', () => {
        // Quoted so YAML yields the empty string rather than null — the shape an
        // unset `${ENV}` expansion produces, which is exactly the real-world case.
        const file = writeConfig(
            `${base}    auto_create_developers: true\n    auto_create_team: "\${TOPROPE_TEST_UNSET_TEAM}"\n`,
        );
        expect(() => loadConfig(file)).toThrow(/auto_create_team/);
    });

    it('rejects a non-boolean flag produced by an env expansion, at load time', () => {
        const file = writeConfig(
            `${base}    auto_create_developers: "\${TOPROPE_TEST_UNSET_FLAG}"\n    auto_create_team: eng\n`,
        );
        expect(() => loadConfig(file)).toThrow(/auto_create_developers/);
    });

    it('leaves a config without the keys loadable and disabled', () => {
        const config = loadConfig(writeConfig(base));
        expect(resolveAutoCreateSettings(config.connectors.git).enabled).toBe(false);
    });
});
