import { useState, useEffect, useRef, useCallback } from 'react';
import { connectWorkflowStream } from '../api/sse.js';
import { getWorkflowDetails } from '../api/client.js';
import type { ApiConfig } from '../api/client.js';
import type {
  WorkflowEvent,
  WorkflowTask,
  TaskStatus,
  TaskStartedData,
  TaskAddedData,
  ToolEventData,
  TasksInitializedData,
  WorkflowCompletedData,
  WorkflowFailedData,
} from '../api/types.js';
import {
  latestStepPills,
  taskSubtitle,
  taskTitle,
  toolStepText,
  upsertStepPill,
  type PillStatus,
  type StepPill,
} from '../progress/stepPills.js';

export interface LiveTask {
  id: string;
  description: string;
  agent_type: string;
  status: TaskStatus;
  current_activity?: string;
  tool_calls: number;
}

export interface WorkflowLiveState {
  tasks: LiveTask[];
  pills: StepPill[];
  current_activity: string;
  is_terminal: boolean;
  output?: string;
  error?: string;
}

const normalizeTaskStatus = (status: string): TaskStatus => {
  if (
    status === 'pending' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'skipped'
  ) {
    return status;
  }
  return 'pending';
};

const toPillStatus = (status: TaskStatus): PillStatus => {
  if (status === 'completed' || status === 'skipped') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'running') return 'running';
  return 'pending';
};

const upsertTask = (tasks: LiveTask[], next: LiveTask): LiveTask[] => {
  const index = tasks.findIndex((task) => task.id === next.id);
  if (index < 0) {
    return [...tasks, next];
  }
  return tasks.map((task, taskIndex) => (taskIndex === index ? { ...task, ...next } : task));
};

