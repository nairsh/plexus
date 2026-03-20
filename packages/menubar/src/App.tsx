import { useState, useCallback } from 'react';
import { SettingsView } from './components/SettingsView.js';
import { WorkflowList } from './components/WorkflowList.js';
import { InputBar } from './components/InputBar.js';
import { EmptyState } from './components/EmptyState.js';
import { useConfig } from './hooks/useConfig.js';
import { useWorkflows } from './hooks/useWorkflows.js';
import { createWorkflow, cancelWorkflow } from './api/client.js';

type View = 'main' | 'settings';

export function App() {
  const { config, saveConfig, isLoaded, isConfigured } = useConfig();
  const [view, setView] = useState<View>('main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const showMain = isLoaded && isConfigured && view === 'main';
  const { workflows, refresh } = useWorkflows(config, showMain);

  const handleSubmit = useCallback(
    async (objective: string) => {
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await createWorkflow(config, objective);
        refresh();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create workflow');
      } finally {
        setIsSubmitting(false);
      }
    },
    [config, refresh]
  );

  const handleCancel = useCallback(
    async (id: string) => {
      try {
        await cancelWorkflow(config, id);
        refresh();
      } catch {
        /* */
      }
    },
    [config, refresh]
  );

  if (!isLoaded) {
    return <div className="window-shell app-shell h-full" />;
  }

  if (!isConfigured || view === 'settings') {
    return (
      <div className="window-shell app-shell h-full flex flex-col p-3">
        <SettingsView
          config={config}
          onSave={saveConfig}
          onDismiss={isConfigured ? () => setView('main') : undefined}
          isFirstLaunch={!isConfigured}
        />
      </div>
    );
  }

  return (
    <div className="window-shell app-shell h-full flex flex-col">
      <div className="app-topbar drag-region">
        <button className="app-settings-button no-drag" onClick={() => setView('settings')}>
          Settings
        </button>
      </div>

      <div className="app-input-row no-drag">
        <InputBar onSubmit={(o) => void handleSubmit(o)} isSubmitting={isSubmitting} />
        {submitError && <p className="submit-error">{submitError}</p>}
      </div>

      <div className="app-content no-drag">
        {workflows.length === 0 ? (
          <EmptyState onOpenSettings={() => setView('settings')} />
        ) : (
          <WorkflowList workflows={workflows} config={config} onCancel={(id) => void handleCancel(id)} />
        )}
      </div>
    </div>
  );
}
