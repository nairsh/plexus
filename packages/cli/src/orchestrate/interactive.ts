import type { WorkflowSummary } from '@orchestrator/orchestrator';
import {
  continueWorkflow,
  getWorkflowTrace,
  listWorkflows,
  planWorkflow,
  resolveWorkflowApproval,
} from '@orchestrator/orchestrator';
import type { ToolApprovalDecision } from '@orchestrator/shared';
import { getErrorMessage } from '@orchestrator/shared';
import { getAllowedOrchestratorModels } from '@orchestrator/model-router';
import { ChatApp as ChatScreen } from '../ui/chat-app-bridge.js';
import { SPECIAL_LOAD_WORKFLOW, SPECIAL_OPEN_CONTINUE, SPECIAL_SET_MODEL } from '../ui/chat-protocol.js';
import type { ApprovalRequestState } from '../ui/chat-state.js';
import { prettifyModelLabel, toHistoryOptions } from './output.js';
import { streamWorkflow } from './workflow-stream.js';

interface InteractiveOptions {
  userId: string;
  model: string;
  maxCredits: string;
  onWorkflowIdChange?: (workflowId: string | null) => void;
}

export const runInteractiveChat = async (
  chatScreen: ChatScreen,
  options: InteractiveOptions
): Promise<string | null> => {
  let currentWorkflowId: string | undefined;
  let currentModel = options.model;

  while (true) {
    const prompt = await chatScreen.readInput();
    if (prompt === null) break;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) continue;

    if (trimmedPrompt === '/exit' || trimmedPrompt === '/quit') break;

    if (trimmedPrompt === SPECIAL_OPEN_CONTINUE) {
      const workflows: WorkflowSummary[] = listWorkflows(options.userId);
      const historyOptions = toHistoryOptions(workflows);
      if (historyOptions.length === 0) {
        chatScreen.showSystem('No previous workflows found yet.', 'muted');
      } else {
        chatScreen.openContinueMenu(historyOptions);
      }
      continue;
    }

    if (trimmedPrompt.startsWith(SPECIAL_SET_MODEL)) {
      const nextModel = trimmedPrompt.slice(SPECIAL_SET_MODEL.length);
      if (!getAllowedOrchestratorModels().includes(nextModel)) {
        chatScreen.showSystem(`Model not found: ${nextModel}`, 'error');
        continue;
      }
      currentModel = nextModel;
      chatScreen.setModel(nextModel);
      chatScreen.showSystem(`Switched to ${prettifyModelLabel(nextModel)}`, 'success');
      continue;
    }

    if (trimmedPrompt.startsWith(SPECIAL_LOAD_WORKFLOW)) {
      const nextWorkflowId = trimmedPrompt.slice(SPECIAL_LOAD_WORKFLOW.length);
      currentWorkflowId = nextWorkflowId;
      options.onWorkflowIdChange?.(currentWorkflowId);
      chatScreen.setWorkflowId(currentWorkflowId);
      chatScreen.showHistory(getWorkflowTrace(nextWorkflowId));
      chatScreen.showSystem(`Loaded workflow ${nextWorkflowId}`, 'success');
      continue;
    }

    if (trimmedPrompt === '/help') {
      chatScreen.showSystem('Commands: /help, /model, /continue, /exit', 'muted');
      continue;
    }

    chatScreen.beginUserTurn(trimmedPrompt);

    try {
      if (currentWorkflowId) {
        await continueWorkflow(currentWorkflowId, trimmedPrompt);
      } else {
        const result = await planWorkflow(options.userId, {
          objective: trimmedPrompt,
          orchestrator_model: currentModel,
          max_credits: Number.parseFloat(options.maxCredits),
        });
        currentWorkflowId = result.workflowId;
        options.onWorkflowIdChange?.(currentWorkflowId);
        chatScreen.setWorkflowId(currentWorkflowId);
      }

      if (currentWorkflowId) {
        // Stream the workflow and handle any clarification requests in a loop.
        // When the workflow pauses for clarification, show the interactive UI,
        // get the user's response, continue the workflow, and stream again.
        let keepStreaming = true;
        while (keepStreaming && currentWorkflowId) {
          const streamResult = await streamWorkflow(currentWorkflowId, chatScreen, async (request: ApprovalRequestState) => {
            const selection = await chatScreen.readMenuSelection(request);
            const decision = (selection ?? 'deny') as ToolApprovalDecision;
            resolveWorkflowApproval(currentWorkflowId!, request.id, decision);
          });

          if (streamResult.clarification) {
            const response = await chatScreen.readClarification(streamResult.clarification);
            if (response) {
              chatScreen.beginUserTurn(response);
              await continueWorkflow(currentWorkflowId, response);
              // Loop to stream the resumed workflow
            } else {
              // User skipped the clarification — stop streaming and return to input
              chatScreen.showSystem('Clarification skipped.', 'muted');
              keepStreaming = false;
            }
          } else {
            keepStreaming = false;
          }
        }
      }
    } catch (error) {
      chatScreen.failAssistantTurn(getErrorMessage(error, 'Interactive workflow failed'));
    }
  }

  options.onWorkflowIdChange?.(null);
  return currentWorkflowId ?? null;
};
