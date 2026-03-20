import { useMemo } from 'react';
import { useWorkflowStream } from '../hooks/useWorkflowStream.js';
import type { AppConfig } from '../hooks/useConfig.js';
import type { Workflow } from '../api/types.js';
import { ComputerIcon } from './icons/ComputerIcon.js';
import type { PillStatus, StepPill } from '../progress/stepPills.js';

interface Props {
  workflow: Workflow;
  config: AppConfig;
  onCancel: (id: string) => void;
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const isActive = (s: string) => s === 'executing' || s === 'planning';

function toPillStatus(status: string): PillStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'executing' || status === 'planning') return 'running';
  return 'pending';
}

function fallbackPill(workflow: Workflow, currentActivity: string): StepPill {
  if (workflow.status === 'completed') {
    return {
      id: `fallback:${workflow.id}:done`,
      title: 'Workflow complete',
      subtitle: workflow.output ? trunc(workflow.output, 56) : 'All requested steps finished',
      status: 'completed',
      updatedAt: Date.now(),
      source: 'system',
    };
  }

  if (workflow.status === 'failed') {
    return {
      id: `fallback:${workflow.id}:failed`,
      title: 'Workflow failed',
      subtitle: workflow.error ? trunc(workflow.error, 56) : 'Needs attention',
      status: 'failed',
      updatedAt: Date.now(),
      source: 'system',
    };
  }

  return {
    id: `fallback:${workflow.id}:active`,
    title: trunc(workflow.objective, 52),
    subtitle: trunc(currentActivity || 'Preparing steps...', 56),
    status: toPillStatus(workflow.status),
    updatedAt: Date.now(),
    source: 'task',
  };
}

function Pill({ pill, onCancel }: { pill: StepPill; onCancel?: () => void }) {
  return (
    <article className={`workflow-pill workflow-pill--${pill.status}`}>
      <div className={`workflow-pill-icon workflow-pill-icon--${pill.status}`}>
        <ComputerIcon className="workflow-pill-icon-glyph" />
      </div>
      <div className="workflow-pill-copy">
        <p className="workflow-pill-title">{pill.title}</p>
        <p className="workflow-pill-subtitle">{pill.subtitle}</p>
      </div>
      {onCancel && (
        <button className="workflow-pill-cancel no-drag" onClick={onCancel} aria-label="Cancel workflow">
          ×
        </button>
      )}
    </article>
  );
}

export function WorkflowCard({ workflow, config, onCancel }: Props) {
  const active = isActive(workflow.status);
  const live = useWorkflowStream(config, workflow.id, active);
  const pills = useMemo(() => {
    if (live.pills.length > 0) {
      return live.pills;
    }
    return [fallbackPill(workflow, live.current_activity)];
  }, [live.pills, live.current_activity, workflow]);

  return (
    <section className="workflow-stack no-drag">
      <div className="workflow-meta">
        <p className="workflow-meta-objective">{trunc(workflow.objective, 72)}</p>
        <div className="workflow-meta-actions">
          <span className={`workflow-state workflow-state--${toPillStatus(workflow.status)}`}>{workflow.status}</span>
          {active && (
            <button className="workflow-cancel" onClick={() => onCancel(workflow.id)}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="workflow-pill-list">
        {pills.map((pill, i) => (
          <Pill
            key={pill.id}
            pill={pill}
            onCancel={active && i === 0 ? () => onCancel(workflow.id) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
