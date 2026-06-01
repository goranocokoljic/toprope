export interface Team {
    name: string;
    department: string | null;
    manager: string | null;
    created_at: string;
    // Set when the team is archived (Task 2.13). An archived team is hidden from
    // active management but retained so historical data referencing it survives.
    archived_at: string | null;
}

export interface ExternalIds {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
    bitbucket?: string;
    gitlab?: string;
    // Comma-separated list of additional git commit emails used to match
    // commits to this developer (beyond the primary `email` column).
    git_emails?: string;
    [key: string]: string | undefined;
}

export interface Developer {
    id: string;
    name: string;
    email: string | null;
    team: string;
    external_ids: ExternalIds;
    created_at: string;
}
