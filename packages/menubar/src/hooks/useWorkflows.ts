import { useState, useEffect, useRef, useCallback } from 'react';
import { listWorkflows } from '../api/client.js';
import type { ApiConfig } from '../api/client.js';
import type { Workflow } from '../api/types.js';

const POLL_INTERVAL_ACTIVE = 3_000;
const POLL_INTERVAL_IDLE = 10_000;

export function useWorkflows(config: ApiConfig, enabled: boolean) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const poll = useCallback(async () => {
    if (!mountedRef.current || !enabled) return;

    try {
      const { workflows: list } = await listWorkflows(config);
      if (!mountedRef.current) return;

      // Sort: executing first, then by created_at desc
      const sorted = [...list].sort((a, b) => {
        if (a.status === 'executing' && b.status !== 'executing') return -1;
        if (b.status === 'executing' && a.status !== 'executing') return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setWorkflows(sorted);
      setError(null);

      // Adaptive polling: faster when workflows are running
      const hasActive = sorted.some((w) => w.status === 'executing' || w.status === 'planning');
      const delay = hasActive ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;
      timerRef.current = setTimeout(poll, delay);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch workflows');
      timerRef.current = setTimeout(poll, POLL_INTERVAL_IDLE);
    }
  }, [config, enabled]);

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      void poll();
    }

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll, enabled]);

  const refresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void poll();
  }, [poll]);

  return { workflows, error, refresh };
}
