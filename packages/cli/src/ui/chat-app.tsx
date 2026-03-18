import React from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import type { EventEmitter } from 'node:events';
import type { WorkflowTraceStep } from '@orchestrator/shared';
import { getAllowedOrchestratorModels, getDefaultOrchestratorModel, getModelInfo } from '@orchestrator/model-router';
import {
  createEntryId,
  createInitialState,
  type ApprovalRequestState,
  type ChatScreenState,
  type TranscriptEntry,
  type WorkflowHistoryItem,
} from './chat-state.js';
import {
  formatAgentLabel,
  extractHistoryEntries,
  extractTodoItemsFromTool,
  formatCompletionLabel,
  formatDuration,
  formatTokenCount,
  formatToolLabel,
  formatToolPreview,
  formatToolResultDetail,
  formatWorkflowSummary,
  getToolResultStatus,
  isTodoTool,
  summarizeToolStep,
} from './chat-format.js';
import { MarkdownMessage } from './markdown.js';
import { SPECIAL_LOAD_WORKFLOW, SPECIAL_OPEN_CONTINUE, SPECIAL_SET_MODEL } from './chat-protocol.js';
import { SelectionMenu } from './selection-menu.js';
import { ASCII_LOGO, uiTheme } from './theme.js';

type Action =
  | { type: 'UNLOCK_INPUT' }
  | { type: 'SCROLL_TRANSCRIPT'; payload: { delta: number } }
  | { type: 'BEGIN_USER_TURN'; payload: { text: string } }
  | { type: 'SET_THINKING'; payload: { text: string } }
  | { type: 'STOP_THINKING' }
  | { type: 'SET_STATUS_MESSAGE'; payload: { text: string } }
  | { type: 'APPEND_TOOL_CALL'; payload: { name: string; input: unknown; source: 'orchestrator' | 'subagent' } }
  | { type: 'COMPLETE_TOOL_CALL'; payload: { name: string; output: unknown; source: 'orchestrator' | 'subagent' } }
  | { type: 'BEGIN_SUBAGENT'; payload: { taskId: string; agentType: string; title: string; description: string; model?: string } }
  | { type: 'APPEND_SUBAGENT_STEP'; payload: { taskId: string; toolName: string; input: unknown } }
  | { type: 'COMPLETE_SUBAGENT_STEP'; payload: { taskId: string; toolName: string; output: unknown } }
  | { type: 'COMPLETE_SUBAGENT'; payload: { taskId: string; usageTokens?: number } }
  | { type: 'FAIL_SUBAGENT'; payload: { taskId: string; error?: string } }
  | { type: 'OPEN_APPROVAL_MENU'; payload: { request: ApprovalRequestState } }
  | { type: 'ADD_USAGE_TOKENS'; payload: { tokens: number } }
  | { type: 'ANIMATE_TOKENS'; payload: { step: number } }
  | { type: 'COMPLETE_TURN'; payload: { text: string; credits?: number } }
  | { type: 'FAIL_TURN'; payload: { error: string } }
  | { type: 'SHOW_SYSTEM'; payload: { text: string; tone?: 'muted' | 'error' | 'success' } }
  | { type: 'SET_WORKFLOW_ID'; payload: { id: string } }
  | { type: 'SHOW_HISTORY'; payload: { trace: WorkflowTraceStep[] } }
  | { type: 'SET_MODEL'; payload: { model: string } }
  | { type: 'OPEN_MODEL_MENU' }
  | { type: 'OPEN_CONTINUE_MENU'; payload: { workflows: WorkflowHistoryItem[] } }
  | { type: 'CLOSE_MENU' };

interface Props {
  eventBus: EventEmitter;
  onSubmit: (value: string | null) => void;
  onMenuSelection: (value: string | null) => void;
  onInterrupt: () => void;
  onReady: () => void;
  modelLabel: string;
  cwdLabel: string;
  initialModel?: string;
}

const slashCommands = [
  { name: '/help', description: 'Show chat commands' },
  { name: '/model', description: 'Open model selector' },
  { name: '/continue', description: 'Open workflow history' },
  { name: '/exit', description: 'Exit chat mode' },
];

const formatModelDisplay = (modelId: string): { name: string; description: string; isDefault?: boolean } => {
  const modelInfo = getModelInfo(modelId);
  const defaultModel = getDefaultOrchestratorModel();

  if (modelInfo?.display_name) {
    return {
      name: modelInfo.display_name.replace(/\s*\(via LiteLLM\)$/i, ''),
      description: modelId,
      isDefault: modelId === defaultModel,
    };
  }

  return {
    name: modelId.split('/').pop() ?? modelId,
    description: modelId,
    isDefault: modelId === defaultModel,
  };
};

