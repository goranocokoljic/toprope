/**
 * Human-facing labels for the tool/connector and git-provider ids the backend
 * stores (e.g. 'claude_code' → 'Claude Code'). Centralised so the overview's
 * tool distribution, connector chips, and provider list all read the same.
 * Unknown ids fall back to a Title-Cased version of the raw id rather than
 * rendering a machine string.
 */

const TOOL_LABELS: Record<string, string> = {
    copilot: 'Copilot',
    claude_code: 'Claude Code',
    windsurf: 'Windsurf',
    cursor: 'Cursor',
};

const PROVIDER_LABELS: Record<string, string> = {
    github: 'GitHub',
    bitbucket: 'Bitbucket',
    gitlab: 'GitLab',
    git: 'Git',
};

/**
 * Human labels for the raw per-feature keys the connectors store in
 * `features_used` (Copilot, Windsurf, Claude Code). Used by the My Tools screen
 * (Task 2.9) so the feature-usage breakdown reads in plain language rather than
 * machine keys. Unknown keys fall back to Title Case.
 */
const FEATURE_LABELS: Record<string, string> = {
    // Copilot
    completions: 'Autocomplete',
    chat: 'Chat',
    chat_insertions: 'Chat insertions',
    chat_copies: 'Chat copies',
    // Windsurf
    autocomplete: 'Autocomplete',
    cascade: 'Cascade (agent)',
    flows: 'Flows',
    // Cursor
    composer: 'Composer (agent)',
    // Claude Code
    commits: 'Commits',
    prs_created: 'PRs created',
};

function titleCase(id: string): string {
    return id
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function toolLabel(id: string): string {
    return TOOL_LABELS[id] ?? titleCase(id);
}

export function providerLabel(id: string): string {
    return PROVIDER_LABELS[id] ?? titleCase(id);
}

export function featureLabel(id: string): string {
    return FEATURE_LABELS[id] ?? titleCase(id);
}
