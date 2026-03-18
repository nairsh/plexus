import { describe, expect, test } from 'vitest';
import {
  BUILTIN_TOOL_NAMES,
  CANONICAL_TOOL_DEFS,
  buildAnthropicTools,
  buildGoogleTools,
  buildOpenAITools,
} from '../packages/model-router/src/tools/defs.js';

describe('CANONICAL_TOOL_DEFS', () => {
  test('contains all builtin tool names', () => {
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(CANONICAL_TOOL_DEFS.has(name)).toBe(true);
    }
  });

  test('each definition has required fields', () => {
    for (const [name, def] of CANONICAL_TOOL_DEFS) {
      expect(def.name).toBe(name);
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.parameters).toBe('object');
      expect(typeof def.cost).toBe('number');
      expect(def.cost).toBeGreaterThanOrEqual(0);
    }
  });

  test('all parameter objects have type and properties', () => {
    for (const [, def] of CANONICAL_TOOL_DEFS) {
      expect(def.parameters['type']).toBe('object');
      expect(typeof def.parameters['properties']).toBe('object');
    }
  });
});

describe('buildOpenAITools', () => {
  test('returns undefined for empty tool list', () => {
    expect(buildOpenAITools([])).toBeUndefined();
    expect(buildOpenAITools(undefined)).toBeUndefined();
  });

  test('converts builtin tool to OpenAI format', () => {
    const tools = buildOpenAITools([{ type: 'web_search' }]);
    expect(tools).toHaveLength(1);
    expect(tools![0].type).toBe('function');
    expect(tools![0].function.name).toBe('web_search');
    expect(typeof tools![0].function.description).toBe('string');
  });

  test('converts function tool passthrough', () => {
    const tools = buildOpenAITools([
      {
        type: 'function',
        function: { name: 'my_fn', description: 'does stuff', parameters: { type: 'object', properties: {} } },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools![0].function.name).toBe('my_fn');
  });

  test('skips unknown builtin gracefully', () => {
    // A type not in CANONICAL_TOOL_DEFS should be skipped
    const tools = buildOpenAITools([{ type: 'web_search' }, { type: 'web_search' }]);
    expect(tools).toHaveLength(2);
  });
});

describe('buildAnthropicTools', () => {
  test('returns undefined for empty tool list', () => {
    expect(buildAnthropicTools([])).toBeUndefined();
  });

  test('converts builtin tool to Anthropic format', () => {
    const tools = buildAnthropicTools([{ type: 'bash' }]);
    expect(tools).toHaveLength(1);
    expect(tools![0].name).toBe('bash');
    expect(tools![0].input_schema.type).toBe('object');
  });
});

describe('buildGoogleTools', () => {
  test('returns undefined for empty tool list', () => {
    expect(buildGoogleTools([])).toBeUndefined();
  });

  test('wraps declarations in a single Tool object', () => {
    const tools = buildGoogleTools([{ type: 'web_search' }, { type: 'fetch_url' }]);
    expect(tools).toHaveLength(1);
    expect(tools![0].functionDeclarations).toHaveLength(2);
    expect(tools![0].functionDeclarations![0].name).toBe('web_search');
  });
});
