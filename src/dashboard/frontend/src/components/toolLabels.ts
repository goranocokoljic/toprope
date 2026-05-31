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
};

const PROVIDER_LABELS: Record<string, string> = {
    github: 'GitHub',
    bitbucket: 'Bitbucket',
    gitlab: 'GitLab',
    git: 'Git',
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
