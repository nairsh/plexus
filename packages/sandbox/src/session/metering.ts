import { debitCredits } from '@orchestrator/billing';
import { getEnv, getErrorMessage, logger } from '@orchestrator/shared';
import { terminateSession } from './sessions.js';
import { sessions } from './store.js';

export function startSessionReaper(): NodeJS.Timeout {
  const REAPER_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const MAX_SESSION_AGE = getEnv().SANDBOX_MAX_TIMEOUT * 1000;

  return setInterval(() => {
    const now = Date.now();
    let reaped = 0;

    for (const [sessionId, session] of sessions) {
      if (session.status === 'terminated') continue;
      if (now - session.createdAt > MAX_SESSION_AGE) {
        logger.info({ sessionId, ageMs: now - session.createdAt }, 'Reaping expired sandbox session');
        terminateSession(sessionId);
        reaped++;
      }
    }

    if (reaped > 0) {
      logger.info({ reaped }, 'Session reaper completed');
    }
  }, REAPER_INTERVAL);
}

export function startCreditMeter(): NodeJS.Timeout {
  const METER_INTERVAL = 60_000; // 1 minute

  return setInterval(() => {
    for (const [, session] of sessions) {
      if (session.status === 'terminated') continue;
      try {
        debitCredits(session.userId, 1.0, `Sandbox session ${session.id} (${session.language})`, 'sandbox', session.id);
      } catch (err) {
        logger.warn(
          { sessionId: session.id, error: getErrorMessage(err) },
          'Failed to meter sandbox credits, terminating session'
        );
        terminateSession(session.id);
      }
    }
  }, METER_INTERVAL);
}

export function getActiveSessionCount(): number {
  let count = 0;
  for (const [, session] of sessions) {
    if (session.status !== 'terminated') count++;
  }
  return count;
}
