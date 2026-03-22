import { WorkflowCard } from './WorkflowCard.js';
import type { ApiConfig } from '../api/client.js';
import type { Workflow } from '../api/types.js';

interface Props {
  workflows: Workflow[];
  config: ApiConfig;
  onCancel: (id: string) => void;
}

export function WorkflowList({ workflows, config, onCancel }: Props) {
  return (
    <div className="workflow-list">
      {workflows.map((w) => (
        <WorkflowCard key={w.id} workflow={w} config={config} onCancel={onCancel} />
      ))}
    </div>
  );
}
