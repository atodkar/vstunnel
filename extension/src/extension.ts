import * as vscode from 'vscode';
import { BridgeServer } from './server';
import { StatusProvider } from './views/status';
import { HistoryProvider } from './views/history';
import { CopilotMonitor } from './monitor';
import { RelayClient } from './relay-client';

let server: BridgeServer | undefined;
let monitor: CopilotMonitor | undefined;
let relayClient: RelayClient | undefined;
let statusProvider: StatusProvider;
let historyProvider: HistoryProvider;

export function activate(context: vscode.ExtensionContext) {
    statusProvider = new StatusProvider();
    historyProvider = new HistoryProvider();

    vscode.window.registerTreeDataProvider('vstunnel.status', statusProvider);
    vscode.window.registerTreeDataProvider('vstunnel.history', historyProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('vstunnel.start', () => startBridge(context)),
        vscode.commands.registerCommand('vstunnel.stop', () => stopBridge()),
        vscode.commands.registerCommand('vstunnel.showQR', () => showQRCode(context)),
        vscode.commands.registerCommand('vstunnel.status', () => showStatus()),
    );

    const config = vscode.workspace.getConfiguration('vstunnel');
    if (config.get<boolean>('autoStart')) {
        startBridge(context);
    }
}

async function startBridge(context: vscode.ExtensionContext) {
    if (server?.isRunning) {
        vscode.window.showInformationMessage('vstunnel bridge is already running.');
        return;
    }

    const config = vscode.workspace.getConfiguration('vstunnel');
    const port = config.get<number>('port') ?? 8100;
    const requireToken = config.get<boolean>('requireToken') ?? true;
    const autoForward = config.get<boolean>('autoForward') ?? true;
    const relayUrl = config.get<string>('relayUrl') ?? '';
    const userId = config.get<string>('userId') ?? process.env.USER ?? 'developer';

    const workspaceName = vscode.workspace.name || 'Untitled';
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // Start the Copilot monitor
    monitor = new CopilotMonitor(workspacePath);
    context.subscriptions.push(monitor);

    // Start local WebSocket server for direct connections
    server = new BridgeServer({
        port,
        requireToken,
        workspaceName,
        workspacePath,
        context,
        onPrompt: handlePrompt,
        onStatusChange: () => statusProvider.refresh(),
        onHistoryChange: () => historyProvider.refresh(),
        monitor,
    });

    await server.start();

    // Connect to relay if configured
    if (relayUrl) {
        relayClient = new RelayClient(
            relayUrl, userId, workspaceName, workspacePath, monitor, context
        );
        context.subscriptions.push(relayClient);

        relayClient.onCommand(cmd => handleRelayCommand(cmd));
        relayClient.onStatusChange(status => {
            statusProvider.refresh();
        });
    }

    if (autoForward && !relayUrl) {
        await forwardPort(port);
    }

    statusProvider.setServer(server);
    historyProvider.setServer(server);

    const modeMsg = relayUrl
        ? `vstunnel: Connected to relay (${relayUrl})`
        : `vstunnel: Bridge on port ${port}. Forward in Ports panel.`;

    vscode.window.showInformationMessage(modeMsg, 'Show QR Code').then(action => {
        if (action === 'Show QR Code') showQRCode(context);
    });
}

async function stopBridge() {
    if (relayClient) {
        relayClient.dispose();
        relayClient = undefined;
    }
    if (monitor) {
        monitor.dispose();
        monitor = undefined;
    }
    if (server) {
        await server.stop();
        server = undefined;
        statusProvider.setServer(undefined);
        historyProvider.setServer(undefined);
    }
    vscode.window.showInformationMessage('vstunnel bridge stopped.');
}

async function handlePrompt(prompt: string): Promise<{ status: string; message: string }> {
    if (monitor) {
        const success = await monitor.promptInjector.injectPrompt(prompt, 'active_session');
        if (success) {
            return { status: 'SUCCESS', message: 'Prompt sent to Copilot Chat' };
        }
    }

    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        return { status: 'SUCCESS', message: 'Prompt sent to Copilot Chat panel' };
    } catch (error: any) {
        return { status: 'ERROR', message: error.message || 'Unknown error' };
    }
}

