import type { LiveTask } from '../hooks/useWorkflowStream.js';

const STATUS_DOT: Record<string, { color: string; pulse: boolean }> = {
  pending:   { color: 'rgba(255,255,255,0.15)', pulse: false },
  running:   { color: '#0A84FF', pulse: true },
  completed: { color: '#30D158', pulse: false },
  failed:    { color: '#FF453A', pulse: false },
  skipped:   { color: 'rgba(255,255,255,0.15)', pulse: false },
  blocked:   { color: '#FF9F0A', pulse: false },
  cancelled: { color: 'rgba(255,255,255,0.15)', pulse: false },
};

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

interface Props {
  tasks: LiveTask[];
}

export function TaskProgress({ tasks }: Props) {
  if (tasks.length === 0) return null;

  return (
    <div style={{ paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {tasks.map((task) => {
        const dot = STATUS_DOT[task.status] ?? STATUS_DOT['pending'];
        const isDone = task.status === 'completed' || task.status === 'skipped';
        const isFailed = task.status === 'failed';

        return (
          <div key={task.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 0',
          }}>
            {/* Status dot */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: dot.color,
              boxShadow: dot.pulse ? `0 0 6px ${dot.color}` : 'none',
              animation: dot.pulse ? 'pulse-glow 2s ease-in-out infinite' : 'none',
              color: dot.color,
            }} />

            {/* Description */}
            <span style={{
              flex: 1, fontSize: 11, lineHeight: 1.3, minWidth: 0,
              color: isDone
                ? 'rgba(255,255,255,0.3)'
                : isFailed
                  ? 'rgba(255,69,58,0.7)'
                  : task.status === 'running'
                    ? 'rgba(255,255,255,0.75)'
                    : 'rgba(255,255,255,0.35)',
              textDecoration: isDone ? 'line-through' : 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {truncate(task.description, 50)}
            </span>

            {/* Tool count for running tasks */}
            {task.status === 'running' && task.tool_calls > 0 && (
              <span style={{
                fontSize: 10, color: 'rgba(255,255,255,0.2)', flexShrink: 0,
              }}>
                {task.tool_calls}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
