import { describe, expect, test } from 'vitest';
import {
  getAllowedOrchestratorModels,
  getDefaultOrchestratorModel,
  getRuntimeModelConfig,
  resolveOrchestratorModel,
} from '@orchestrator/model-router';

describe('model config', () => {
  test('exposes orchestrator models and default', () => {
    const config = getRuntimeModelConfig();

    expect(config.orchestrator_models.length).toBeGreaterThan(0);
    expect(config.orchestrator_models).toContain(getDefaultOrchestratorModel());
    expect(getAllowedOrchestratorModels()).toEqual(config.orchestrator_models);
  });

  test('validates requested orchestrator model', () => {
    const selected = resolveOrchestratorModel('litellm/gemini-3-flash-preview');
    expect(selected).toBe('litellm/gemini-3-flash-preview');
  });
});