const finishRunningTools = (transcript: TranscriptEntry[]): TranscriptEntry[] => {
  return transcript.map((entry) => {
    if (entry.type !== 'tool' || entry.status !== 'running') return entry;
    return { ...entry, status: 'done' };
  });
};

const getVisibleTranscript = (transcript: TranscriptEntry[]): TranscriptEntry[] => {
  return transcript;
};

const VISIBLE_TRANSCRIPT_LIMIT = 18;

const appendTranscriptEntries = (
  state: ChatScreenState,
  entries: TranscriptEntry[],
): Pick<ChatScreenState, 'transcript' | 'scrollOffset'> => {
  if (entries.length === 0) {
    return { transcript: state.transcript, scrollOffset: state.scrollOffset };
  }

  return {
    transcript: [...state.transcript, ...entries],
    scrollOffset: state.scrollOffset > 0 ? state.scrollOffset + entries.length : 0,
  };
};

const reducer = (state: ChatScreenState, action: Action): ChatScreenState => {
  switch (action.type) {
    case 'UNLOCK_INPUT':
      return { ...state, inputUnlocked: true };
    case 'SCROLL_TRANSCRIPT': {
      const maxOffset = Math.max(0, state.transcript.length - VISIBLE_TRANSCRIPT_LIMIT);
      return {
        ...state,
        scrollOffset: Math.min(maxOffset, Math.max(0, state.scrollOffset + action.payload.delta)),
      };
    }
    case 'BEGIN_USER_TURN':
      return {
        ...state,
        busy: true,
        inputUnlocked: false,
        statusStartedAt: Date.now(),
        totalTokensTarget: 0,
        totalTokensDisplay: 0,
        thinkingText: '',
        thinkingActive: false,
        statusMessage: '',
        currentQuip: getRandomQuip(),
        scrollOffset: 0,
        transcript: [...state.transcript, { id: createEntryId(), type: 'user', text: action.payload.text }],
      };
    case 'SET_THINKING': {
      const text = action.payload.text.trim();
      return { ...state, thinkingText: text, thinkingActive: text.length > 0 };
    }
    case 'STOP_THINKING':
      return { ...state, thinkingText: '', thinkingActive: false };
    case 'SET_STATUS_MESSAGE':
      return { ...state, statusMessage: action.payload.text.trim() };
    case 'APPEND_TOOL_CALL': {
      if (action.payload.source === 'subagent') {
        const transcript = [...state.transcript];
        for (let index = transcript.length - 1; index >= 0; index -= 1) {
          const entry = transcript[index];
          if (entry?.type !== 'subagent' || entry.status !== 'running') continue;
          transcript[index] = {
            ...entry,
            steps: [
              ...entry.steps,
              {
                id: createEntryId(),
                toolName: action.payload.name,
                input: action.payload.input,
                status: 'running',
              },
            ],
          };
          return {
            ...state,
            thinkingText: '',
            thinkingActive: false,
            scrollOffset: 0,
            transcript,
          };
        }
      }

      const appended = appendTranscriptEntries(state, [
        {
          id: createEntryId(),
          type: 'tool',
          toolName: action.payload.name,
          input: action.payload.input,
          status: 'running',
          source: action.payload.source,
        },
      ]);

      return {
        ...state,
        thinkingText: '',
        thinkingActive: false,
        ...appended,
      };
    }
    case 'COMPLETE_TOOL_CALL': {
      const transcript = [...state.transcript];
      if (action.payload.source === 'subagent') {
        for (let index = transcript.length - 1; index >= 0; index -= 1) {
          const entry = transcript[index];
          if (entry?.type !== 'subagent' || entry.status !== 'running') continue;

          const steps = [...entry.steps];
          for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
            const step = steps[stepIndex];
            if (step.status === 'running' && step.toolName === action.payload.name) {
              steps[stepIndex] = {
                ...step,
                output: action.payload.output,
                status: getToolResultStatus(action.payload.output),
              };
              transcript[index] = {
                ...entry,
                steps,
                toolUses: steps.filter((candidate) => candidate.status !== 'running').length,
              };
              return { ...state, transcript };
            }
          }
        }
      }

      for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const entry = transcript[index];
        if (
          entry?.type === 'tool' &&
          entry.status === 'running' &&
          entry.toolName === action.payload.name &&
          entry.source === action.payload.source
        ) {
          transcript[index] = {
            ...entry,
            output: action.payload.output,
            status: getToolResultStatus(action.payload.output),
          };
          break;
        }
      }
      return { ...state, scrollOffset: 0, transcript };
    }
    case 'BEGIN_SUBAGENT': {
      const appended = appendTranscriptEntries(state, [
        {
          id: createEntryId(),
          type: 'subagent',
          taskId: action.payload.taskId,
          agentType: action.payload.agentType,
          title: action.payload.title,
          description: action.payload.description,
          status: 'running',
          steps: [],
          startedAt: Date.now(),
          toolUses: 0,
          model: action.payload.model,
        },
      ]);

      return {
        ...state,
        ...appended,
      };
    }
    case 'COMPLETE_SUBAGENT': {
      const transcript = [...state.transcript];
      for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const entry = transcript[index];
        if (entry?.type !== 'subagent' || entry.taskId !== action.payload.taskId) continue;
        transcript[index] = {
          ...entry,
          status: 'done',
          usageTokens: action.payload.usageTokens,
          durationMs: Date.now() - entry.startedAt,
          toolUses: entry.steps.filter((step) => step.status !== 'running').length,
        };
        break;
      }
      return { ...state, scrollOffset: 0, transcript };
    }
    case 'FAIL_SUBAGENT': {
      const transcript = [...state.transcript];
      for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const entry = transcript[index];
        if (entry?.type !== 'subagent' || entry.taskId !== action.payload.taskId) continue;
        transcript[index] = {
          ...entry,
          status: 'error',
          durationMs: Date.now() - entry.startedAt,
          error: action.payload.error,
        };
        break;
      }
      return { ...state, scrollOffset: 0, transcript };
    }
    case 'ADD_USAGE_TOKENS':
      return { ...state, totalTokensTarget: state.totalTokensTarget + action.payload.tokens };
    case 'ANIMATE_TOKENS':
      return {
        ...state,
        totalTokensDisplay: Math.min(state.totalTokensTarget, state.totalTokensDisplay + action.payload.step),
      };
    case 'COMPLETE_TURN': {
      const text = action.payload.text.trim() || 'No output';
      const durationMs = state.statusStartedAt ? Date.now() - state.statusStartedAt : 0;
      const totalTokens = state.totalTokensTarget;
      const finishedTranscript = finishRunningTools(state.transcript);
      const appended = appendTranscriptEntries({ ...state, transcript: finishedTranscript }, [
        { id: createEntryId(), type: 'assistant', text },
        {
          id: createEntryId(),
          type: 'system',
          text: formatCompletionLabel(durationMs, action.payload.credits, totalTokens),
          tone: 'muted',
        },
      ]);

      return {
        ...state,
        busy: false,
        statusStartedAt: null,
        totalTokensDisplay: totalTokens,
        thinkingText: '',
        thinkingActive: false,
        statusMessage: '',
        ...appended,
      };
    }
    case 'FAIL_TURN':
      return {
        ...state,
        busy: false,
        statusStartedAt: null,
        thinkingText: '',
        thinkingActive: false,
        statusMessage: '',
        ...appendTranscriptEntries({ ...state, transcript: finishRunningTools(state.transcript) }, [
          { id: createEntryId(), type: 'system', text: action.payload.error, tone: 'error' },
        ]),
      };
    case 'SHOW_SYSTEM':
      return {
        ...state,
        ...appendTranscriptEntries(state, [
          { id: createEntryId(), type: 'system', text: action.payload.text, tone: action.payload.tone },
        ]),
      };
    case 'SET_WORKFLOW_ID':
      return { ...state, workflowId: action.payload.id };
    case 'SHOW_HISTORY': {
      const transcript = extractHistoryEntries(action.payload.trace).map((entry) => {
        if (entry.type === 'assistant') {
          return { id: createEntryId(), type: 'assistant' as const, text: entry.text };
        }

        return {
          id: createEntryId(),
          type: 'tool' as const,
          toolName: entry.toolName,
          input: entry.toolInput,
          output: undefined,
          status: 'done' as const,
          source: 'subagent' as const,
        };
      });
      return { ...state, transcript, menu: null, busy: false, thinkingText: '', thinkingActive: false, scrollOffset: 0 };
    }
    case 'SET_MODEL':
      return { ...state, currentModel: action.payload.model, menu: null };
    case 'OPEN_MODEL_MENU':
      return { ...state, menu: { type: 'model' } };
    case 'OPEN_CONTINUE_MENU':
      return { ...state, menu: { type: 'continue', options: action.payload.workflows } };
    case 'OPEN_APPROVAL_MENU':
      return { ...state, menu: { type: 'approval', request: action.payload.request } };
    case 'CLOSE_MENU':
      return { ...state, menu: null };
    default:
      return state;
  }
};

