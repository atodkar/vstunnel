// vstunnel Mobile UI - Application Logic
// Supports relay mode (corporate) and direct mode (standalone).
// HTTP-first connection with WebSocket upgrade and HTTP polling fallback.

class VSTunnelClient {
    constructor() {
        this.websocket = null;
        this.serverUrl = localStorage.getItem('tunnelUrl') || '';
        this.authToken = localStorage.getItem('authToken') || '';
        this.targetUser = localStorage.getItem('targetUser') || '';
        this.isConnected = false;
        this.selectedWorkspace = null;
        this.workspaces = [];
        this.transport = null;
        this.sessionId = null;
        this.pollTimer = null;
        this.pollInterval = 2000;
        this.isRelay = false;
        this.init();
    }

    init() {
        this.cacheDOM();
        this.attachEventListeners();
        this.restoreUrl();
    }

    cacheDOM() {
        this.setupPanel = document.getElementById('setupPanel');
        this.tunnelUrlInput = document.getElementById('tunnelUrl');
        this.connectBtn = document.getElementById('connectBtn');

        this.userPanel = document.getElementById('userPanel');
        this.userList = document.getElementById('userList');
        this.authTokenInput = document.getElementById('authToken');
        this.refreshUsersBtn = document.getElementById('refreshUsersBtn');

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

        this.refreshUsersBtn.addEventListener('click', () => this.fetchUsers());
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

    restoreUrl() {
        if (this.serverUrl) this.tunnelUrlInput.value = this.serverUrl;
        if (this.authToken) this.authTokenInput.value = this.authToken;
    }

    // ─── Connection ─────────────────────────────────────────────────────

    normalizeUrl(input) {
        let url = input.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `https://${url}`;
        }
        return url.replace(/\/+$/, '');
    }

    async connect() {
        const rawUrl = this.tunnelUrlInput.value.trim();
        if (!rawUrl) {
            this.showError('Please enter a server URL');
            return;
        }
        if (this.isConnected) {
            this.showError('Already connected. Disconnect first.');
            return;
        }

        this.serverUrl = this.normalizeUrl(rawUrl);
        this.log('Connecting...', 'info');
        this.connectBtn.disabled = true;

        try {
            const healthResp = await fetch(`${this.serverUrl}/health`);
            if (!healthResp.ok) throw new Error(`Server returned ${healthResp.status}`);
            const health = await healthResp.json();
            this.log(`Server healthy (v${health.version})`, 'info');

            this.isRelay = health.registered_laptops !== undefined;
        } catch (err) {
            this.connectBtn.disabled = false;
            this.showError(`Cannot reach server: ${err.message}`);
            return;
        }

        localStorage.setItem('tunnelUrl', rawUrl);
        this.connectBtn.disabled = false;

        if (this.isRelay) {
            this.log('Relay server detected', 'info');
            this.setupPanel.style.display = 'none';
            this.userPanel.style.display = 'block';
            await this.fetchUsers();
        } else {
            this.setupPanel.style.display = 'none';
            await this.connectDirect();
        }
    }

    // ─── Relay Mode: User Selection ─────────────────────────────────────

    async fetchUsers() {
        try {
            const resp = await fetch(`${this.serverUrl}/api/users`);
            if (!resp.ok) throw new Error(`${resp.status}`);
            const data = await resp.json();
            this.renderUserList(data.users || []);
        } catch (err) {
            this.log(`Failed to fetch users: ${err.message}`, 'error');
        }
    }

    renderUserList(users) {
        if (users.length === 0) {
            this.userList.innerHTML = `
                <div class="workspace-empty">
                    <p>No laptops registered.</p>
                    <p class="small">Make sure your daemon is running with RELAY_URL set.</p>
                </div>
            `;
            return;
        }

        this.userList.innerHTML = '';
        users.forEach((user) => {
            const card = document.createElement('div');
            card.className = 'workspace-card';
            if (this.targetUser === user.user_id) card.classList.add('selected');

            const wsCount = (user.workspaces || []).length;
            const wsLabel = wsCount === 1 ? '1 workspace' : `${wsCount} workspaces`;

            card.innerHTML = `
                <div class="workspace-card-header">
                    <span class="workspace-icon">${user.online ? '🟢' : '🔴'}</span>
                    <span class="workspace-card-name">${this.escapeHtml(user.user_id)}</span>
                    <span class="pid-badge">${wsLabel}</span>
                </div>
                <div class="workspace-card-path">${user.online ? 'Online' : 'Offline'}</div>
            `;

            card.addEventListener('click', () => {
                if (!user.online) {
                    this.showError('This laptop is offline');
                    return;
                }
                this.selectUser(user);
            });

            this.userList.appendChild(card);
        });
    }

