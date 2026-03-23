import { useState, useCallback, useMemo } from 'react';
import { SettingsView } from './components/SettingsView.js';
import { WorkflowList } from './components/WorkflowList.js';
import { InputBar } from './components/InputBar.js';
import { EmptyState } from './components/EmptyState.js';
import { useConfig } from './hooks/useConfig.js';
import { useWorkflows } from './hooks/useWorkflows.js';
import { createWorkflow, cancelWorkflow } from './api/client.js';
import type { ApiConfig } from './api/client.js';

type View = 'main' | 'settings';

interface AppProps {
  clerkEnabled?: boolean;
  getAuthToken?: () => Promise<string | null>;
  hasSessionAuth?: boolean;
  userLabel?: string | null;
  onSignIn?: () => Promise<void>;
  onSignOut?: () => Promise<void>;
}

export function App({
  clerkEnabled = false,
  getAuthToken,
  hasSessionAuth = false,
  userLabel,
  onSignIn,
  onSignOut,
}: AppProps) {
  const { config, saveConfig, isLoaded } = useConfig();
  const [view, setView] = useState<View>('main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const runtimeConfig: ApiConfig = useMemo(
    () => ({
      ...config,
      getAuthToken,
      hasAuth: hasSessionAuth,
    }),
    [config, getAuthToken, hasSessionAuth]
  );
  const isConfigured = config.baseUrl.trim().length > 0 && hasSessionAuth;

  const showMain = isLoaded && isConfigured && view === 'main';
  const { workflows, refresh } = useWorkflows(runtimeConfig, showMain);

  const handleSubmit = useCallback(
    async (objective: string) => {
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await createWorkflow(runtimeConfig, objective);
        refresh();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create workflow');
      } finally {
        setIsSubmitting(false);
      }
    },
    [runtimeConfig, refresh]
  );

  const handleCancel = useCallback(
    async (id: string) => {
      try {
        await cancelWorkflow(runtimeConfig, id);
        refresh();
      } catch {
        /* */
      }
    },
    [runtimeConfig, refresh]
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
          getAuthToken={getAuthToken}
          clerkEnabled={clerkEnabled}
          isSignedIn={hasSessionAuth}
          userLabel={userLabel}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          requiresAuth={!hasSessionAuth}
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
          <WorkflowList workflows={workflows} config={runtimeConfig} onCancel={(id) => void handleCancel(id)} />
        )}
      </div>
    </div>
  );
}
