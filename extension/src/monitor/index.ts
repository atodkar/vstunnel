import * as vscode from 'vscode';
import { FileTracker } from './file-tracker';
import { DiffGenerator } from './diff-generator';
import { PromptInjector } from './prompt-injector';
import { AgentActivity, DiffSummary } from './types';

export class CopilotMonitor implements vscode.Disposable {
    public readonly fileTracker: FileTracker;
    public readonly diffGenerator: DiffGenerator;
    public readonly promptInjector: PromptInjector;

    private onEventEmitter = new vscode.EventEmitter<{ type: string; payload: unknown }>();
    public readonly onEvent = this.onEventEmitter.event;

    private seq = 0;
    private disposables: vscode.Disposable[] = [];

    constructor(workspacePath: string) {
        this.fileTracker = new FileTracker();
        this.diffGenerator = new DiffGenerator(workspacePath);
        this.promptInjector = new PromptInjector();

        this.disposables.push(
            this.fileTracker.onActivity(activity => this.emitActivity(activity)),
            this.promptInjector.onActivity(activity => this.emitActivity(activity)),
            this.diffGenerator.onDiff(diff => this.emitDiff(diff)),
            this.onEventEmitter,
        );
    }

    private emitActivity(activity: AgentActivity): void {
        this.onEventEmitter.fire({
            type: 'AGENT_ACTIVITY',
            payload: { seq: ++this.seq, activity },
        });
    }

    private emitDiff(diff: DiffSummary): void {
        this.onEventEmitter.fire({
            type: 'DIFF_SUMMARY',
            payload: { seq: ++this.seq, ...diff },
        });
    }

    dispose(): void {
        this.fileTracker.dispose();
        this.diffGenerator.dispose();
        this.promptInjector.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

export { FileTracker } from './file-tracker';
export { DiffGenerator } from './diff-generator';
export { PromptInjector } from './prompt-injector';
export * from './types';