    async selectUser(user) {
        const token = this.authTokenInput.value.trim();
        if (!token) {
            this.showError('Please enter the auth token from your daemon terminal');
            return;
        }

        this.targetUser = user.user_id;
        this.authToken = token;
        localStorage.setItem('targetUser', this.targetUser);
        localStorage.setItem('authToken', this.authToken);

        this.log(`Connecting to ${user.user_id}...`, 'info');

        const wsConnected = await this.tryWebSocketRelay();
        if (wsConnected) {
            this.transport = 'websocket';
            this.log('Transport: WebSocket', 'info');
        } else {
            this.log('WebSocket blocked, using HTTP polling...', 'info');
            const pollOk = await this.startPollingRelay();
            if (!pollOk) {
                this.showError('Failed to connect. Check token and try again.');
                return;
            }
            this.transport = 'polling';
            this.log('Transport: HTTP polling', 'info');
        }

        this.isConnected = true;
        this.userPanel.style.display = 'none';
        this.updateStatusBadge('CONNECTED');
    }

    tryWebSocketRelay() {
        return new Promise((resolve) => {
            try {
                let wsUrl = this.serverUrl
                    .replace(/^https:\/\//, 'wss://')
                    .replace(/^http:\/\//, 'ws://');
                wsUrl += '/ws/phone';

                const ws = new WebSocket(wsUrl);
                const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

                ws.onopen = () => {
                    clearTimeout(timeout);
                    ws.send(JSON.stringify({
                        type: 'CONNECT_TO',
                        user_id: this.targetUser,
                        token: this.authToken,
                    }));
                };

                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.type === 'WELCOME') {
                        this.websocket = ws;
                        this.websocket.onmessage = (ev) => this.onMessage(ev);
                        this.websocket.onclose = () => this.onDisconnected();
                        this.websocket.onerror = () => {};
                        this.handleWelcome(data);
                        resolve(true);
                    } else if (data.type === 'ERROR') {
                        clearTimeout(timeout);
                        ws.close();
                        this.log(`Auth failed: ${data.message}`, 'error');
                        resolve(false);
                    }
                };

                ws.onerror = () => { clearTimeout(timeout); resolve(false); };
            } catch (e) {
                resolve(false);
            }
        });
    }

