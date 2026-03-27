import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { render } from 'ink';
import type { Instance } from 'ink';
import { OrchestratorChatApp } from './chat-app.js';
import type { WorkflowTraceStep } from '@orchestrator/shared';
import type { ApprovalRequestState, ClarificationRequestState, WorkflowHistoryItem } from './chat-state.js';

type Action = { type: string; payload?: unknown };

export class ChatApp {
  private inkInstance: Instance | null = null;
  private readonly eventBus = new EventEmitter();
  private inputResolver: ((value: string | null) => void) | null = null;
  private menuResolver: ((value: string | null) => void) | null = null;

  // Queue events that arrive before the React component has mounted
  private pendingActions: Action[] = [];
  private componentReady = false;

  constructor(
    private readonly activeModelLabel: string,
    private readonly cwdLabel: string,
    private readonly onInterruptWorkflow?: () => void
  ) {}

  private emit(action: Action): void {
    if (this.componentReady) {
      this.eventBus.emit('action', action);
    } else {
      this.pendingActions.push(action);
    }
  }

  start(): void {
    const onSubmit = (value: string | null) => {
      if (this.inputResolver) {
        const resolver = this.inputResolver;
        this.inputResolver = null;
        resolver(value);
      }
    };

    const onReady = () => {
      this.componentReady = true;
      for (const action of this.pendingActions) {
        this.eventBus.emit('action', action);
      }
      this.pendingActions = [];
    };

    this.inkInstance = render(
      createElement(OrchestratorChatApp, {
        eventBus: this.eventBus,
        onSubmit,
        onMenuSelection: (value: string | null) => this.resolveMenuSelection(value),
        onInterrupt: () => {
          this.onInterruptWorkflow?.();
        },
        onReady,
        modelLabel: this.activeModelLabel,
        cwdLabel: this.cwdLabel,
      })
    );
  }

  async readInput(): Promise<string | null> {
    this.emit({ type: 'UNLOCK_INPUT' });
    return new Promise<string | null>((resolve) => {
      this.inputResolver = resolve;
    });
  }

  async readMenuSelection(request: ApprovalRequestState): Promise<string | null> {
    this.emit({ type: 'OPEN_APPROVAL_MENU', payload: { request } });
    return new Promise<string | null>((resolve) => {
      this.menuResolver = resolve;
    });
  }

  async readClarification(request: ClarificationRequestState): Promise<string | null> {
    this.emit({ type: 'OPEN_CLARIFICATION_MENU', payload: { request } });
    return new Promise<string | null>((resolve) => {
      this.menuResolver = resolve;
    });
  }

  resolveMenuSelection(value: string | null): void {
    if (this.menuResolver) {
      const resolver = this.menuResolver;
      this.menuResolver = null;
      resolver(value);
    }
  }

  beginUserTurn(prompt: string): void {
    this.emit({ type: 'BEGIN_USER_TURN', payload: { text: prompt } });
  }

  appendAssistantThinking(text: string): void {
    this.emit({ type: 'SET_THINKING', payload: { text } });
  }

  stopAssistantThinking(): void {
    this.emit({ type: 'STOP_THINKING' });
  }

  setStatusMessage(text: string): void {
    this.emit({ type: 'SET_STATUS_MESSAGE', payload: { text } });
  }

  appendToolCall(name: string, input: unknown, source: 'orchestrator' | 'subagent' = 'subagent'): void {
    this.emit({ type: 'APPEND_TOOL_CALL', payload: { name, input, source } });
  }

  completeToolCall(name: string, output: unknown, source: 'orchestrator' | 'subagent' = 'subagent'): void {
    this.emit({ type: 'COMPLETE_TOOL_CALL', payload: { name, output, source } });
  }

  addUsageTokens(tokens: number | undefined): void {
    if (!tokens || tokens <= 0) return;
    this.emit({ type: 'ADD_USAGE_TOKENS', payload: { tokens } });
  }

  completeAssistantTurn(text: string, credits?: number): void {
    this.emit({ type: 'COMPLETE_TURN', payload: { text, credits } });
  }

  failAssistantTurn(error: string): void {
    this.emit({ type: 'FAIL_TURN', payload: { error } });
  }

  showSystem(text: string, tone?: 'muted' | 'error' | 'success'): void {
    this.emit({ type: 'SHOW_SYSTEM', payload: { text, tone } });
  }

  setWorkflowId(id: string): void {
    this.emit({ type: 'SET_WORKFLOW_ID', payload: { id } });
  }

  setModel(model: string): void {
    this.emit({ type: 'SET_MODEL', payload: { model } });
  }

  showHistory(trace: WorkflowTraceStep[]): void {
    this.emit({ type: 'SHOW_HISTORY', payload: { trace } });
  }

  openContinueMenu(workflows: WorkflowHistoryItem[]): void {
    this.emit({ type: 'OPEN_CONTINUE_MENU', payload: { workflows } });
  }

  beginSubagent(taskId: string, agentType: string, title: string): void {
    this.emit({ type: 'BEGIN_SUBAGENT', payload: { taskId, agentType, title, description: title } });
  }

  beginSubagentWithDescription(
    taskId: string,
    agentType: string,
    title: string,
    description: string,
    model?: string
  ): void {
    this.emit({ type: 'BEGIN_SUBAGENT', payload: { taskId, agentType, title, description, model } });
  }

  completeSubagent(taskId: string, usageTokens?: number): void {
    this.emit({ type: 'COMPLETE_SUBAGENT', payload: { taskId, usageTokens } });
  }

  failSubagent(taskId: string, error?: string): void {
    this.emit({ type: 'FAIL_SUBAGENT', payload: { taskId, error } });
  }

  stop(): void {
    if (this.inputResolver) {
      const resolver = this.inputResolver;
      this.inputResolver = null;
      resolver(null);
    }
    if (this.menuResolver) {
      const resolver = this.menuResolver;
      this.menuResolver = null;
      resolver(null);
    }
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }
}
