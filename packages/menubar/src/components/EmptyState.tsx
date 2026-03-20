import { ComputerIcon } from './icons/ComputerIcon.js';

interface Props {
  onOpenSettings: () => void;
}

export function EmptyState({ onOpenSettings }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <ComputerIcon className="empty-state-icon-glyph" />
      </div>
      <div className="empty-state-copy">
        <p className="empty-state-title">No active steps</p>
        <p className="empty-state-subtitle">Start a workflow above and the latest three steps will appear here.</p>
      </div>
      <button className="empty-state-link no-drag" onClick={onOpenSettings}>
        Settings
      </button>
    </div>
  );
}