const AppHeader = React.memo(({ modelLabel, cwdLabel }: { modelLabel: string; cwdLabel: string }) => (
  <Box flexDirection="row" marginBottom={1}>
    <Box flexDirection="column">
      {ASCII_LOGO.map((line, index) => (
        <Text key={`${index}-${line}`} color={uiTheme.text}>
          {line}
        </Text>
      ))}
    </Box>
    <Box flexDirection="column" marginLeft={2} justifyContent="center">
      <Text color={uiTheme.text} bold>
        Orchestrator
      </Text>
      <Text color={uiTheme.accentSoft}>{modelLabel}</Text>
      <Text color={uiTheme.faint}>{cwdLabel}</Text>
    </Box>
  </Box>
));

const ToolStatusDot = ({ status }: { status: Extract<TranscriptEntry, { type: 'tool' }>['status'] }) => {
  if (status === 'running') {
    return <Text color={uiTheme.text}>{'● '}</Text>;
  }
  if (status === 'error') {
    return <Text color={uiTheme.error}>{'● '}</Text>;
  }
  return <Text color={uiTheme.success}>{'● '}</Text>;
};

const TodoStatusMark = ({ status }: { status: string }) => {
  if (status === 'completed') {
    return <Text color={uiTheme.success}>{'☒ '}</Text>;
  }
  if (status === 'running') {
    return <Text color={uiTheme.text}>{'◐ '}</Text>;
  }
  if (status === 'failed' || status === 'cancelled') {
    return <Text color={uiTheme.error}>{'☒ '}</Text>;
  }
  if (status === 'skipped') {
    return <Text color={uiTheme.faint}>{'☒ '}</Text>;
  }
  return <Text color={uiTheme.muted}>{'☐ '}</Text>;
};

