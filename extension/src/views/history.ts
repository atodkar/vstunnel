import * as vscode from 'vscode';
import { BridgeServer } from '../server';

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private server: BridgeServer | undefined;

    setServer(server: BridgeServer | undefined) {
        this.server = server;
        this.refresh();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HistoryItem[] {
        if (!this.server || this.server.history.length === 0) {
            return [new HistoryItem('No prompts yet', '', 'info')];
        }

        return this.server.history
            .slice(-20)
            .reverse()
            .map(entry => new HistoryItem(
                entry.prompt.substring(0, 60),
                entry.timestamp,
                entry.result === 'SUCCESS' ? 'pass' : 'error'
            ));
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(prompt: string, timestamp: string, status: string) {
        super(prompt, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(status === 'pass' ? 'check' : status === 'error' ? 'error' : 'info');
        if (timestamp) {
            this.description = new Date(timestamp).toLocaleTimeString();
        }
    }
}
