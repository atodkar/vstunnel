import * as vscode from 'vscode';
import { BridgeServer } from '../server';

export class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
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

    getTreeItem(element: StatusItem): vscode.TreeItem {
        return element;
    }

    getChildren(): StatusItem[] {
        if (!this.server) {
            return [new StatusItem('Bridge', 'Not running', 'warning')];
        }

        return [
            new StatusItem('Status', this.server.isRunning ? 'Running' : 'Stopped', this.server.isRunning ? 'pass' : 'error'),
            new StatusItem('Port', `${this.server.port}`, 'info'),
            new StatusItem('Clients', `${this.server.connectedClients} connected`, 'info'),
            new StatusItem('Prompts', `${this.server.totalPrompts} sent`, 'info'),
            new StatusItem('Uptime', `${Math.floor(this.server.uptimeSeconds / 60)}m`, 'info'),
            new StatusItem('Token', this.server.authToken ? '••••' + this.server.authToken.slice(-4) : 'None', 'info'),
        ];
    }
}

class StatusItem extends vscode.TreeItem {
    constructor(label: string, value: string, icon: string) {
        super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon === 'pass' ? 'check' : icon === 'error' ? 'error' : icon === 'warning' ? 'warning' : 'info');
    }
}
