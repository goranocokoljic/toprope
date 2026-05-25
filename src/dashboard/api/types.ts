export interface PaginationParams {
    page: number;
    limit: number;
}

export interface PaginatedResponse<T> {
    data: T[];
    pagination: {
        page: number;
        limit: number;
        total: number;
    };
}

export interface DateRangeParams {
    from?: string;
    to?: string;
}

export interface TeamFilterParams {
    team?: string;
}

export function parsePagination(query: Record<string, unknown>): PaginationParams {
    const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
    return {page, limit};
}

export function buildPaginatedResponse<T>(
    items: T[],
    total: number,
    pagination: PaginationParams,
): PaginatedResponse<T> {
    return {
        data: items,
        pagination: {
            page: pagination.page,
            limit: pagination.limit,
            total,
        },
    };
}
