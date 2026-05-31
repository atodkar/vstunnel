// vstunnel Mobile UI - Application Logic
// Supports multi-instance workspace selection and prompt history

class VSTunnelClient {
    constructor() {
        this.websocket = null;
        this.tunnelUrl = localStorage.getItem('tunnelUrl') || '';
        this.isConnected = false;
        this.selectedWorkspace = null;
        this.workspaces = [];
        this.init();
    }

    init() {
        this.cacheDOM();
        this.attachEventListeners();
        this.restoreTunnelUrl();
    }

    cacheDOM() {
        this.setupPanel = document.getElementById('setupPanel');
        this.tunnelUrlInput = document.getElementById('tunnelUrl');
        this.connectBtn = document.getElementById('connectBtn');

        this.workspacePanel = document.getElementById('workspacePanel');
        this.workspaceList = document.getElementById('workspaceList');
        this.refreshWorkspacesBtn = document.getElementById('refreshWorkspacesBtn');

        this.controlPanel = document.getElementById('controlPanel');
        this.activeWorkspaceName = document.getElementById('activeWorkspaceName');
        this.changeWorkspaceBtn = document.getElementById('changeWorkspaceBtn');
        this.promptInput = document.getElementById('promptInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.disconnectBtn = document.getElementById('disconnectBtn');

        this.statusDot = document.getElementById('statusDot');
        this.statusText = document.getElementById('statusText');
        this.osInfo = document.getElementById('osInfo');
        this.versionInfo = document.getElementById('versionInfo');
        this.uptimeInfo = document.getElementById('uptimeInfo');

        this.historyList = document.getElementById('historyList');
        this.loadHistoryBtn = document.getElementById('loadHistoryBtn');

        this.activityLog = document.getElementById('activityLog');
        this.clearLogBtn = document.getElementById('clearLogBtn');

        this.errorPanel = document.getElementById('errorPanel');
        this.errorMessage = document.getElementById('errorMessage');
        this.errorCloseBtn = document.getElementById('errorCloseBtn');
    }

    attachEventListeners() {
        this.connectBtn.addEventListener('click', () => this.connect());
        this.tunnelUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.connect();
        });

        this.refreshWorkspacesBtn.addEventListener('click', () => this.requestWorkspaces());
        this.changeWorkspaceBtn.addEventListener('click', () => this.showWorkspaceSelector());

