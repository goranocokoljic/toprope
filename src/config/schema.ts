// Plain JSON Schema for toprope.config.yaml validation
export const configSchema: Record<string, unknown> = {
    type: 'object',
    required: ['server', 'storage', 'connectors'],
    additionalProperties: true,
    properties: {
        server: {
            type: 'object',
            required: ['port', 'host'],
            properties: {
                port: {type: 'integer', minimum: 1, maximum: 65535},
                host: {type: 'string'},
            },
        },
        storage: {
            type: 'object',
            required: ['type', 'sqlite_path'],
            properties: {
                type: {type: 'string', enum: ['sqlite']},
                sqlite_path: {type: 'string'},
            },
        },
        connectors: {
            type: 'object',
            required: ['copilot', 'claude_code', 'windsurf', 'cursor', 'git'],
            properties: {
                copilot: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                        enabled: {type: 'boolean'},
                    },
                },
                claude_code: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                        enabled: {type: 'boolean'},
                    },
                },
                windsurf: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                        enabled: {type: 'boolean'},
                    },
                },
                cursor: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                        enabled: {type: 'boolean'},
                    },
                },
                git: {
                    type: 'object',
                    required: ['enabled'],
                    properties: {
                        enabled: {type: 'boolean'},
                        // DO1.6 (#256). Shape only — the AUTHORITATIVE narrowing lives in
                        // `resolveAutoCreateSettings`, which the loader calls after this
                        // schema passes. Both run: the schema gives a good message for the
                        // common typo, the resolver is what the sync write path also calls.
                        auto_create_developers: {type: 'boolean'},
                        auto_create_team: {type: 'string', minLength: 1},
                        auto_create_exclude: {type: 'array', items: {type: 'string', minLength: 1}},
                    },
                },
            },
        },
        teams: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {type: 'string'},
                },
            },
        },
    },
};
