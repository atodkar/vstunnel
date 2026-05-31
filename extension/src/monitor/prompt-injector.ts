import * as vscode from 'vscode';
import { AgentActivity } from './types';
import { randomUUID } from 'crypto';

export class PromptInjector implements vscode.Disposable {
    private onActivityEmitter = new vscode.EventEmitter<AgentActivity>();
    public readonly onActivity = this.onActivityEmitter.event;

    constructor() {}

    async injectPrompt(prompt: string, target: 'active_session' | 'new_chat' | 'inline' = 'active_session'): Promise<boolean> {
        let success = false;

        switch (target) {
            case 'active_session':
                success = await this.injectToActiveSession(prompt);
                break;
            case 'new_chat':
                success = await this.injectToNewChat(prompt);
                break;
            case 'inline':
                success = await this.injectInline(prompt);
                break;
        }

        if (success) {
            this.onActivityEmitter.fire({
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: 'prompt_sent',
                data: { prompt },
            });
        }

        return success;
    }

    private async injectToActiveSession(prompt: string): Promise<boolean> {
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false,
            });
            return true;
        } catch {
            return this.injectToNewChat(prompt);
        }
    }

    private async injectToNewChat(prompt: string): Promise<boolean> {
        try {
            await vscode.commands.executeCommand('workbench.action.chat.newChat');
            await new Promise(resolve => setTimeout(resolve, 200));
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt,
                isPartialQuery: false,
            });
            return true;
        } catch {
            return false;
        }
    }

    private async injectInline(prompt: string): Promise<boolean> {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return false;
            await vscode.commands.executeCommand('inlineChat.start', {
                message: prompt,
                autoSend: true,
            });
            return true;
        } catch {
            return false;
        }
    }

    dispose(): void {
        this.onActivityEmitter.dispose();
    }
}
