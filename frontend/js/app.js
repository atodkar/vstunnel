// vstunnel v2 - Remote Copilot Monitor & Control

class VSTunnelApp {
    constructor() {
        this.ws = null;
        this.relayUrl = '';
        this.selectedUser = null;
        this.selectedInstance = 'all';
        this.instances = [];
        this.activities = [];
        this.pendingApprovals = new Map();
        this.maxActivities = 200;

        this.init();
    }

    init() {
        const saved = localStorage.getItem('vstunnel_relay_url');
        if (saved) document.getElementById('relayUrl').value = saved;

        document.getElementById('btnConnect').addEventListener('click', () => this.connectToRelay());
        document.getElementById('btnAuth').addEventListener('click', () => this.authenticate());
        document.getElementById('btnDisconnect').addEventListener('click', () => this.disconnect());
        document.getElementById('btnMainDisconnect').addEventListener('click', () => this.disconnect());
        document.getElementById('btnSendPrompt').addEventListener('click', () => this.sendPrompt());
        document.getElementById('btnQuickContinue').addEventListener('click', () => this.sendQuickPrompt('Continue working on the current task'));
        document.getElementById('btnQuickExplain').addEventListener('click', () => this.sendQuickPrompt('Explain what you just did'));
        document.getElementById('btnRefreshDiff').addEventListener('click', () => this.requestDiff());
        document.getElementById('btnAccept').addEventListener('click', () => this.resolveApproval('accept'));
        document.getElementById('btnReject').addEventListener('click', () => this.resolveApproval('reject'));

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        document.getElementById('promptInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendPrompt();
            }
        });
    }

    // ─── Connection ──────────────────────────────────────────────────────────

    async connectToRelay() {
        this.relayUrl = document.getElementById('relayUrl').value.trim().replace(/\/$/, '');
        if (!this.relayUrl) {
            this.showSetupError('Please enter a relay URL');
            return;
        }

        localStorage.setItem('vstunnel_relay_url', this.relayUrl);
        this.showSetupError('');

        try {
            const res = await fetch(`${this.relayUrl}/api/users`);
            const data = await res.json();
            this.showUserPanel(data.users || []);
        } catch (e) {
            this.showSetupError(`Cannot reach relay: ${e.message}`);
        }
    }

    showUserPanel(users) {
        const list = document.getElementById('userList');
        list.innerHTML = '';

        if (users.length === 0) {
            list.innerHTML = '<div class="empty-state">No users online</div>';
            this.showPanel('userPanel');
            return;
        }

        users.forEach(user => {
            const el = document.createElement('div');
            el.className = 'user-card';
            el.dataset.userId = user.user_id;

            const instanceCount = user.instances ? user.instances.length : 0;
            const workspaces = (user.instances || []).map(i => i.workspace_name).join(', ');

            el.innerHTML = `
                <div class="user-name">${user.user_id}</div>
                <div class="user-meta">${instanceCount} instance(s): ${workspaces}</div>
            `;
            el.addEventListener('click', () => {
                document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
                el.classList.add('selected');
                this.selectedUser = user.user_id;
                document.getElementById('btnAuth').disabled = false;
            });
            list.appendChild(el);
        });

        this.showPanel('userPanel');
    }

    authenticate() {
        if (!this.selectedUser) return;
        const token = document.getElementById('authToken').value.trim();
        if (!token) {
            alert('Please enter the auth token');
            return;
        }
        this.connectWebSocket(token);
    }

    connectWebSocket(token) {
        const wsUrl = this.relayUrl
            .replace(/^https:\/\//, 'wss://')
            .replace(/^http:\/\//, 'ws://') + '/ws/phone';

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'CONNECT_TO',
                user_id: this.selectedUser,
                token: token,
            }));
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.handleMessage(msg);
            } catch {}
        };

        this.ws.onclose = () => {
            this.updateStatus('disconnected');
        };

        this.ws.onerror = () => {
            this.showSetupError('WebSocket connection failed');
        };
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.activities = [];
        this.pendingApprovals.clear();
        this.selectedUser = null;
        this.selectedInstance = 'all';
        this.showPanel('setupPanel');
    }

    // ─── Message Handling ────────────────────────────────────────────────────

    handleMessage(msg) {
        switch (msg.type) {
            case 'WELCOME':
                this.handleWelcome(msg);
                break;
            case 'INSTANCE_LIST':
                this.updateInstances(msg.instances || []);
                break;
            case 'AGENT_ACTIVITY':
                this.handleActivity(msg);
                break;
            case 'DIFF_SUMMARY':
                this.handleDiff(msg);
                break;
            case 'TERMINAL_DATA':
                this.handleTerminalData(msg);
                break;
            case 'APPROVAL_PENDING':
                this.handleApproval(msg);
                break;
            case 'COMMAND_RESULT':
                this.handleCommandResult(msg);
                break;
            case 'EVENT_REPLAY':
                this.handleEventReplay(msg);
                break;
            case 'ERROR':
                this.showSetupError(msg.message);
                break;
        }
    }

    handleWelcome(msg) {
        this.updateInstances(msg.instances || []);
        this.showPanel('mainPanel');
        this.updateStatus('connected');
        this.ws.send(JSON.stringify({ type: 'GET_INSTANCES' }));
    }

    handleActivity(msg) {
        if (this.selectedInstance !== 'all' && msg.instance_id !== this.selectedInstance) return;

        const activity = msg.activity || msg;
        const entry = {
            id: activity.id || Date.now().toString(),
            timestamp: activity.timestamp || new Date().toISOString(),
            type: activity.type || msg.type,
            workspace: msg.workspace || '',
            instance_id: msg.instance_id || '',
            data: activity.data || activity,
        };

        this.activities.unshift(entry);
        if (this.activities.length > this.maxActivities) this.activities.pop();
        this.renderActivityFeed();
    }

    handleDiff(msg) {
        const stats = document.getElementById('diffStats');
        stats.textContent = `${msg.filesChanged || 0} file(s) changed (+${msg.insertions || 0} -${msg.deletions || 0})`;

        const content = document.getElementById('diffContent');
        if (msg.fullDiff) {
            content.innerHTML = `<pre class="diff-output">${this.escapeHtml(msg.fullDiff)}</pre>`;
            this.colorizeDiff(content);
        } else if (msg.files && msg.files.length > 0) {
            content.innerHTML = msg.files.map(f =>
                `<div class="diff-file">
                    <span class="diff-file-name">${f.filePath}</span>
                    <span class="diff-file-stat">+${f.insertions} -${f.deletions}</span>
                    <button class="btn btn-small btn-danger" onclick="app.revertFile('${f.filePath}', '${msg.instance_id}')">Revert</button>
                </div>`
            ).join('');
        } else {
            content.innerHTML = '<div class="empty-state">No changes</div>';
        }
    }

    handleTerminalData(msg) {
        this.handleActivity({
            ...msg,
            activity: {
                type: 'terminal_output',
                data: { terminalName: msg.terminalName || 'Terminal', text: msg.chunk || '' },
            },
        });
    }

    handleApproval(msg) {
        const approval = msg.approval || msg;
        this.pendingApprovals.set(approval.id, {
            ...approval,
            instance_id: msg.instance_id,
        });
        this.showApprovalBanner();
    }

    handleCommandResult(msg) {
        const text = msg.message || (msg.success ? 'Done' : 'Failed');
        this.addActivityEntry('command_result', msg.command, { message: text, success: msg.success });
    }

    handleEventReplay(msg) {
        (msg.events || []).forEach(event => this.handleMessage(event));
    }

    // ─── Actions ─────────────────────────────────────────────────────────────

    sendPrompt() {
        const input = document.getElementById('promptInput');
        const prompt = input.value.trim();
        if (!prompt || !this.ws) return;

        const target = document.getElementById('promptTarget').value;

        this.ws.send(JSON.stringify({
            type: 'INJECT_PROMPT',
            instance_id: this.selectedInstance === 'all' ? undefined : this.selectedInstance,
            prompt: prompt,
            target: target,
        }));

        this.addActivityEntry('prompt_sent', '', { prompt });
        input.value = '';
    }

    sendQuickPrompt(text) {
        document.getElementById('promptInput').value = text;
        this.sendPrompt();
    }

    requestDiff() {
        if (!this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'GET_DIFF',
            instance_id: this.selectedInstance === 'all' ? undefined : this.selectedInstance,
        }));
    }

    revertFile(filePath, instanceId) {
        if (!this.ws) return;
        if (!confirm(`Revert ${filePath}?`)) return;
        this.ws.send(JSON.stringify({
            type: 'REVERT_FILE',
            instance_id: instanceId || this.selectedInstance,
            filePath: filePath,
        }));
    }

    resolveApproval(action) {
        const [approvalId, approval] = [...this.pendingApprovals.entries()][0] || [];
        if (!approvalId || !this.ws) return;

        this.ws.send(JSON.stringify({
            type: action === 'accept' ? 'ACCEPT_APPROVAL' : 'REJECT_APPROVAL',
            instance_id: approval.instance_id,
            approvalId: approvalId,
        }));

        this.pendingApprovals.delete(approvalId);
        this.showApprovalBanner();
    }

    // ─── UI Rendering ────────────────────────────────────────────────────────

    updateInstances(instances) {
        this.instances = instances;
        const tabs = document.getElementById('workspaceTabs');
        tabs.innerHTML = '<button class="ws-tab active" data-instance="all">All</button>';

        instances.forEach(inst => {
            const btn = document.createElement('button');
            btn.className = 'ws-tab';
            btn.dataset.instance = inst.instance_id;
            btn.textContent = inst.workspace_name;
            btn.addEventListener('click', () => this.switchInstance(inst.instance_id));
            tabs.appendChild(btn);
        });

        document.querySelector('.ws-tab[data-instance="all"]')
            .addEventListener('click', () => this.switchInstance('all'));
    }

    switchInstance(instanceId) {
        this.selectedInstance = instanceId;
        document.querySelectorAll('.ws-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.ws-tab[data-instance="${instanceId}"]`)?.classList.add('active');
        this.renderActivityFeed();
    }

    switchTab(tab) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
        document.getElementById(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');

        if (tab === 'diff') this.requestDiff();
    }

    renderActivityFeed() {
        const feed = document.getElementById('activityFeed');
        const filtered = this.selectedInstance === 'all'
            ? this.activities
            : this.activities.filter(a => a.instance_id === this.selectedInstance);

        if (filtered.length === 0) {
            feed.innerHTML = '<div class="empty-state">Waiting for Copilot activity...</div>';
            return;
        }

        feed.innerHTML = filtered.slice(0, 50).map(a => this.renderActivityCard(a)).join('');
    }

    renderActivityCard(activity) {
        const time = new Date(activity.timestamp).toLocaleTimeString();
        const ws = activity.workspace ? `<span class="activity-ws">${activity.workspace}</span>` : '';
        let icon = '';
        let text = '';

        switch (activity.type) {
            case 'file_edit':
                icon = '&#9998;';
                text = `Modified <strong>${activity.data.filePath}</strong> (+${activity.data.linesAdded} -${activity.data.linesRemoved})`;
                break;
            case 'file_create':
                icon = '+';
                text = `Created <strong>${activity.data.filePath}</strong>`;
                break;
            case 'file_delete':
                icon = '&times;';
                text = `Deleted <strong>${activity.data.filePath}</strong>`;
                break;
            case 'terminal_output':
                icon = '&gt;_';
                text = `<code>${this.escapeHtml((activity.data.text || '').substring(0, 100))}</code>`;
                break;
            case 'prompt_sent':
                icon = '&uarr;';
                text = `Sent: "${this.escapeHtml((activity.data.prompt || '').substring(0, 80))}"`;
                break;
            case 'command_result':
                icon = activity.data.success ? '&#10003;' : '&#10007;';
                text = activity.data.message;
                break;
            default:
                icon = '&#8226;';
                text = activity.type;
        }

        return `<div class="activity-card activity-${activity.type}">
            <span class="activity-icon">${icon}</span>
            <div class="activity-body">
                <div class="activity-text">${text}</div>
                <div class="activity-meta">${time} ${ws}</div>
            </div>
        </div>`;
    }

    addActivityEntry(type, workspace, data) {
        const entry = {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            type,
            workspace,
            instance_id: this.selectedInstance,
            data,
        };
        this.activities.unshift(entry);
        if (this.activities.length > this.maxActivities) this.activities.pop();
        this.renderActivityFeed();
    }

    showApprovalBanner() {
        const banner = document.getElementById('approvalBanner');
        if (this.pendingApprovals.size === 0) {
            banner.classList.add('hidden');
            return;
        }
        const [, approval] = [...this.pendingApprovals.entries()][0];
        document.getElementById('approvalText').textContent = approval.description || 'Action requires approval';
        banner.classList.remove('hidden');
        if (navigator.vibrate) navigator.vibrate(200);
    }

    colorizeDiff(container) {
        const pre = container.querySelector('pre');
        if (!pre) return;
        const lines = pre.innerHTML.split('\n');
        pre.innerHTML = lines.map(line => {
            if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
            if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${line}</span>`;
            if (line.startsWith('@@')) return `<span class="diff-hunk">${line}</span>`;
            return line;
        }).join('\n');
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    showPanel(id) {
        ['setupPanel', 'userPanel', 'mainPanel'].forEach(p => {
            document.getElementById(p).classList.toggle('hidden', p !== id);
        });
    }

    showSetupError(msg) {
        const el = document.getElementById('setupError');
        el.textContent = msg;
        el.classList.toggle('hidden', !msg);
    }

    updateStatus(status) {
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        dot.className = `status-dot ${status}`;
        text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

const app = new VSTunnelApp();
