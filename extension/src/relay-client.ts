import * as vscode from 'vscode';
import WebSocket from 'ws';
import { CopilotMonitor } from './monitor';
import { randomUUID } from 'crypto';

export class RelayClient implements vscode.Disposable {
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | undefined;
    private reconnectDelay = 2000;
    private instanceId: string;
    private disposed = false;

    private onCommandEmitter = new vscode.EventEmitter<{ type: string; [key: string]: unknown }>();
    public readonly onCommand = this.onCommandEmitter.event;

    private onStatusChangeEmitter = new vscode.EventEmitter<'connected' | 'disconnected' | 'reconnecting'>();
    public readonly onStatusChange = this.onStatusChangeEmitter.event;

    constructor(
        private relayUrl: string,
        private userId: string,
        private workspaceName: string,
        private workspacePath: string,
        private monitor: CopilotMonitor,
        private context: vscode.ExtensionContext,
    ) {
        this.instanceId = this.getOrCreateInstanceId();
        this.setupMonitorForwarding();
        this.connect();
    }

    private getOrCreateInstanceId(): string {
        const stored = this.context.workspaceState.get<string>('vstunnel.instanceId');
        if (stored) return stored;
        const id = 'inst_' + randomUUID().replace(/-/g, '').substring(0, 12);
        this.context.workspaceState.update('vstunnel.instanceId', id);
        return id;
    }

    private setupMonitorForwarding(): void {
        this.monitor.onEvent(event => {
            this.send({
                type: 'PUSH_EVENT',
                event: {
                    ...event.payload as object,
                    type: event.type,
                    instance_id: this.instanceId,
                    workspace: this.workspaceName,
                },
            });
        });
    }

    private connect(): void {
        if (this.disposed) return;

        const wsUrl = this.relayUrl
            .replace(/^https:\/\//, 'wss://')
            .replace(/^http:\/\//, 'ws://')
            .replace(/\/$/, '') + '/ws/laptop';

        try {
            this.ws = new WebSocket(wsUrl);
        } catch {
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            this.reconnectDelay = 2000;
            this.onStatusChangeEmitter.fire('connected');
            this.register();
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch { /* ignore malformed */ }
        });

        this.ws.on('close', () => {
            this.onStatusChangeEmitter.fire('disconnected');
            this.scheduleReconnect();
        });

        this.ws.on('error', () => {
            this.ws?.close();
        });
    }

    private register(): void {
        this.send({
            type: 'REGISTER',
            user_id: this.userId,
            instance_id: this.instanceId,
            workspace_name: this.workspaceName,
            workspace_path: this.workspacePath,
        });
    }

    private handleMessage(msg: Record<string, unknown>): void {
        const type = msg.type as string;

        switch (type) {
            case 'REGISTERED':
                const token = msg.token as string;
                vscode.window.showInformationMessage(
                    `vstunnel: Registered as '${this.userId}'. Phone token: ${token}`
                );
                break;

            case 'INJECT_PROMPT':
            case 'ACCEPT_APPROVAL':
            case 'REJECT_APPROVAL':
            case 'GET_DIFF':
            case 'GET_STATE':
            case 'REVERT_FILE':
            case 'TERMINAL_INPUT':
                this.onCommandEmitter.fire(msg as { type: string; [key: string]: unknown });
                break;
        }
    }

    send(data: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    private scheduleReconnect(): void {
        if (this.disposed) return;
        this.onStatusChangeEmitter.fire('reconnecting');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
            this.connect();
        }, this.reconnectDelay);
    }

    getInstanceId(): string {
        return this.instanceId;
    }

    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.onCommandEmitter.dispose();
        this.onStatusChangeEmitter.dispose();
    }
}
