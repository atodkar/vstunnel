import * as vscode from 'vscode';
import { DiffSummary, FileDiffEntry } from './types';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class DiffGenerator implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private lastDiffHash: string = '';
    private onDiffEmitter = new vscode.EventEmitter<DiffSummary>();
    public readonly onDiff = this.onDiffEmitter.event;

    private static readonly POLL_INTERVAL_MS = 5000;
    private static readonly MAX_DIFF_SIZE = 50 * 1024;

    constructor(private workspacePath: string) {
        this.start();
    }

    private start(): void {
        this.timer = setInterval(() => this.generateDiff(), DiffGenerator.POLL_INTERVAL_MS);
        this.generateDiff();
    }

    async generateDiff(): Promise<DiffSummary | null> {
        try {
            const [statResult, diffResult] = await Promise.all([
                this.runGit(['diff', '--stat', 'HEAD']),
                this.runGit(['diff', 'HEAD']),
            ]);

            const hash = this.simpleHash(statResult);
            if (hash === this.lastDiffHash) return null;
            this.lastDiffHash = hash;

            const summary = this.parseDiffStat(statResult);
            let fullDiff = diffResult;
            if (fullDiff.length > DiffGenerator.MAX_DIFF_SIZE) {
                fullDiff = fullDiff.substring(0, DiffGenerator.MAX_DIFF_SIZE) + '\n... (truncated)';
            }
            summary.fullDiff = fullDiff;

            this.onDiffEmitter.fire(summary);
            return summary;
        } catch {
            return null;
        }
    }

    async getFileDiff(filePath: string): Promise<string> {
        try {
            return await this.runGit(['diff', 'HEAD', '--', filePath]);
        } catch {
            return '';
        }
    }

    async revertFile(filePath: string): Promise<boolean> {
        try {
            await this.runGit(['checkout', 'HEAD', '--', filePath]);
            return true;
        } catch {
            return false;
        }
    }

    private async runGit(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync('git', args, {
            cwd: this.workspacePath,
            maxBuffer: 1024 * 1024,
            timeout: 10000,
        });
        return stdout;
    }

    private parseDiffStat(stat: string): DiffSummary {
        const files: FileDiffEntry[] = [];
        let totalInsertions = 0;
        let totalDeletions = 0;
        const lines = stat.trim().split('\n');

        for (const line of lines) {
            const fileMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)/);
            if (fileMatch) {
                const filePath = fileMatch[1].trim();
                const plusCount = (line.match(/\+/g) || []).length;
                const minusCount = (line.match(/-/g) || []).length;
                let status: FileDiffEntry['status'] = 'modified';
                if (line.includes('(new)')) status = 'added';
                else if (line.includes('(gone)')) status = 'deleted';

                files.push({ filePath, insertions: plusCount, deletions: minusCount, status });
                totalInsertions += plusCount;
                totalDeletions += minusCount;
            }

            const summaryMatch = line.match(/(\d+) insertions?\(\+\)/);
            const delMatch = line.match(/(\d+) deletions?\(-\)/);
            if (summaryMatch) totalInsertions = parseInt(summaryMatch[1]);
            if (delMatch) totalDeletions = parseInt(delMatch[1]);
        }

        return {
            filesChanged: files.length,
            insertions: totalInsertions,
            deletions: totalDeletions,
            files,
            fullDiff: '',
        };
    }

    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString(36);
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.onDiffEmitter.dispose();
    }
}
