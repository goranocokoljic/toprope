import type {GitCommit, GitPR, GitReviewComment, GitFileDiff} from './providers/types.js';

export interface AnalysisFileDiff {
    path: string;
    additions: number;
    deletions: number;
    status: string;
}

export interface AnalysisCommit {
    sha: string;
    authorLogin: string | null;
    authorEmail: string | null;
    date: string;
    message: string;
    additions: number;
    deletions: number;
    fileDiffs: AnalysisFileDiff[];
}

export interface AnalysisPR {
    id: string;
    authorLogin: string | null;
    createdAt: string;
    mergedAt: string | null;
}

export interface AnalysisReviewComment {
    authorLogin: string | null;
    createdAt: string;
}

export function toAnalysisCommit(commit: GitCommit, diffs: GitFileDiff[]): AnalysisCommit {
    return {
        sha: commit.sha,
        // Use email as fallback when username is absent — enables email-based dev mapping
        authorLogin: commit.author.username || commit.author.email || null,
        authorEmail: commit.author.email || null,
        date: commit.date,
        message: commit.message,
        additions: commit.additions,
        deletions: commit.deletions,
        fileDiffs: diffs.map((d) => ({
            path: d.path,
            additions: d.additions,
            deletions: d.deletions,
            status: d.status,
        })),
    };
}

export function toAnalysisPR(pr: GitPR): AnalysisPR {
    return {
        id: pr.id,
        authorLogin: pr.author.username || null,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
    };
}

export function toAnalysisReviewComment(comment: GitReviewComment): AnalysisReviewComment {
    return {
        authorLogin: comment.author.username || null,
        createdAt: comment.createdAt,
    };
}