export function useWorkflowStream(config: ApiConfig, workflowId: string, isActive: boolean): WorkflowLiveState {
  const [state, setState] = useState<WorkflowLiveState>({
    tasks: [],
    pills: [],
    current_activity: 'Initializing…',
    is_terminal: false,
  });

  const connectionRef = useRef<{ close: () => void } | null>(null);
  const sequenceRef = useRef(0);
  const activeToolPillsRef = useRef<Record<string, string>>({});

  const nextStamp = () => Date.now() + sequenceRef.current++;

  const taskPillId = (taskId: string) => `task:${taskId}`;

  const addOrUpdateTaskPill = (
    pills: StepPill[],
    taskId: string,
    description: string,
    status: TaskStatus,
    agentType?: string
  ): StepPill[] => {
    const pillStatus = toPillStatus(status);
    return upsertStepPill(pills, {
      id: taskPillId(taskId),
      taskId,
      title: taskTitle(description, agentType),
      subtitle: taskSubtitle(pillStatus, agentType),
      status: pillStatus,
      updatedAt: nextStamp(),
      source: 'task',
    });
  };

  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;

    void getWorkflowDetails(config, workflowId)
      .then((details) => {
        if (cancelled) return;

        setState((prev) => {
          let nextTasks = [...prev.tasks];
          let nextPills = [...prev.pills];

          details.tasks.forEach((task, index) => {
            const taskStatus = normalizeTaskStatus(task.status);
            const createdAtBase = task.created_at ? new Date(task.created_at).getTime() : Date.now();
            const updatedAt = createdAtBase + index;

            nextTasks = upsertTask(nextTasks, {
              id: task.task_id,
              description: task.description,
              agent_type: task.agent_type,
              status: taskStatus,
              tool_calls: 0,
            });

            nextPills = upsertStepPill(nextPills, {
              id: taskPillId(task.task_id),
              taskId: task.task_id,
              title: taskTitle(task.description, task.agent_type),
              subtitle: taskSubtitle(toPillStatus(taskStatus), task.agent_type),
              status: toPillStatus(taskStatus),
              updatedAt,
              source: 'task',
            });
          });

          return {
            ...prev,
            tasks: nextTasks,
            pills: latestStepPills(nextPills),
          };
        });
      })
      .catch(() => {
        // ignore initial hydration failures
      });

    return () => {
      cancelled = true;
    };
  }, [config, workflowId, isActive]);

  const handleEvent = useCallback((event: WorkflowEvent) => {
    setState((prev) => {
      switch (event.type) {
        case 'tasks_initialized': {
          const data = event.data as TasksInitializedData;
          let tasks = [...prev.tasks];
          let pills = [...prev.pills];

          (data.tasks ?? []).forEach((task: WorkflowTask) => {
            tasks = upsertTask(tasks, {
              id: task.id,
              description: task.description,
              agent_type: task.agent_type,
              status: 'pending',
              tool_calls: 0,
            });

            pills = addOrUpdateTaskPill(pills, task.id, task.description, 'pending', task.agent_type);
          });

          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: 'Planning complete, starting tasks…',
          };
        }

        case 'task_added': {
          const data = event.data as TaskAddedData;
          const taskId = event.task_id;
          if (!taskId) return prev;

          const description = data.display_description ?? data.description;
          const agentType = data.agent_type;
          const tasks = upsertTask(prev.tasks, {
            id: taskId,
            description,
            agent_type: agentType,
            status: 'pending',
            tool_calls: 0,
          });
          const pills = addOrUpdateTaskPill(prev.pills, taskId, description, 'pending', agentType);
          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: taskTitle(description, agentType),
          };
        }

        case 'task_started': {
          const data = event.data as TaskStartedData;
          const taskId = event.task_id;
          if (!taskId) return prev;

          const description = data.display_description ?? data.description;
          const agentType = data.agent_type ?? data.task_type ?? 'task';
          const tasks = upsertTask(prev.tasks, {
            id: taskId,
            description,
            agent_type: agentType,
            status: 'running',
            current_activity: description,
            tool_calls: prev.tasks.find((task) => task.id === taskId)?.tool_calls ?? 0,
          });
          const pills = addOrUpdateTaskPill(prev.pills, taskId, description, 'running', agentType);
          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: taskTitle(description, agentType),
          };
        }

        case 'task_completed': {
          const taskId = event.task_id;
          if (!taskId) return prev;

          const existing = prev.tasks.find((task) => task.id === taskId);
          const tasks = upsertTask(prev.tasks, {
            id: taskId,
            description: existing?.description ?? 'Task completed',
            agent_type: existing?.agent_type ?? 'task',
            status: 'completed',
            tool_calls: existing?.tool_calls ?? 0,
          });

          let pills = addOrUpdateTaskPill(
            prev.pills,
            taskId,
            existing?.description ?? 'Task completed',
            'completed',
            existing?.agent_type
          );

          const activeToolPillId = activeToolPillsRef.current[taskId];
          if (activeToolPillId) {
            pills = upsertStepPill(pills, {
              ...(pills.find((pill) => pill.id === activeToolPillId) ?? {
                id: activeToolPillId,
                taskId,
                title: 'Finishing step',
                subtitle: 'Step complete',
                source: 'tool' as const,
              }),
              status: 'completed',
              subtitle: 'Step complete',
              updatedAt: nextStamp(),
            });
            delete activeToolPillsRef.current[taskId];
          }

          const remaining = tasks.filter((t) => t.status === 'running' || t.status === 'pending');
          const activity =
            remaining.length > 0
              ? `${remaining.length} task${remaining.length > 1 ? 's' : ''} remaining…`
              : 'Finishing up…';
          const completionActivity = existing
            ? `${taskTitle(existing.description, existing.agent_type)} complete`
            : activity;
          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: completionActivity,
          };
        }

        case 'task_failed': {
          const taskId = event.task_id;
          if (!taskId) return prev;
          const existing = prev.tasks.find((task) => task.id === taskId);
          const tasks = upsertTask(prev.tasks, {
            id: taskId,
            description: existing?.description ?? 'Task failed',
            agent_type: existing?.agent_type ?? 'task',
            status: 'failed',
            tool_calls: existing?.tool_calls ?? 0,
          });

          const pills = addOrUpdateTaskPill(
            prev.pills,
            taskId,
            existing?.description ?? 'Task failed',
            'failed',
            existing?.agent_type
          );

          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: taskTitle(existing?.description ?? 'Task failed', existing?.agent_type),
          };
        }

        case 'task_skipped': {
          const taskId = event.task_id;
          if (!taskId) return prev;
          const existing = prev.tasks.find((task) => task.id === taskId);
          const tasks = upsertTask(prev.tasks, {
            id: taskId,
            description: existing?.description ?? 'Task skipped',
            agent_type: existing?.agent_type ?? 'task',
            status: 'skipped',
            tool_calls: existing?.tool_calls ?? 0,
          });
          const pills = addOrUpdateTaskPill(
            prev.pills,
            taskId,
            existing?.description ?? 'Task skipped',
            'completed',
            existing?.agent_type
          );
          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
          };
        }

        case 'subagent_tool_call': {
          const data = event.data as ToolEventData;
          const taskId = event.task_id;
          if (!taskId) return prev;

          const text = toolStepText(data.tool_name ?? 'tool', data.tool_input);
          const id = `tool:${taskId}:${sequenceRef.current++}`;
          activeToolPillsRef.current[taskId] = id;

          const pills = upsertStepPill(prev.pills, {
            id,
            taskId,
            title: text.title,
            subtitle: text.subtitle,
            status: 'running',
            updatedAt: nextStamp(),
            source: 'tool',
          });

          const tasks = prev.tasks.map((task) =>
            task.id === taskId ? { ...task, tool_calls: task.tool_calls + 1 } : task
          );

          return {
            ...prev,
            tasks,
            pills: latestStepPills(pills),
            current_activity: text.title,
          };
        }

        case 'subagent_tool_result': {
          const taskId = event.task_id;
          if (!taskId) return prev;
          const activeToolPillId = activeToolPillsRef.current[taskId];
          if (!activeToolPillId) return prev;

          const existing = prev.pills.find((pill) => pill.id === activeToolPillId);
          if (!existing) return prev;

          delete activeToolPillsRef.current[taskId];

          const pills = upsertStepPill(prev.pills, {
            ...existing,
            status: existing.status === 'failed' ? 'failed' : 'completed',
            subtitle: existing.status === 'failed' ? existing.subtitle : 'Step complete',
            updatedAt: nextStamp(),
          });

          return {
            ...prev,
            pills: latestStepPills(pills),
          };
        }

        case 'orchestrator_thinking': {
          const pills = upsertStepPill(prev.pills, {
            id: 'system:thinking',
            title: 'Planning next step',
            subtitle: 'Breaking work into steps...',
            status: 'running',
            updatedAt: nextStamp(),
            source: 'system',
          });
          return {
            ...prev,
            pills: latestStepPills(pills),
            current_activity: 'Planning next step',
          };
        }

        case 'workflow_completed': {
          const data = event.data as WorkflowCompletedData;
          const pills = upsertStepPill(prev.pills, {
            id: `system:completed:${workflowId}`,
            title: 'Workflow complete',
            subtitle: 'All requested steps finished',
            status: 'completed',
            updatedAt: nextStamp(),
            source: 'system',
          });

          return {
            ...prev,
            current_activity: 'Completed',
            pills: latestStepPills(pills),
            is_terminal: true,
            output: data.output,
          };
        }

        case 'workflow_failed': {
          const data = event.data as WorkflowFailedData;
          const pills = upsertStepPill(prev.pills, {
            id: `system:failed:${workflowId}`,
            title: 'Workflow failed',
            subtitle: data.error ?? 'Needs attention',
            status: 'failed',
            updatedAt: nextStamp(),
            source: 'system',
          });

          return {
            ...prev,
            current_activity: 'Failed',
            pills: latestStepPills(pills),
            is_terminal: true,
            error: data.error,
          };
        }

        case 'workflow_cancelled': {
          const data = event.data as { reason?: string };
          const pills = upsertStepPill(prev.pills, {
            id: `system:cancelled:${workflowId}`,
            title: 'Workflow cancelled',
            subtitle: data.reason ?? 'Cancelled by user',
            status: 'failed',
            updatedAt: nextStamp(),
            source: 'system',
          });

          return {
            ...prev,
            current_activity: 'Cancelled',
            pills: latestStepPills(pills),
            is_terminal: true,
            error: data.reason,
          };
        }

        default:
          return prev;
      }
    });
  }, []);

  useEffect(() => {
    if (!isActive) return;

    activeToolPillsRef.current = {};

    connectionRef.current = connectWorkflowStream(
      {
        baseUrl: config.baseUrl,
        getAuthToken: config.getAuthToken,
      },
      workflowId,
      handleEvent,
      (err) => {
        setState((prev) => ({
          ...prev,
          current_activity: `Stream error: ${err.message}`,
        }));
      }
    );

    return () => {
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [config.baseUrl, config.getAuthToken, workflowId, isActive, handleEvent]);

  return {
    ...state,
    pills: latestStepPills(state.pills),
  };
}