    async startPollingRelay() {
        try {
            const resp = await fetch(
                `${this.serverUrl}/api/connect?user=${encodeURIComponent(this.targetUser)}&token=${encodeURIComponent(this.authToken)}`
            );
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this.log(err.message || `Connect failed (${resp.status})`, 'error');
                return false;
            }
            const data = await resp.json();
            this.sessionId = data.session_id;
            this.pollInterval = data.poll_interval_ms || 2000;
            this.handleWelcome(data);
            this.schedulePoll();
            return true;
        } catch (err) {
            return false;
        }
    }

    // ─── Direct Mode ────────────────────────────────────────────────────

    async connectDirect() {
        const wsConnected = await this.tryWebSocketDirect();
        if (wsConnected) {
            this.transport = 'websocket';
            this.log('Transport: WebSocket', 'info');
        } else {
            this.log('WebSocket blocked, using HTTP polling...', 'info');
            const pollOk = await this.startPollingDirect();
            if (!pollOk) {
                this.showError('Failed to establish connection');
                this.setupPanel.style.display = 'block';
                return;
            }
            this.transport = 'polling';
            this.log('Transport: HTTP polling', 'info');
        }

        this.isConnected = true;
        this.updateStatusBadge('CONNECTED');
    }

    tryWebSocketDirect() {
        return new Promise((resolve) => {
            try {
                let wsUrl = this.serverUrl
                    .replace(/^https:\/\//, 'wss://')
                    .replace(/^http:\/\//, 'ws://');
                wsUrl += '/ws';

                const ws = new WebSocket(wsUrl);
                const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

                ws.onopen = () => {
                    clearTimeout(timeout);
                    this.websocket = ws;
                    this.websocket.onmessage = (ev) => this.onMessage(ev);
                    this.websocket.onclose = () => this.onDisconnected();
                    this.websocket.onerror = () => {};
                    resolve(true);
                };

                ws.onerror = () => { clearTimeout(timeout); resolve(false); };
            } catch (e) {
                resolve(false);
            }
        });
    }

    async startPollingDirect() {
        try {
            const resp = await fetch(`${this.serverUrl}/api/connect`);
            if (!resp.ok) return false;
            const data = await resp.json();
            this.sessionId = data.session_id;
            this.pollInterval = data.poll_interval_ms || 2000;
            this.handleWelcome(data);
            this.schedulePoll();
            return true;
        } catch (err) {
            return false;
        }
    }

    // ─── Polling ────────────────────────────────────────────────────────

    schedulePoll() {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
    }

    async poll() {
        if (!this.isConnected || this.transport !== 'polling') return;

        try {
            const resp = await fetch(`${this.serverUrl}/api/poll?session=${this.sessionId}`, {
                headers: { 'X-Session-Id': this.sessionId },
            });

            if (resp.status === 401) {
                this.log('Session expired, reconnecting...', 'error');
                this.disconnect();
                return;
            }

            if (resp.ok) {
                const data = await resp.json();
                if (data.messages) {
                    data.messages.forEach(msg => this.handleMessage(msg));
                }
            }
        } catch (err) {
            this.log('Poll failed, retrying...', 'error');
        }

        this.schedulePoll();
    }

    // ─── Connection Lifecycle ───────────────────────────────────────────

    onDisconnected() {
        this.isConnected = false;
        this.transport = null;
        this.sessionId = null;
        this.selectedWorkspace = null;
        this.workspaces = [];
        if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
        this.setupPanel.style.display = 'block';
        this.userPanel.style.display = 'none';
        this.workspacePanel.style.display = 'none';
        this.controlPanel.style.display = 'none';
        this.updateStatusBadge('DISCONNECTED');
        this.log('Disconnected', 'error');
    }

    disconnect() {
        if (this.websocket) { this.websocket.close(); this.websocket = null; }
        if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
        this.isConnected = false;
        this.transport = null;
        this.sessionId = null;
        this.selectedWorkspace = null;
        this.workspaces = [];
        this.setupPanel.style.display = 'block';
        this.userPanel.style.display = 'none';
        this.workspacePanel.style.display = 'none';
        this.controlPanel.style.display = 'none';
        this.updateStatusBadge('DISCONNECTED');
        this.log('Disconnected', 'info');
    }

    // ─── Message Handling ───────────────────────────────────────────────

    onMessage(event) {
        try {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
        } catch (error) {
            console.error('Message parse error:', error);
        }
    }

    handleMessage(data) {
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
            case 'RESPONSE':
                if (data.result) this.handlePromptAck(data);
                else if (data.workspaces) this.handleWorkspaceList(data);
                else if (data.history) this.handleHistory(data);
                break;
            case 'ERROR':
                this.log(`Server error: ${data.message}`, 'error');
                break;
        }
    }

    handleWelcome(data) {
        const version = data.version || '?';
        const os = data.os || '';
        const userId = data.user_id || '';
        const extra = userId ? ` (${userId})` : (os ? ` on ${os}` : '');
        this.log(`Connected v${version}${extra}`, 'info');

        if (data.vscode_available === false) {
            this.log('Warning: VS Code CLI not detected on host', 'error');
        }

        this.workspaces = data.workspaces || [];
        this.showWorkspaceDecision();
    }

    handleStatusUpdate(data) {
        if (data.os) this.osInfo.textContent = data.os;
        if (data.version) this.versionInfo.textContent = data.version;
        if (data.uptime !== undefined) this.uptimeInfo.textContent = this.formatUptime(data.uptime);

        if (data.workspaces && data.workspaces.length !== this.workspaces.length) {
            this.workspaces = data.workspaces;
            if (this.workspacePanel.style.display !== 'none') {
                this.renderWorkspaceList();
            }
        }

        if (data.online === false) {
            this.log('Laptop went offline', 'error');
        }
    }

    handlePromptAck(data) {
        const ws = data.workspace ? ` [${data.workspace}]` : '';
        if (data.result && data.result.status === 'SUCCESS') {
            this.log(`Prompt executed${ws}`, 'success');
            this.promptInput.value = '';
        } else if (data.result) {
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

        const defaultCard = this.createWorkspaceCard({
            id: null,
            name: 'Default (any instance)',
            folder_path: 'Sends to the most recently active VS Code window',
        }, true);
        this.workspaceList.appendChild(defaultCard);

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

        const pidBadge = workspace.pid ? `<span class="pid-badge">PID ${workspace.pid}</span>` : '';

        card.innerHTML = `
            <div class="workspace-card-header">
                <span class="workspace-icon">${isDefault ? '🔀' : '📂'}</span>
                <span class="workspace-card-name">${this.escapeHtml(workspace.name)}</span>
                ${pidBadge}
            </div>
            <div class="workspace-card-path">${this.escapeHtml(workspace.folder_path)}</div>
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
        if (!prompt) { this.showError('Please enter a prompt'); return; }
        if (!this.isConnected) { this.showError('Not connected'); return; }

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

    // ─── Transport-Agnostic Send ────────────────────────────────────────

    async send(data) {
        if (this.transport === 'websocket' && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify(data));
        } else if (this.transport === 'polling' && this.sessionId) {
            try {
                const resp = await fetch(`${this.serverUrl}/api/send`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Session-Id': this.sessionId,
                    },
                    body: JSON.stringify(data),
                });
                if (resp.ok) {
                    const result = await resp.json();
                    this.handleMessage(result);
                }
            } catch (err) {
                this.log('Send failed: ' + err.message, 'error');
            }
        }
    }

    // ─── Utilities ──────────────────────────────────────────────────────

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

    hideError() { this.errorPanel.style.display = 'none'; }

    formatTime(timestamp) {
        if (!timestamp) return '—';
        try { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
        catch { return '—'; }
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