const TodoListToolEntry = ({ entry }: { entry: Extract<TranscriptEntry, { type: 'tool' }> }) => {
  const items = extractTodoItemsFromTool(entry.toolName, entry.input, entry.output);
  const titleColor = uiTheme.text;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <ToolStatusDot status={entry.status} />
        <Text color={titleColor} bold>
          Update Todos
        </Text>
      </Box>
      {items.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {items.map((item, index) => {
            const done = item.status === 'completed' || item.status === 'skipped';
            const failed = item.status === 'failed' || item.status === 'cancelled';
            const color = failed ? uiTheme.error : done ? uiTheme.success : uiTheme.text;
            return (
              <Box key={`${item.id || item.description}-${index}`}>
                <Text color={uiTheme.faint}>{index === 0 ? '└ ' : '  '}</Text>
                <TodoStatusMark status={item.status} />
                <Text color={color} strikethrough={done}>
                  {item.description}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
};

const ToolEntry = React.memo(({ entry }: { entry: Extract<TranscriptEntry, { type: 'tool' }> }) => {
  if (isTodoTool(entry.toolName)) {
    return <TodoListToolEntry entry={entry} />;
  }

  const preview = formatToolPreview(entry.toolName, entry.input);
  const label = formatToolLabel(entry.toolName, entry.input);
  const detail = formatToolResultDetail(entry.toolName, entry.output) ?? preview.detail ?? '(No content)';
  const titleColor = uiTheme.text;
  const detailColor = entry.status === 'error' ? uiTheme.error : uiTheme.muted;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <ToolStatusDot status={entry.status} />
        <Text color={titleColor} bold>
          {label}
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={uiTheme.faint}>{'└ '}</Text>
        <Text color={detailColor}>{detail}</Text>
      </Box>
    </Box>
  );
});

const SubagentEntry = React.memo(({ entry }: { entry: Extract<TranscriptEntry, { type: 'subagent' }> }) => {
  const dotColor = entry.status === 'error' ? uiTheme.error : entry.status === 'done' ? uiTheme.success : uiTheme.text;
  const summaryColor = entry.status === 'error' ? uiTheme.error : uiTheme.faint;
  const header = `${formatAgentLabel(entry.agentType)}(${entry.title})`;
  const visibleSteps = entry.steps.slice(-3); // Show latest 3 steps
  const hiddenCount = entry.steps.length - visibleSteps.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={dotColor}>{'● '}</Text>
        <Text color={uiTheme.text} bold>
          {header}
        </Text>
      </Box>

      <Box flexDirection="column" marginLeft={2}>
        {visibleSteps.length > 0 ? (
          <Box flexDirection="column">
            {visibleSteps.map((step, index) => {
              const stepLabel = formatToolLabel(step.toolName, step.input);
              const stepColor = step.status === 'error' ? uiTheme.error : step.status === 'done' ? uiTheme.muted : uiTheme.text;
              return (
                <Box key={`${step.id}-${index}`}>
                  <Text color={uiTheme.faint}>{index === 0 ? '└ ' : '  '}</Text>
                  <Text color={stepColor}>{stepLabel}</Text>
                </Box>
              );
            })}
            
            {hiddenCount > 0 ? (
              <Box>
                <Text color={uiTheme.faint}>{'  '}</Text>
                <Text color={uiTheme.faint}>{`+${hiddenCount} more tool uses`}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {entry.status !== 'running' ? (
          <Box flexDirection="column">
            <Box>
              <Text color={uiTheme.faint}>{'└ '}</Text>
              <Text color={summaryColor}>{`${entry.status === 'done' ? 'Done' : 'Failed'} (${entry.toolUses} tool uses${entry.usageTokens ? ` · ${formatTokenCount(entry.usageTokens)} tokens` : ''}${entry.model ? ` · ${entry.model.split('/').pop()}` : ''}${entry.durationMs ? ` · ${formatDuration(entry.durationMs)}` : ''})`}</Text>
            </Box>
            {entry.status === 'error' && entry.error ? (
              <Box>
                <Text color={uiTheme.faint}>{'  '}</Text>
                <Text color={uiTheme.error}>{entry.error}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});

const MessageEntry = React.memo(({ entry }: { entry: TranscriptEntry }) => {
  if (entry.type === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color={uiTheme.muted}>{'❯ '}</Text>
        <Text color={uiTheme.text}>{entry.text}</Text>
      </Box>
    );
  }

  if (entry.type === 'assistant') {
    return <MarkdownMessage text={entry.text} />;
  }

  if (entry.type === 'tool') {
    return <ToolEntry entry={entry} />;
  }

  if (entry.type === 'subagent') {
    return <SubagentEntry entry={entry} />;
  }

  const color = entry.type === 'system' && entry.tone === 'error'
    ? uiTheme.error
    : entry.type === 'system' && entry.tone === 'success'
      ? uiTheme.success
      : uiTheme.muted;
  return (
    <Box marginBottom={1}>
      <Text color={color}>{entry.type === 'system' ? entry.text : ''}</Text>
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render if entry identity or status changes
  if (prevProps.entry.id !== nextProps.entry.id) return false;
  if (prevProps.entry.type !== nextProps.entry.type) return false;
  
  // For tool entries, check if status or output changed
  if (prevProps.entry.type === 'tool' && nextProps.entry.type === 'tool') {
    if (prevProps.entry.status !== nextProps.entry.status) return false;
    if (prevProps.entry.output !== nextProps.entry.output) return false;
  }
  
  // For subagent entries, check if status or steps changed
  if (prevProps.entry.type === 'subagent' && nextProps.entry.type === 'subagent') {
    if (prevProps.entry.status !== nextProps.entry.status) return false;
    if (prevProps.entry.steps.length !== nextProps.entry.steps.length) return false;
  }
  
  return true;
});

const THINKING_QUIPS = [
  'Working',
  'Philosophising',
  'Contemplating',
  'Pondering',
  'Deliberating',
  'Ruminating',
  'Meditating',
  'Reflecting',
  'Analyzing',
  'Processing',
  'Computing',
  'Synthesizing',
  'Reasoning',
  'Cogitating',
  'Brainstorming',
  'Evaluating',
  'Honking',
  'Brewing',
  'Simmering',
  'Marinating',
  'Perusing',
  'Scrutinizing',
  'Investigating',
  'Exploring',
  'Discovering',
  'Unraveling',
  'Deciphering',
  'Unpacking',
  'Deconstructing',
  'Reassembling',
  'Orchestrating',
  'Conducting',
  'Harmonizing',
  'Synchronizing',
  'Aligning',
  'Calibrating',
  'Optimizing',
  'Refining',
  'Polishing',
  'Perfecting',
  'Distilling',
  'Condensing',
  'Crystallizing',
  'Materializing',
  'Manifesting',
  'Conjuring',
  'Weaving',
  'Stitching',
  'Knitting',
  'Forging',
  'Crafting',
  'Sculpting',
  'Carving',
  'Etching',
  'Inscribing',
  'Transcribing',
  'Encoding',
  'Encrypting',
  'Decoding',
  'Translating',
  'Interpreting',
  'Rendering',
  'Projecting',
  'Visualizing',
  'Conceptualizing',
  'Ideating',
  'Innovating',
  'Pioneering',
  'Trailblazing',
  'Navigating',
  'Charting',
  'Mapping',
  'Plotting',
  'Scheming',
  'Strategizing',
  'Tactizing',
  'Maneuvering',
  'Pivoting',
  'Adapting',
  'Evolving',
  'Metamorphosing',
  'Transforming',
  'Transmuting',
  'Alchemizing',
  'Catalyzing',
  'Accelerating',
  'Propelling',
  'Thrusting',
  'Launching',
  'Deploying',
  'Distributing',
  'Disseminating',
  'Propagating',
  'Cascading',
  'Rippling',
  'Resonating',
  'Reverberating',
  'Echoing',
  'Amplifying',
  'Magnifying',
  'Intensifying',
  'Deepening',
  'Broadening',
  'Expanding',
  'Extending',
  'Stretching',
  'Reaching',
  'Grasping',
  'Seizing',
  'Capturing',
  'Hunting',
  'Stalking',
  'Pursuing',
  'Chasing',
  'Tracking',
  'Tracing',
  'Following',
  'Observing',
  'Witnessing',
  'Beholding',
  'Perceiving',
  'Sensing',
  'Feeling',
  'Intuiting',
  'Divining',
  'Auguring',
  'Foreseeing',
  'Anticipating',
  'Expecting',
  'Awaiting',
  'Abiding',
  'Dwelling',
  'Lingering',
  'Loitering',
  'Meandering',
  'Wandering',
  'Roaming',
  'Rambling',
  'Strolling',
  'Sauntering',
  'Ambling',
  'Moseying',
  'Milling',
  'Pacing',
  'Treading',
  'Trudging',
  'Plodding',
  'Tramping',
  'Slogging',
  'Toiling',
  'Laboring',
  'Striving',
  'Endeavoring',
  'Attempting',
  'Trying',
  'Essaying',
  'Venturing',
  'Daring',
  'Risking',
  'Gambling',
  'Wagering',
  'Betting',
  'Speculating',
  'Hypothesizing',
  'Theorizing',
  'Postulating',
  'Proposing',
  'Suggesting',
  'Recommending',
  'Advising',
  'Counseling',
  'Guiding',
  'Directing',
  'Leading',
  'Steering',
  'Piloting',
  'Navigating',
];

const getRandomQuip = (): string => THINKING_QUIPS[Math.floor(Math.random() * THINKING_QUIPS.length)] ?? 'Working';

const BusyIndicator = ({ startedAt, statusMessage, currentQuip }: { startedAt: number | null; statusMessage: string; currentQuip: string }) => {
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 250);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Date.now() - (startedAt ?? Date.now());
  const parts: string[] = [formatDuration(elapsed)];
  if (statusMessage) parts.push(statusMessage);
  parts.push('esc to interrupt');
  const shineFrames = ['.', 'o', 'O', 'o'];
  const shine = shineFrames[tick % shineFrames.length] ?? '.';

  return (
    <Box marginBottom={1}>
      <Text color={tick % 8 >= 5 ? uiTheme.glare : uiTheme.error}>{`${shine} ${currentQuip}... `}</Text>
      <Text color={uiTheme.muted}>{`(${parts.join(' · ')})`}</Text>
    </Box>
  );
};

interface ChatInputProps {
  disabled: boolean;
  currentModel: string;
  workflowId: string | null;
  menu: ChatScreenState['menu'];
  onSubmit: (value: string) => void;
  onMenuSelect: (value: string | null) => void;
  onOpenModelMenu: () => void;
  onShowSystem: (text: string, tone?: 'muted' | 'error' | 'success') => void;
  onCloseMenu: () => void;
  onScrollTranscript: (delta: number) => void;
}

const ChatInput = ({ disabled, currentModel, workflowId, menu, onSubmit, onMenuSelect, onOpenModelMenu, onShowSystem, onCloseMenu, onScrollTranscript }: ChatInputProps) => {
  const [value, setValue] = React.useState('');
  const [suggestions, setSuggestions] = React.useState<typeof slashCommands>([]);
  const { stdout } = useStdout();
  const width = Math.max(40, stdout.columns || 80);

  const refreshSuggestions = React.useCallback((next: string) => {
    if (!next.startsWith('/')) {
      setSuggestions([]);
      return;
    }
    setSuggestions(slashCommands.filter((command) => command.name.startsWith(next.toLowerCase())));
  }, []);

  const handleCommand = React.useCallback((raw: string): boolean => {
    const command = raw.trim();
    if (!command) return true;

    if (command === '/help') {
      onShowSystem('Commands: /help, /model, /continue, /exit', 'muted');
      return true;
    }

    if (command === '/model') {
      onOpenModelMenu();
      return true;
    }

    if (command === '/continue') {
      onSubmit(SPECIAL_OPEN_CONTINUE);
      return true;
    }

    if (command === '/exit' || command === '/quit') {
      onSubmit('/exit');
      return true;
    }

    return false;
  }, [onOpenModelMenu, onShowSystem, onSubmit]);

  const submitValue = React.useCallback((raw: string) => {
    if (!raw.trim()) return;
    const handled = raw.startsWith('/') ? handleCommand(raw) : false;
    if (!handled) {
      onSubmit(raw.trim());
    }
  }, [handleCommand, onSubmit]);

  useInput((input, key) => {
    if (key.pageUp || (key.ctrl && input === 'p')) {
      onScrollTranscript(5);
      return;
    }

    if (key.pageDown || (key.ctrl && input === 'n')) {
      onScrollTranscript(-5);
      return;
    }

    if (disabled || menu) return;

    if (key.return || input === '\r' || input === '\n') {
      submitValue(value);
      setValue('');
      setSuggestions([]);
      return;
    }

    if (key.tab) {
      if (suggestions.length === 1) {
        setValue(`${suggestions[0].name} `);
        setSuggestions([]);
      }
      return;
    }

    if (key.backspace || key.delete) {
      const next = value.slice(0, -1);
      setValue(next);
      refreshSuggestions(next);
      return;
    }

    if (key.ctrl && input === 'u') {
      setValue('');
      setSuggestions([]);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const normalized = input.replace(/\r/g, '\n');
      if (normalized.includes('\n')) {
        const parts = normalized.split('\n');
        let nextValue = value;
        for (let index = 0; index < parts.length; index += 1) {
          nextValue += parts[index] ?? '';
          const isLast = index === parts.length - 1;
          if (!isLast) {
            submitValue(nextValue);
            nextValue = '';
          }
        }
        setValue(nextValue);
        refreshSuggestions(nextValue);
        return;
      }

      const next = value + input;
      setValue(next);
      refreshSuggestions(next);
    }
  }, { isActive: true });

  if (menu?.type === 'model') {
    return (
      <SelectionMenu
        title="Select model"
        subtitle="Applies to this interactive session."
        options={getAllowedOrchestratorModels().map((model) => {
          const display = formatModelDisplay(model);
          return {
            id: model,
            label: display.name,
            description: display.description,
            tag: model === currentModel ? 'current' : display.isDefault ? 'default' : undefined,
          };
        })}
        onSelect={(model) => onSubmit(`${SPECIAL_SET_MODEL}${model}`)}
        onCancel={onCloseMenu}
      />
    );
  }

  if (menu?.type === 'continue') {
    return (
      <SelectionMenu
        title="Continue workflow"
        subtitle="Load a previous chat and keep going from there."
        options={menu.options.map((workflow) => ({
          id: workflow.id,
          label: workflow.objective,
          description: formatWorkflowSummary(workflow),
          tag: workflow.id === workflowId ? 'current' : undefined,
        }))}
        onSelect={(id) => onSubmit(`${SPECIAL_LOAD_WORKFLOW}${id}`)}
        onCancel={onCloseMenu}
      />
    );
  }

  if (menu?.type === 'approval') {
    return (
      <SelectionMenu
        title={menu.request.title}
        subtitle={menu.request.subtitle}
        options={[
          { id: 'approve', label: 'Approve' },
          { id: 'approve_command_session', label: `Approve all ${menu.request.command || 'this command'} this session` },
          { id: 'approve_all_session', label: 'Approve all commands this session' },
          { id: 'deny', label: 'Deny' },
        ]}
        onSelect={(id) => onMenuSelect(id)}
        onCancel={() => onMenuSelect('deny')}
      />
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(width)}</Text>
      <Box>
        <Text color={disabled ? uiTheme.faint : uiTheme.muted}>{'❯ '}</Text>
        <Text color={disabled ? uiTheme.faint : uiTheme.text}>{value}</Text>
        {!disabled ? <Text backgroundColor={uiTheme.accentSoft} color={uiTheme.codeBg}>{' '}</Text> : null}
      </Box>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(width)}</Text>
      {!disabled && suggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {suggestions.map((command) => (
            <Box key={command.name}>
              <Text color={uiTheme.accent}>{command.name.padEnd(12, ' ')}</Text>
              <Text color={uiTheme.muted}>{command.description}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

export const OrchestratorChatApp = ({ eventBus, onSubmit, onMenuSelection, onInterrupt, onReady, cwdLabel, initialModel }: Props) => {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();
  const [state, dispatch] = React.useReducer(reducer, createInitialState(initialModel || getDefaultOrchestratorModel()));

  React.useEffect(() => {
    if (!isRawModeSupported) return;
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [isRawModeSupported, setRawMode]);

  const onSubmitRef = React.useRef(onSubmit);
  React.useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  React.useEffect(() => {
    const handler = (action: Action) => dispatch(action);
    eventBus.on('action', handler);
    return () => {
      eventBus.off('action', handler);
    };
  }, [eventBus]);

  React.useEffect(() => {
    onReady();
  }, [onReady]);

  React.useEffect(() => {
    if (state.totalTokensDisplay >= state.totalTokensTarget) return;
    const timer = setTimeout(() => {
      const gap = state.totalTokensTarget - state.totalTokensDisplay;
      dispatch({ type: 'ANIMATE_TOKENS', payload: { step: Math.max(1, Math.ceil(gap / 8)) } });
    }, 45);
    return () => clearTimeout(timer);
  }, [state.totalTokensDisplay, state.totalTokensTarget]);

  useInput((input, key) => {
    if (state.busy && key.escape) {
      onInterrupt();
      return;
    }

    if (key.escape) {
      dispatch({ type: 'CLOSE_MENU' });
      return;
    }

    if (key.ctrl && input === 'c') {
      onSubmitRef.current(null);
      exit();
    }
  }, { isActive: isRawModeSupported === true });

  const visibleTranscript = getVisibleTranscript(state.transcript);
  const maxOffset = Math.max(0, visibleTranscript.length - VISIBLE_TRANSCRIPT_LIMIT);
  const boundedOffset = Math.min(state.scrollOffset, maxOffset);
  const visibleStart = Math.max(0, visibleTranscript.length - VISIBLE_TRANSCRIPT_LIMIT - boundedOffset);
  const visibleEnd = boundedOffset === 0 ? visibleTranscript.length : visibleTranscript.length - boundedOffset;
  const scrolledTranscript = visibleTranscript.slice(visibleStart, visibleEnd);
  const canScrollUp = visibleStart > 0;
  const canScrollDown = visibleEnd < visibleTranscript.length;

  return (
    <Box flexDirection="column">
      <AppHeader modelLabel={formatModelDisplay(state.currentModel).name} cwdLabel={cwdLabel} />

      <Box flexDirection="column">
        {canScrollUp ? (
          <Box marginBottom={1}>
            <Text color={uiTheme.faint}>{`↑ ${visibleStart} earlier item${visibleStart === 1 ? '' : 's'} · PgUp/Ctrl+P`}</Text>
          </Box>
        ) : null}
        {scrolledTranscript.map((entry) => (
          <MessageEntry key={entry.id} entry={entry} />
        ))}
        {state.busy ? (
          <BusyIndicator
            startedAt={state.statusStartedAt}
            statusMessage={state.statusMessage}
            currentQuip={state.currentQuip}
          />
        ) : null}
        {canScrollDown ? (
          <Box marginBottom={1}>
            <Text color={uiTheme.faint}>{`↓ ${visibleTranscript.length - visibleEnd} newer item${visibleTranscript.length - visibleEnd === 1 ? '' : 's'} · PgDn/Ctrl+N`}</Text>
          </Box>
        ) : null}
      </Box>

      {isRawModeSupported ? (
        <Box marginTop={1} marginBottom={2}>
          <ChatInput
            disabled={state.busy}
            currentModel={state.currentModel}
            workflowId={state.workflowId}
            menu={state.menu}
            onSubmit={(value) => onSubmitRef.current(value)}
            onMenuSelect={onMenuSelection}
            onOpenModelMenu={() => dispatch({ type: 'OPEN_MODEL_MENU' })}
            onShowSystem={(text, tone) => dispatch({ type: 'SHOW_SYSTEM', payload: { text, tone } })}
            onCloseMenu={() => dispatch({ type: 'CLOSE_MENU' })}
            onScrollTranscript={(delta) => dispatch({ type: 'SCROLL_TRANSCRIPT', payload: { delta } })}
          />
        </Box>
      ) : null}
    </Box>
  );
};
