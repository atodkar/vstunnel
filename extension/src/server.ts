import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';

export interface BridgeServerOptions {
    port: number;
    requireToken: boolean;
    workspaceName: string;
    workspacePath: string | undefined;
    context: vscode.ExtensionContext;
    onPrompt: (prompt: string) => Promise<{ status: string; message: string }>;
    onStatusChange: () => void;
    onHistoryChange: () => void;
}

interface PromptHistoryEntry {
    prompt: string;
    result: string;
    workspace: string;
    timestamp: string;
}

export class BridgeServer {
    private wss: WebSocketServer | null = null;
    private clients: Set<WebSocket> = new Set();
    private options: BridgeServerOptions;
    private startTime: Date = new Date();
    private _totalPrompts: number = 0;
    private _history: PromptHistoryEntry[] = [];
    private _authToken: string | null = null;
    private _tunnelUrl: string | null = null;
    private statusInterval: NodeJS.Timeout | null = null;

    constructor(options: BridgeServerOptions) {
        this.options = options;
        if (options.requireToken) {
            this._authToken = this.loadOrGenerateToken(options.context);
        }
    }

    get isRunning(): boolean {
        return this.wss !== null;
    }

    get port(): number {
        return this.options.port;
    }

    get connectedClients(): number {
        return this.clients.size;
    }

    get totalPrompts(): number {
        return this._totalPrompts;
    }

    get history(): PromptHistoryEntry[] {
        return this._history;
    }

    get authToken(): string | null {
        return this._authToken;
    }

    get tunnelUrl(): string | null {
        return this._tunnelUrl;
    }

    get uptimeSeconds(): number {
        return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: this.options.port, host: 'localhost' });

            this.wss.on('listening', () => {
                this.startTime = new Date();
                this.startStatusBroadcast();
                this.options.onStatusChange();
                resolve();
            });

            this.wss.on('error', (err) => {
                reject(err);
            });

            this.wss.on('connection', (ws, req) => {
                this.handleConnection(ws, req);
            });
        });
    }

    async stop(): Promise<void> {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
        }

        for (const client of this.clients) {
            client.close(1001, 'Server shutting down');
        }
        this.clients.clear();

        return new Promise((resolve) => {
            if (this.wss) {
                this.wss.close(() => {
                    this.wss = null;
                    this.options.onStatusChange();
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private handleConnection(ws: WebSocket, req: any) {
        this.clients.add(ws);
        this.options.onStatusChange();

        // Send welcome message
        this.send(ws, {
            type: 'WELCOME',
            version: '1.0.0',
            workspace: this.options.workspaceName,
            workspace_path: this.options.workspacePath,
            requires_auth: this.options.requireToken,
            authenticated: !this.options.requireToken,
        });

        let authenticated = !this.options.requireToken;

        ws.on('message', async (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                const msgType = data.type;

                // Authentication gate
                if (!authenticated) {
                    if (msgType === 'AUTH') {
                        if (data.token === this._authToken) {
                            authenticated = true;
                            this.send(ws, { type: 'AUTH_OK' });
                        } else {
                            this.send(ws, { type: 'AUTH_FAILED', message: 'Invalid token' });
                            ws.close(4001, 'Authentication failed');
                        }
                        return;
                    }
                    this.send(ws, { type: 'ERROR', message: 'Authentication required' });
                    return;
                }

                // Authenticated message handling
                switch (msgType) {
                    case 'PROMPT':
                        await this.handlePrompt(ws, data);
                        break;
                    case 'PING':
                        this.send(ws, { type: 'PONG', timestamp: new Date().toISOString() });
                        break;
                    case 'HISTORY':
                        this.send(ws, {
                            type: 'HISTORY_RESPONSE',
                            history: this._history.slice(-20),
                        });
                        break;
                    case 'GET_STATUS':
                        this.sendStatus(ws);
                        break;
                    default:
                        this.send(ws, { type: 'ERROR', message: `Unknown type: ${msgType}` });
                }
            } catch (err: any) {
                this.send(ws, { type: 'ERROR', message: 'Invalid message format' });
            }
        });

        ws.on('close', () => {
            this.clients.delete(ws);
            this.options.onStatusChange();
        });

        ws.on('error', () => {
            this.clients.delete(ws);
            this.options.onStatusChange();
        });
    }

    private async handlePrompt(ws: WebSocket, data: any) {
        const prompt = (data.payload || '').trim();
        if (!prompt) {
            this.send(ws, { type: 'ERROR', message: 'Empty prompt' });
            return;
        }

        if (prompt.length > 10000) {
            this.send(ws, { type: 'ERROR', message: 'Prompt too long (max 10000 chars)' });
            return;
        }

        const result = await this.options.onPrompt(prompt);
        this._totalPrompts++;

        const entry: PromptHistoryEntry = {
            prompt: prompt.substring(0, 200),
            result: result.status,
            workspace: this.options.workspaceName,
            timestamp: new Date().toISOString(),
        };
        this._history.push(entry);
        if (this._history.length > 100) {
            this._history = this._history.slice(-100);
        }

        this.send(ws, {
            type: 'PROMPT_ACK',
            result,
            workspace: this.options.workspaceName,
            timestamp: new Date().toISOString(),
        });

        this.options.onHistoryChange();
    }

    private startStatusBroadcast() {
        this.statusInterval = setInterval(() => {
            this.broadcastStatus();
        }, 3000);
    }

    private broadcastStatus() {
        const status = {
            type: 'STATUS_UPDATE',
            status: 'READY_AND_LISTENING',
            workspace: this.options.workspaceName,
            workspace_path: this.options.workspacePath,
            connected_clients: this.clients.size,
            uptime: this.uptimeSeconds,
            total_prompts: this._totalPrompts,
            timestamp: new Date().toISOString(),
        };

        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(status));
            }
        }
    }

    private sendStatus(ws: WebSocket) {
        this.send(ws, {
            type: 'STATUS_UPDATE',
            status: 'READY_AND_LISTENING',
            workspace: this.options.workspaceName,
            workspace_path: this.options.workspacePath,
            connected_clients: this.clients.size,
            uptime: this.uptimeSeconds,
            total_prompts: this._totalPrompts,
            timestamp: new Date().toISOString(),
        });
    }

    private send(ws: WebSocket, data: object) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    private loadOrGenerateToken(context: vscode.ExtensionContext): string {
        let token = context.globalState.get<string>('vstunnel.authToken');
        if (!token) {
            token = crypto.randomBytes(16).toString('hex');
            context.globalState.update('vstunnel.authToken', token);
        }
        return token;
    }
}