async function handleRelayCommand(cmd: { type: string; [key: string]: unknown }) {
    if (!monitor) return;

    switch (cmd.type) {
        case 'INJECT_PROMPT': {
            const prompt = cmd.prompt as string;
            const target = (cmd.target as 'active_session' | 'new_chat' | 'inline') || 'active_session';
            const success = await monitor.promptInjector.injectPrompt(prompt, target);
            relayClient?.send({
                type: 'COMMAND_RESULT',
                command: 'INJECT_PROMPT',
                success,
                message: success ? 'Prompt delivered' : 'Failed to inject prompt',
            });
            break;
        }

        case 'GET_DIFF': {
            const diff = await monitor.diffGenerator.generateDiff();
            relayClient?.send({
                type: 'COMMAND_RESULT',
                command: 'GET_DIFF',
                success: true,
                data: diff,
            });
            break;
        }

        case 'REVERT_FILE': {
            const filePath = cmd.filePath as string;
            const success = await monitor.diffGenerator.revertFile(filePath);
            relayClient?.send({
                type: 'COMMAND_RESULT',
                command: 'REVERT_FILE',
                success,
                message: success ? `Reverted ${filePath}` : `Failed to revert ${filePath}`,
            });
            break;
        }

        case 'GET_STATE': {
            const diff = await monitor.diffGenerator.generateDiff();
            relayClient?.send({
                type: 'COMMAND_RESULT',
                command: 'GET_STATE',
                success: true,
                data: {
                    workspaceName: vscode.workspace.name,
                    activeTerminals: vscode.window.terminals.map(t => t.name),
                    filesChanged: diff?.filesChanged ?? 0,
                },
            });
            break;
        }
    }
}

async function forwardPort(port: number) {
    try {
        await vscode.commands.executeCommand('remote-tunnels.forwardPort', { port });
    } catch { /* not available */ }
}

async function showQRCode(context: vscode.ExtensionContext) {
    if (!server?.isRunning) {
        vscode.window.showWarningMessage('Start the bridge first: vstunnel: Start Mobile Bridge');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'vstunnelQR', 'vstunnel - Connect', vscode.ViewColumn.One, { enableScripts: true }
    );

    const tunnelUrl = server.tunnelUrl || `localhost:${server.port}`;
    const token = server.authToken || '';

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: system-ui; padding: 2rem; text-align: center; background: #1e1e1e; color: #fff; }
        .url { font-family: monospace; background: #333; padding: 0.5rem 1rem; border-radius: 8px; margin: 1rem 0; word-break: break-all; }
        .token { color: #f59e0b; font-family: monospace; }
        .copy-btn { background: #0066ff; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin: 0.5rem; }
    </style>
</head>
<body>
    <h1>Connect Your Phone</h1>
    <p>Relay URL or Tunnel URL:</p>
    <div class="url">${tunnelUrl}</div>
    <button class="copy-btn" onclick="navigator.clipboard.writeText('${tunnelUrl}')">Copy URL</button>
    ${token ? `<p>Auth Token: <span class="token">${token}</span></p><button class="copy-btn" onclick="navigator.clipboard.writeText('${token}')">Copy Token</button>` : ''}
</body>
</html>`;
}

function showStatus() {
    if (!server) {
        vscode.window.showInformationMessage('vstunnel bridge is not running.');
        return;
    }
    const clients = server.connectedClients;
    const uptime = server.uptimeSeconds;
    const relay = relayClient ? ' | Relay: connected' : '';
    vscode.window.showInformationMessage(
        `vstunnel: ${clients} client(s) | Uptime: ${Math.floor(uptime / 60)}m${relay}`
    );
}

export function deactivate() {
    relayClient?.dispose();
    monitor?.dispose();
    server?.stop();
}
