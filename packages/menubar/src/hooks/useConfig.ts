import { useState, useEffect, useCallback } from 'react';
import { load } from '@tauri-apps/plugin-store';

export interface AppConfig {
  baseUrl: string;
}

const STORE_FILE = 'config.json';
const KEY_BASE_URL = 'baseUrl';
const DEFAULT_CONFIG: AppConfig = {
  baseUrl: 'http://localhost:8080',
};

const STORE_DEFAULTS = {
  [KEY_BASE_URL]: DEFAULT_CONFIG.baseUrl,
} satisfies Record<string, unknown>;

export function useConfig() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const store = await load(STORE_FILE, { autoSave: true, defaults: STORE_DEFAULTS });
        const baseUrl = await store.get<string>(KEY_BASE_URL);

        if (!cancelled) {
          setConfig({
            baseUrl: baseUrl ?? DEFAULT_CONFIG.baseUrl,
          });
          setIsLoaded(true);
        }
      } catch {
        if (!cancelled) setIsLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const saveConfig = useCallback(async (next: AppConfig) => {
    setConfig(next);
    try {
      const store = await load(STORE_FILE, { autoSave: true, defaults: STORE_DEFAULTS });
      await store.set(KEY_BASE_URL, next.baseUrl);
      await store.save();
    } catch {
      // Config save failure is non-fatal; state is still updated in memory
    }
  }, []);

  const isConfigured = config.baseUrl.trim().length > 0;

  return { config, saveConfig, isLoaded, isConfigured };
}
