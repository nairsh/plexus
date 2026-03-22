import { useState } from 'react';
import { checkHealth } from '../api/client.js';
import type { AppConfig } from '../hooks/useConfig.js';

interface Props {
  config: AppConfig;
  onSave: (config: AppConfig) => void;
  clerkEnabled?: boolean;
  isSignedIn?: boolean;
  userLabel?: string | null;
  onSignIn?: () => Promise<void>;
  onSignOut?: () => Promise<void>;
  getAuthToken?: () => Promise<string | null>;
  requiresAuth?: boolean;
  onDismiss?: () => void;
  isFirstLaunch?: boolean;
}

type TestState = 'idle' | 'testing' | 'ok' | 'error';

export function SettingsView({
  config,
  onSave,
  clerkEnabled = false,
  isSignedIn = false,
  userLabel,
  onSignIn,
  onSignOut,
  getAuthToken,
  requiresAuth = false,
  onDismiss,
  isFirstLaunch = false,
}: Props) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');

  const isDirty = baseUrl !== config.baseUrl;
  const canSave = baseUrl.trim().length > 0;
  const canSubmit = canSave && (isDirty || isFirstLaunch);

  const handleTest = async () => {
    setTestState('testing');
    setTestError('');
    try {
      if (requiresAuth) {
        const token = getAuthToken ? await getAuthToken() : null;
        if (!token) {
          throw new Error('Sign in with Clerk to continue.');
        }
      }
      await checkHealth({ baseUrl: baseUrl.trim(), getAuthToken });
      setTestState('ok');
    } catch (err) {
      setTestState('error');
      setTestError(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleSave = () => {
    if (!canSubmit) return;
    onSave({ baseUrl: baseUrl.trim() });
    if (onDismiss) onDismiss();
  };

  return (
    <div className="settings-panel flex flex-col h-full no-drag" style={{ padding: 20 }}>
      {/* Header */}
      <div className="flex items-center justify-between drag-region" style={{ marginBottom: 16 }}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 600, color: '#f5f5f7' }}>
            {isFirstLaunch ? 'Connect to server' : 'Settings'}
          </p>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
            Orchestrator Platform
          </p>
        </div>
        {!isFirstLaunch && onDismiss && (
          <button
            className="no-drag"
            onClick={onDismiss}
            style={{
              width: 24, height: 24, borderRadius: 12,
              background: 'rgba(255,255,255,0.08)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, color: 'rgba(255,255,255,0.5)',
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* Form */}
      <div className="flex-1 flex flex-col gap-4">
        {clerkEnabled && (
          <div style={{
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.75)',
            padding: '10px 12px',
          }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Account</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {isSignedIn ? `Signed in${userLabel ? ` as ${userLabel}` : ''}` : 'Signed out'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {!isSignedIn && (
                <button
                  className="no-drag"
                  onClick={() => void onSignIn?.()}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    fontSize: 12,
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'rgba(255,255,255,0.8)',
                    cursor: 'pointer',
                  }}
                >
                  Sign in with Clerk
                </button>
              )}
              {isSignedIn && (
                <button
                  className="no-drag"
                  onClick={() => void onSignOut?.()}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    fontSize: 12,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    color: 'rgba(255,255,255,0.65)',
                    cursor: 'pointer',
                  }}
                >
                  Sign out
                </button>
              )}
            </div>
          </div>
        )}

        {requiresAuth && (
          <div style={{
            borderRadius: 10,
            border: '1px solid rgba(245, 158, 11, 0.45)',
            background: 'rgba(245, 158, 11, 0.12)',
            color: '#fcd34d',
            fontSize: 12,
            lineHeight: 1.4,
            padding: '10px 12px',
          }}>
            Sign in with Clerk to call the API. Menubar no longer accepts local API keys.
          </div>
        )}

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>
            Server URL
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setTestState('idle'); }}
            placeholder="http://localhost:8080"
            className="settings-input"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            className="no-drag"
            onClick={() => void handleTest()}
            disabled={!baseUrl.trim() || testState === 'testing'}
            style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12,
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.10)',
              color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
              opacity: !baseUrl.trim() ? 0.4 : 1,
            }}
          >
            {testState === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {testState === 'ok' && <span style={{ fontSize: 12, color: '#30D158' }}>✓ Connected</span>}
          {testState === 'error' && (
            <span style={{ fontSize: 12, color: '#FF453A' }} title={testError}>
              ✗ {testError.length > 20 ? testError.slice(0, 20) + '…' : testError}
            </span>
          )}
        </div>
      </div>

      {/* Save */}
      <button
        className="no-drag"
        onClick={handleSave}
        disabled={!canSubmit}
        style={{
          marginTop: 16, width: '100%', padding: '10px 0',
          borderRadius: 14, border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
          background: canSubmit ? 'linear-gradient(135deg, #22d1ee, #0a84ff)' : 'rgba(255,255,255,0.06)',
          color: canSubmit ? '#fff' : 'rgba(255,255,255,0.2)',
          fontSize: 14, fontWeight: 600,
          boxShadow: canSubmit ? '0 0 20px rgba(34,209,238,0.2)' : 'none',
          transition: 'all 200ms ease',
        }}
      >
        {isFirstLaunch ? 'Get Started' : 'Save'}
      </button>
    </div>
  );
}
