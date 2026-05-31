import * as vscode from 'vscode';
import { AgentActivity, FileEditData } from './types';
import { randomUUID } from 'crypto';

export class FileTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private onActivityEmitter = new vscode.EventEmitter<AgentActivity>();
    public readonly onActivity = this.onActivityEmitter.event;

    private static readonly DEBOUNCE_MS = 500;
    private static readonly IGNORED_PATTERNS = [
        /node_modules/,
        /\.git\//,
        /\.vscodeignore/,
        /package-lock\.json$/,
        /yarn\.lock$/,
        /\.DS_Store$/,
    ];

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => this.handleDocChange(e)),
            vscode.workspace.onDidCreateFiles(e => this.handleCreate(e)),
            vscode.workspace.onDidDeleteFiles(e => this.handleDelete(e)),
            vscode.workspace.onDidRenameFiles(e => this.handleRename(e)),
            this.onActivityEmitter,
        );
    }

    private shouldIgnore(uri: vscode.Uri): boolean {
        const path = uri.fsPath;
        return FileTracker.IGNORED_PATTERNS.some(p => p.test(path));
    }

    private handleDocChange(e: vscode.TextDocumentChangeEvent): void {
        if (e.document.uri.scheme !== 'file') return;
        if (this.shouldIgnore(e.document.uri)) return;
        if (e.contentChanges.length === 0) return;

        const filePath = vscode.workspace.asRelativePath(e.document.uri);
        const key = filePath;

        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        let linesAdded = 0;
        let linesRemoved = 0;
        for (const change of e.contentChanges) {
            const newLines = change.text.split('\n').length - 1;
            const oldLines = change.range.end.line - change.range.start.line;
            linesAdded += newLines;
            linesRemoved += oldLines;
        }

        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            const activity: AgentActivity = {
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: 'file_edit',
                data: {
                    filePath,
                    changeType: 'modified',
                    linesAdded,
                    linesRemoved,
                } as FileEditData,
            };
            this.onActivityEmitter.fire(activity);
        }, FileTracker.DEBOUNCE_MS));
    }

    private handleCreate(e: vscode.FileCreateEvent): void {
        for (const uri of e.files) {
            if (this.shouldIgnore(uri)) continue;
            const filePath = vscode.workspace.asRelativePath(uri);
            const activity: AgentActivity = {
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: 'file_create',
                data: {
                    filePath,
                    changeType: 'created',
                    linesAdded: 0,
                    linesRemoved: 0,
                } as FileEditData,
            };
            this.onActivityEmitter.fire(activity);
        }
    }

    private handleDelete(e: vscode.FileDeleteEvent): void {
        for (const uri of e.files) {
            if (this.shouldIgnore(uri)) continue;
            const filePath = vscode.workspace.asRelativePath(uri);
            const activity: AgentActivity = {
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: 'file_delete',
                data: {
                    filePath,
                    changeType: 'deleted',
                    linesAdded: 0,
                    linesRemoved: 0,
                } as FileEditData,
            };
            this.onActivityEmitter.fire(activity);
        }
    }

    private handleRename(e: vscode.FileRenameEvent): void {
        for (const { oldUri, newUri } of e.files) {
            if (this.shouldIgnore(newUri)) continue;
            const filePath = vscode.workspace.asRelativePath(newUri);
            const activity: AgentActivity = {
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: 'file_edit',
                data: {
                    filePath,
                    changeType: 'renamed',
                    linesAdded: 0,
                    linesRemoved: 0,
                } as FileEditData,
            };
            this.onActivityEmitter.fire(activity);
        }
    }

    dispose(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.disposables.forEach(d => d.dispose());
    }
}
