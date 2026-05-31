import * as vscode from 'vscode';

export interface FileEditData {
    filePath: string;
    changeType: 'modified' | 'created' | 'deleted' | 'renamed';
    diff?: string;
    linesAdded: number;
    linesRemoved: number;
}

export interface TerminalData {
    terminalId: string;
    terminalName: string;
    text: string;
    isCommand: boolean;
}

export interface ApprovalData {
    id: string;
    approvalType: 'terminal_command' | 'file_edit' | 'unknown';
    description: string;
    terminalId?: string;
    affectedFiles?: string[];
    status: 'pending' | 'accepted' | 'rejected' | 'expired';
}

export interface DiffSummary {
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: FileDiffEntry[];
    fullDiff: string;
}

export interface FileDiffEntry {
    filePath: string;
    insertions: number;
    deletions: number;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
}

export type ActivityType =
    | 'file_edit'
    | 'file_create'
    | 'file_delete'
    | 'terminal_command'
    | 'terminal_output'
    | 'approval_pending'
    | 'approval_resolved'
    | 'prompt_sent';

export interface AgentActivity {
    id: string;
    timestamp: string;
    type: ActivityType;
    data: FileEditData | TerminalData | ApprovalData | { prompt: string };
}

export interface InstanceInfo {
    instanceId: string;
    workspaceName: string;
    workspacePath: string;
    status: 'active' | 'idle' | 'offline';
    pendingApprovals: number;
    filesChanged: number;
}

export interface MonitorEvent {
    type: string;
    instanceId: string;
    workspace: string;
    seq: number;
    [key: string]: unknown;
}

export interface MonitorEventEmitter {
    on(event: 'activity', listener: (activity: AgentActivity) => void): void;
    on(event: 'diff', listener: (diff: DiffSummary) => void): void;
    on(event: 'terminal', listener: (data: TerminalData) => void): void;
    on(event: 'approval', listener: (approval: ApprovalData) => void): void;
    dispose(): void;
}
