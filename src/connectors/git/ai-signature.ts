import type {GitCommit} from './client';

export interface AiSignatureResult {
    estimated_score: number;
    signals: string[];
}

// Heuristic thresholds — deliberately conservative to avoid false positives
const LARGE_COMMIT_ADDITIONS_THRESHOLD = 300;
const BULK_NEW_FILES_THRESHOLD = 5;
const BULK_ERROR_HANDLING_THRESHOLD = 10;

const ERROR_HANDLING_PATTERN = /\b(try|catch|throw|Error|exception|handleError|onError)\b/gi;
const BOILERPLATE_EXTENSIONS = ['.ts', '.js', '.py', '.java', '.go', '.cs'];

function isBoilerplateExtension(filename: string): boolean {
    return BOILERPLATE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

function countErrorHandlingLines(message: string): number {
    const matches = message.match(ERROR_HANDLING_PATTERN);
    return matches?.length ?? 0;
}

export function scoreAiSignature(commit: GitCommit): AiSignatureResult {
    const signals: string[] = [];
    let score = 0;

    const totalLines = commit.additions + commit.deletions;
    const newFiles = commit.files.filter((f) => f.status === 'added');
    const boilerplateNewFiles = newFiles.filter((f) => isBoilerplateExtension(f.filename));

    // Signal 1: Very large commit with many additions
    if (commit.additions >= LARGE_COMMIT_ADDITIONS_THRESHOLD && commit.files_changed >= 3) {
        score += 25;
        signals.push(`large_commit:${commit.additions}_additions_${commit.files_changed}_files`);
    }

    // Signal 2: Multiple new boilerplate files in single commit
    if (boilerplateNewFiles.length >= BULK_NEW_FILES_THRESHOLD) {
        score += 30;
        signals.push(`bulk_new_files:${boilerplateNewFiles.length}`);
    }

    // Signal 3: Bulk error handling additions in commit message or large ratio of error handling
    const errorHandlingCount = countErrorHandlingLines(commit.message);
    const avgAdditionsPerFile = commit.files_changed > 0 ? commit.additions / commit.files_changed : 0;
    if (
        errorHandlingCount >= BULK_ERROR_HANDLING_THRESHOLD ||
        (avgAdditionsPerFile > 50 && commit.additions > 200 && commit.files_changed > 3)
    ) {
        score += 20;
        signals.push(`bulk_error_handling:${errorHandlingCount}_mentions`);
    }

    // Signal 4: High additions with very few deletions (new code only — typical of AI generation)
    if (totalLines > 500 && commit.deletions === 0 && commit.files_changed >= 3) {
        score += 15;
        signals.push(`zero_deletions_large:${totalLines}_lines`);
    }

    // Signal 5: Uniformly large files (consistent generation pattern)
    if (commit.files.length >= 3) {
        const perFileAdditions = commit.files.map((f) => f.additions);
        const min = Math.min(...perFileAdditions);
        const max = Math.max(...perFileAdditions);
        // All files within 20% of each other and all large
        if (min > 30 && max > 0 && min / max >= 0.8) {
            score += 10;
            signals.push(`uniform_file_sizes:${min}-${max}_lines`);
        }
    }

    return {
        estimated_score: Math.min(score, 100),
        signals,
    };
}
