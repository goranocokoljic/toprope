export interface Team {
    name: string;
    department: string | null;
    manager: string | null;
    created_at: string;
}

export interface ExternalIds {
    github?: string;
    copilot?: string;
    claude?: string;
    windsurf?: string;
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