        this.sendBtn.addEventListener('click', () => this.sendPrompt());
        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.sendPrompt();
        });
        this.clearBtn.addEventListener('click', () => { this.promptInput.value = ''; });
        this.disconnectBtn.addEventListener('click', () => this.disconnect());

        this.loadHistoryBtn.addEventListener('click', () => this.requestHistory());
        this.clearLogBtn.addEventListener('click', () => { this.activityLog.innerHTML = ''; });

        this.errorCloseBtn.addEventListener('click', () => this.hideError());
    }

    restoreTunnelUrl() {
        if (this.tunnelUrl) {
            this.tunnelUrlInput.value = this.tunnelUrl;
        }
    }

    // ─── Connection ─────────────────────────────────────────────────────

    connect() {
        const tunnelUrl = this.tunnelUrlInput.value.trim();
        if (!tunnelUrl) {
            this.showError('Please enter a VS Code tunnel URL');
            return;
        }
        if (this.websocket && this.isConnected) {
            this.showError('Already connected. Disconnect first.');
            return;
        }
        this.connectToWebSocket(tunnelUrl);
    }

    connectToWebSocket(tunnelUrl) {
        try {
            let wsUrl = tunnelUrl;
            if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
                wsUrl = wsUrl.replace(/^https?:\/\//, '');
                wsUrl = `wss://${wsUrl}`;
            }

            this.log('Connecting...', 'info');
            this.websocket = new WebSocket(wsUrl);
            this.websocket.onopen = () => this.onConnected(tunnelUrl);
            this.websocket.onmessage = (event) => this.onMessage(event);
            this.websocket.onerror = () => this.onError();
            this.websocket.onclose = () => this.onDisconnected();
        } catch (error) {
            this.showError(`Connection error: ${error.message}`);
        }
    }

    onConnected(tunnelUrl) {
        this.isConnected = true;
        localStorage.setItem('tunnelUrl', tunnelUrl);
        this.setupPanel.style.display = 'none';
        this.updateStatusBadge('CONNECTED');
        this.log('Connected to daemon', 'success');
    }

    onDisconnected() {
        this.isConnected = false;
        this.selectedWorkspace = null;
        this.workspaces = [];
        this.setupPanel.style.display = 'block';
        this.workspacePanel.style.display = 'none';
        this.controlPanel.style.display = 'none';
        this.updateStatusBadge('DISCONNECTED');
        this.log('Disconnected', 'error');
    }

    onError() {
        this.showError('Connection failed. Check tunnel URL and try again.');
    }

    disconnect() {
        if (this.websocket) {
            this.websocket.close();
        }
    }

    // ─── Message Handling ───────────────────────────────────────────────

    onMessage(event) {
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case 'WELCOME':
                    this.handleWelcome(data);
                    break;
                case 'STATUS_UPDATE':
                    this.handleStatusUpdate(data);
                    break;
                case 'PROMPT_ACK':
                    this.handlePromptAck(data);
                    break;
                case 'WORKSPACES':
                    this.handleWorkspaceList(data);
                    break;
                case 'HISTORY_RESPONSE':
                    this.handleHistory(data);
                    break;
                case 'ERROR':
                    this.log(`Server error: ${data.message}`, 'error');
                    break;
                case 'PONG':
                    break;
            }
        } catch (error) {
            console.error('Message parse error:', error);
        }
    }

    handleWelcome(data) {
        this.log(`Daemon v${data.version} on ${data.os}`, 'info');

        if (!data.vscode_available) {
            this.log('Warning: VS Code CLI not detected on host', 'error');
        }

        this.workspaces = data.workspaces || [];
        this.showWorkspaceDecision();
    }

    handleStatusUpdate(data) {
        this.osInfo.textContent = data.os || '—';
        this.versionInfo.textContent = data.version || '—';
        this.uptimeInfo.textContent = this.formatUptime(data.uptime);

        if (data.workspaces && data.workspaces.length !== this.workspaces.length) {
            this.workspaces = data.workspaces;
            if (this.workspacePanel.style.display !== 'none') {
                this.renderWorkspaceList();
            }
        }
    }

    handlePromptAck(data) {
        const ws = data.workspace ? ` [${data.workspace}]` : '';
        if (data.result.status === 'SUCCESS') {
            this.log(`Prompt executed${ws}`, 'success');
            this.promptInput.value = '';
        } else {
            this.log(`Failed${ws}: ${data.result.message}`, 'error');
        }
    }

    handleWorkspaceList(data) {
        this.workspaces = data.workspaces || [];
        this.renderWorkspaceList();
    }

    handleHistory(data) {
        const history = data.history || [];
        if (history.length === 0) {
            this.historyList.innerHTML = '<p class="empty-state">No prompt history</p>';
            return;
        }

        this.historyList.innerHTML = '';
        history.reverse().forEach((entry) => {
            const item = document.createElement('div');
            item.className = `history-item ${entry.result === 'SUCCESS' ? 'success' : 'error'}`;

            const workspace = entry.workspace ? `<span class="history-workspace">${entry.workspace}</span>` : '';
            const time = this.formatTime(entry.timestamp);
            const status = entry.result === 'SUCCESS' ? '✓' : '✗';

            item.innerHTML = `
                <div class="history-header">
                    <span class="history-status">${status}</span>
                    ${workspace}
                    <span class="history-time">${time}</span>
                </div>
                <div class="history-prompt">${this.escapeHtml(entry.prompt)}</div>
            `;

            item.addEventListener('click', () => {
                this.promptInput.value = entry.prompt;
                this.promptInput.focus();
            });

            this.historyList.appendChild(item);
        });
    }

    // ─── Workspace Selection ────────────────────────────────────────────

    showWorkspaceDecision() {
        if (this.workspaces.length > 1) {
            this.showWorkspaceSelector();
        } else if (this.workspaces.length === 1) {
            this.selectWorkspace(this.workspaces[0]);
        } else {
            this.selectWorkspace(null);
        }
    }

    showWorkspaceSelector() {
        this.controlPanel.style.display = 'none';
        this.workspacePanel.style.display = 'block';
        this.renderWorkspaceList();
    }

    renderWorkspaceList() {
        if (this.workspaces.length === 0) {
            this.workspaceList.innerHTML = `
                <div class="workspace-empty">
                    <p>No VS Code instances detected.</p>
                    <p class="small">Make sure VS Code is open with a folder/workspace.</p>
                </div>
            `;
            return;
        }

        this.workspaceList.innerHTML = '';

        // "Any / Default" option
        const defaultCard = this.createWorkspaceCard({
            id: null,
            name: 'Default (any instance)',
            folder_path: 'Sends to the most recently active VS Code window',
        }, true);
        this.workspaceList.appendChild(defaultCard);

        // Detected workspaces
        this.workspaces.forEach((ws) => {
            const card = this.createWorkspaceCard(ws, false);
            this.workspaceList.appendChild(card);
        });
    }

    createWorkspaceCard(workspace, isDefault) {
        const card = document.createElement('div');
        card.className = 'workspace-card';
        if (this.selectedWorkspace && this.selectedWorkspace.id === workspace.id) {
            card.classList.add('selected');
        }

        const name = workspace.name;
        const path = isDefault ? workspace.folder_path : workspace.folder_path;
        const pidBadge = workspace.pid ? `<span class="pid-badge">PID ${workspace.pid}</span>` : '';

        card.innerHTML = `
            <div class="workspace-card-header">
                <span class="workspace-icon">${isDefault ? '🔀' : '📂'}</span>
                <span class="workspace-card-name">${this.escapeHtml(name)}</span>
                ${pidBadge}
            </div>
            <div class="workspace-card-path">${this.escapeHtml(path)}</div>
        `;

        card.addEventListener('click', () => {
            this.selectWorkspace(isDefault ? null : workspace);
        });

        return card;
    }

    selectWorkspace(workspace) {
        this.selectedWorkspace = workspace;
        this.workspacePanel.style.display = 'none';
        this.controlPanel.style.display = 'flex';

        if (workspace) {
            this.activeWorkspaceName.textContent = workspace.name;
            this.log(`Target: ${workspace.name}`, 'info');
        } else {
            this.activeWorkspaceName.textContent = 'Default (any instance)';
            this.log('Target: default (any active instance)', 'info');
        }

        this.requestHistory();
    }

    requestWorkspaces() {
        if (!this.isConnected) return;
        this.send({ type: 'LIST_WORKSPACES' });
        this.log('Refreshing workspace list...', 'info');
    }

    // ─── Prompt Sending ─────────────────────────────────────────────────

    sendPrompt() {
        const prompt = this.promptInput.value.trim();
        if (!prompt) {
            this.showError('Please enter a prompt');
            return;
        }
        if (!this.isConnected) {
            this.showError('Not connected to daemon');
            return;
        }

        const message = {
            type: 'PROMPT',
            payload: prompt,
            timestamp: new Date().toISOString(),
        };

        if (this.selectedWorkspace) {
            message.workspace_id = this.selectedWorkspace.id;
        }

        this.send(message);
        const target = this.selectedWorkspace ? ` → ${this.selectedWorkspace.name}` : '';
        this.log(`Sent${target}: "${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}"`, 'info');
    }

    requestHistory() {
        if (!this.isConnected) return;
        this.send({ type: 'HISTORY' });
    }

    // ─── Utilities ──────────────────────────────────────────────────────

    send(data) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify(data));
        }
    }

    updateStatusBadge(status) {
        const connected = status === 'CONNECTED';
        this.statusDot.classList.toggle('connected', connected);
        this.statusText.textContent = connected ? 'Connected' : 'Disconnected';
    }

    log(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        entry.innerHTML = `<span class="log-time">${time}</span> ${this.escapeHtml(message)}`;

        this.activityLog.appendChild(entry);
        this.activityLog.scrollTop = this.activityLog.scrollHeight;

        while (this.activityLog.children.length > 100) {
            this.activityLog.removeChild(this.activityLog.firstChild);
        }
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorPanel.style.display = 'block';
        setTimeout(() => this.hideError(), 5000);
    }

    hideError() {
        this.errorPanel.style.display = 'none';
    }

    formatTime(timestamp) {
        if (!timestamp) return '—';
        try {
            return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '—';
        }
    }

    formatUptime(seconds) {
        if (!seconds && seconds !== 0) return '—';
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new VSTunnelClient();
});
