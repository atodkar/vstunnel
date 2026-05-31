import * as vscode from 'vscode';
import { BridgeServer } from './server';
import { StatusProvider } from './views/status';
import { HistoryProvider } from './views/history';

let server: BridgeServer | undefined;
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
    const port = config.get<number>('port') ?? 8080;
    const requireToken = config.get<boolean>('requireToken') ?? true;
    const autoForward = config.get<boolean>('autoForward') ?? true;

    server = new BridgeServer({
        port,
        requireToken,
        workspaceName: vscode.workspace.name || 'Untitled',
        workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        context,
        onPrompt: handlePrompt,
        onStatusChange: () => statusProvider.refresh(),
        onHistoryChange: () => historyProvider.refresh(),
    });

    await server.start();

    if (autoForward) {
        await forwardPort(port);
    }

    statusProvider.setServer(server);
    historyProvider.setServer(server);

    vscode.window.showInformationMessage(
        `vstunnel bridge started on port ${port}. Forward it in the Ports panel.`,
        'Show QR Code'
    ).then(action => {
        if (action === 'Show QR Code') {
            showQRCode(context);
        }
    });
}

async function stopBridge() {
    if (server) {
        await server.stop();
        server = undefined;
        statusProvider.setServer(undefined);
        historyProvider.setServer(undefined);
        vscode.window.showInformationMessage('vstunnel bridge stopped.');
    }
}

async function handlePrompt(prompt: string): Promise<{ status: string; message: string }> {
    try {
        // Method 1: Use Copilot Chat API directly (preferred)
        const chatResult = await executeCopilotChat(prompt);
        if (chatResult) {
            return chatResult;
        }

        // Method 2: Insert into inline chat via command
        await vscode.commands.executeCommand('inlineChat.start', { message: prompt });
        return { status: 'SUCCESS', message: 'Prompt sent to inline chat' };
    } catch (error: any) {
        return { status: 'ERROR', message: error.message || 'Unknown error' };
    }
}

async function executeCopilotChat(prompt: string): Promise<{ status: string; message: string } | null> {
    try {
        // Try the VS Code Chat API (available in recent VS Code versions)
        const chatApi = vscode.extensions.getExtension('github.copilot-chat');
        if (!chatApi?.isActive) {
            await chatApi?.activate();
        }

        // Use the interactive chat panel
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        return { status: 'SUCCESS', message: 'Prompt sent to Copilot Chat panel' };
    } catch {
        return null;
    }
}

async function forwardPort(port: number) {
    try {
        // VS Code's port forwarding API (if tunnel is active)
        await vscode.commands.executeCommand('remote-tunnels.forwardPort', { port });
    } catch {
        // Port forwarding not available (not connected via tunnel)
        // User will need to forward manually via Ports panel
    }
}

async function showQRCode(context: vscode.ExtensionContext) {
    if (!server?.isRunning) {
        vscode.window.showWarningMessage('Start the bridge first: vstunnel: Start Mobile Bridge');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'vstunnelQR',
        'vstunnel - Connect',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const tunnelUrl = server.tunnelUrl || `localhost:${server.port}`;
    const mobileUrl = `https://vstunnel.vercel.app?tunnel=${encodeURIComponent(tunnelUrl)}`;
    const token = server.authToken || '';

    panel.webview.html = getQRWebviewContent(mobileUrl, tunnelUrl, token);
}

function showStatus() {
    if (!server) {
        vscode.window.showInformationMessage('vstunnel bridge is not running.');
        return;
    }

    const clients = server.connectedClients;
    const uptime = server.uptimeSeconds;
    const prompts = server.totalPrompts;

    vscode.window.showInformationMessage(
        `vstunnel: ${clients} client(s) connected | ${prompts} prompts sent | Uptime: ${Math.floor(uptime / 60)}m`
    );
}

function getQRWebviewContent(mobileUrl: string, tunnelUrl: string, token: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: system-ui; padding: 2rem; text-align: center; background: #1e1e1e; color: #fff; }
        h1 { margin-bottom: 1rem; }
        .url { font-family: monospace; background: #333; padding: 0.5rem 1rem; border-radius: 8px; margin: 1rem 0; word-break: break-all; }
        .token { color: #f59e0b; font-family: monospace; }
        .qr-placeholder { width: 200px; height: 200px; margin: 1.5rem auto; background: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
        .instructions { text-align: left; max-width: 400px; margin: 2rem auto; }
        .instructions li { margin-bottom: 0.5rem; }
        .copy-btn { background: #0066ff; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin: 0.5rem; }
    </style>
</head>
<body>
    <h1>📱 Connect Your Phone</h1>
    <div class="qr-placeholder" id="qr">
        <canvas id="qrCanvas"></canvas>
    </div>
    <p>Scan QR code or copy the URL below:</p>
    <div class="url">${tunnelUrl}</div>
    <button class="copy-btn" onclick="navigator.clipboard.writeText('${tunnelUrl}')">Copy Tunnel URL</button>
    ${token ? `<p>Auth Token: <span class="token">${token}</span></p><button class="copy-btn" onclick="navigator.clipboard.writeText('${token}')">Copy Token</button>` : ''}
    <div class="instructions">
        <h3>Steps:</h3>
        <ol>
            <li>Open <strong>vstunnel</strong> on your phone browser</li>
            <li>Paste the tunnel URL above</li>
            ${token ? '<li>Enter the auth token when prompted</li>' : ''}
            <li>Tap <strong>Connect</strong></li>
            <li>Start sending prompts!</li>
        </ol>
    </div>
</body>
</html>`;
}

export function deactivate() {
    server?.stop();
}
