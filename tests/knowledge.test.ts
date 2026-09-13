import { beforeEach, describe, expect, test, vi } from 'vitest';
import { chunkKnowledgeText, inferKnowledgeExtractionMode } from '@orchestrator/model-router';

describe('knowledge helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('infers extraction mode from file type', () => {
    expect(inferKnowledgeExtractionMode('notes.md', 'text/markdown')).toBe('text');
    expect(inferKnowledgeExtractionMode('scan.png', 'image/png')).toBe('ocr');
    expect(inferKnowledgeExtractionMode('spec.pdf', 'application/pdf')).toBe('document');
  });

  test('chunks long text into overlapping segments', () => {
    const text = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${index} with enough text to force chunking.`
    ).join('\n\n');
    const chunks = chunkKnowledgeText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.length).toBeGreaterThan(100);
    expect(chunks.every((chunk) => chunk.length <= 1400)).toBe(true);
  });
});
