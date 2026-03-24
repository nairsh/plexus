import { TextDecoder } from 'node:util';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PDFParse } from 'pdf-parse';
import { getDb, getEnv, getErrorMessage, InvalidRequestError, logger } from '@orchestrator/shared';
import type { KnowledgeChunk, KnowledgeDocument } from '@orchestrator/shared';

export interface KnowledgeUploadInput {
  filename: string;
  mediaType: string;
  contentBase64: string;
}

export interface KnowledgeSearchMatch {
  document_id: string;
  filename: string;
  chunk_id: string;
  chunk_index: number;
  content: string;
  score: number;
  extraction_mode: KnowledgeDocument['extraction_mode'];
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
]);

const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'mdx',
  'json',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
  'csv',
  'sql',
  'sh',
  'log',
]);

const CHUNK_SIZE = 1400;
const CHUNK_OVERLAP = 180;

const isTextLike = (filename: string, mediaType: string): boolean => {
  if (mediaType.startsWith('text/')) return true;
  if (TEXT_MEDIA_TYPES.has(mediaType)) return true;
  const ext = filename.split('.').pop()?.toLowerCase();
  return Boolean(ext && TEXT_FILE_EXTENSIONS.has(ext));
};

export const inferKnowledgeExtractionMode = (
  filename: string,
  mediaType: string
): KnowledgeDocument['extraction_mode'] => {
  if (mediaType === 'application/pdf') return 'document';
  if (mediaType.startsWith('image/')) return 'ocr';
  if (isTextLike(filename, mediaType)) return 'text';
  return 'document';
};

const sanitizeExtractedText = (value: string): string =>
  value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export const chunkKnowledgeText = (text: string): string[] => {
  const cleaned = sanitizeExtractedText(text);
  if (!cleaned) return [];
  if (cleaned.length <= CHUNK_SIZE) return [cleaned];

  const chunks: string[] = [];
  let index = 0;
  while (index < cleaned.length) {
    const targetEnd = Math.min(index + CHUNK_SIZE, cleaned.length);
    let end = targetEnd;
    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf('\n\n', targetEnd);
      const sentenceBreak = cleaned.lastIndexOf('. ', targetEnd);
      const preferred = Math.max(paragraphBreak, sentenceBreak);
      if (preferred > index + Math.floor(CHUNK_SIZE * 0.55)) {
        end = preferred + (preferred === paragraphBreak ? 2 : 1);
      }
    }

    const chunk = cleaned.slice(index, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= cleaned.length) break;
    index = Math.max(end - CHUNK_OVERLAP, index + 1);
  }
  return chunks;
};

export const extractKnowledgeTextFromBuffer = (filename: string, mediaType: string, buffer: Buffer): string => {
  if (!isTextLike(filename, mediaType)) {
    throw new InvalidRequestError(`Direct text extraction is not supported for ${mediaType}`, 'media_type');
  }
  return sanitizeExtractedText(textDecoder.decode(buffer));
};

const extractPdfText = async (buffer: Buffer): Promise<string> => {
  const parser = new PDFParse({ data: buffer as unknown as Uint8Array });
  const result = await parser.getText();
  return sanitizeExtractedText(result.text ?? '');
};

const hasGoogleAI = (): boolean => Boolean(getEnv().GOOGLE_AI_API_KEY);

const requireGoogleClient = (): GoogleGenerativeAI => {
  const apiKey = getEnv().GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new InvalidRequestError('Google AI API key is required for knowledge ingestion', 'GOOGLE_AI_API_KEY');
  }
  return new GoogleGenerativeAI(apiKey);
};

const extractWithGemini = async (mediaType: string, contentBase64: string): Promise<string> => {
  const client = requireGoogleClient();
  const model = client.getGenerativeModel({ model: getEnv().GOOGLE_OCR_MODEL });
  const result = await (model as any).generateContent([
    {
      text:
        'Extract all readable text from this file. Preserve section breaks, bullet lists, and table-like structure with plain text only. Return only the extracted text.',
    },
    {
      inlineData: {
        data: contentBase64,
        mimeType: mediaType,
      },
    },
  ]);

  return sanitizeExtractedText(result?.response?.text?.() ?? '');
};

const embedChunk = async (text: string): Promise<number[]> => {
  const client = requireGoogleClient();
  const model = client.getGenerativeModel({ model: getEnv().GOOGLE_EMBEDDING_MODEL });
  const result = await (model as any).embedContent(text);
  const values = result?.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error('Embedding response did not include numeric values');
  }
  return values.filter((value: unknown): value is number => typeof value === 'number');
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const parseDocumentRow = (row: Record<string, unknown>): KnowledgeDocument => ({
  id: String(row['id']),
  user_id: String(row['user_id']),
  filename: String(row['filename']),
  media_type: String(row['media_type']),
  source_type: 'upload',
  status: String(row['status']) as KnowledgeDocument['status'],
  extraction_mode: String(row['extraction_mode']) as KnowledgeDocument['extraction_mode'],
  byte_size: Number(row['byte_size'] ?? 0),
  chunk_count: Number(row['chunk_count'] ?? 0),
  summary: typeof row['summary'] === 'string' ? row['summary'] : null,
  metadata: (() => {
    try {
      const parsed = JSON.parse(String(row['metadata'] ?? '{}')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })(),
  error: typeof row['error'] === 'string' ? row['error'] : null,
  created_at: String(row['created_at']),
  updated_at: String(row['updated_at']),
});

const parseChunkRow = (row: Record<string, unknown>): KnowledgeChunk => ({
  id: String(row['id']),
  document_id: String(row['document_id']),
  user_id: String(row['user_id']),
  chunk_index: Number(row['chunk_index'] ?? 0),
  content: String(row['content'] ?? ''),
  embedding_model: String(row['embedding_model'] ?? getEnv().GOOGLE_EMBEDDING_MODEL),
  embedding: (() => {
    try {
      const parsed = JSON.parse(String(row['embedding'] ?? '[]')) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : [];
    } catch {
      return [];
    }
  })(),
  metadata: (() => {
    try {
      const parsed = JSON.parse(String(row['metadata'] ?? '{}')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })(),
  created_at: String(row['created_at']),
});

const readDocument = (userId: string, documentId: string): KnowledgeDocument | null => {
  const row = getDb()
    .prepare('SELECT * FROM knowledge_documents WHERE id = ? AND user_id = ?')
    .get(documentId, userId) as Record<string, unknown> | undefined;
  return row ? parseDocumentRow(row) : null;
};

export const ingestKnowledgeDocument = async (
  userId: string,
  input: KnowledgeUploadInput
): Promise<KnowledgeDocument> => {
  const filename = input.filename.trim();
  const mediaType = input.mediaType.trim() || 'application/octet-stream';
  if (!filename) {
    throw new InvalidRequestError('filename is required', 'filename');
  }
  if (!input.contentBase64.trim()) {
    throw new InvalidRequestError('content_base64 is required', 'content_base64');
  }

  const db = getDb();
  const documentId = crypto.randomUUID();
  const buffer = Buffer.from(input.contentBase64, 'base64');
  const extractionMode = inferKnowledgeExtractionMode(filename, mediaType);

  db.prepare(
    `INSERT INTO knowledge_documents (
      id, user_id, filename, media_type, source_type, status, extraction_mode, byte_size, chunk_count, metadata
    ) VALUES (?, ?, ?, ?, 'upload', 'processing', ?, ?, 0, '{}')`
  ).run(documentId, userId, filename, mediaType, extractionMode, buffer.byteLength);

  try {
    let extractedText: string;
    if (extractionMode === 'text') {
      extractedText = extractKnowledgeTextFromBuffer(filename, mediaType, buffer);
    } else if (mediaType === 'application/pdf' && !hasGoogleAI()) {
      extractedText = await extractPdfText(buffer);
    } else if (hasGoogleAI()) {
      extractedText = await extractWithGemini(mediaType, input.contentBase64);
    } else {
      throw new InvalidRequestError('Google AI API key is required to ingest image files', 'GOOGLE_AI_API_KEY');
    }

    if (!extractedText) {
      throw new InvalidRequestError('No text could be extracted from this file', 'content_base64');
    }

    const chunks = chunkKnowledgeText(extractedText).slice(0, 128);
    if (chunks.length === 0) {
      throw new InvalidRequestError('No text could be extracted from this file', 'content_base64');
    }

    const embeddings = hasGoogleAI()
      ? await Promise.all(chunks.map((chunk) => embedChunk(chunk)))
      : chunks.map(() => [] as number[]);
    const summary = extractedText.slice(0, 280);
    const metadata = JSON.stringify({
      original_filename: filename,
      media_type: mediaType,
      extracted_characters: extractedText.length,
    });

    const insertChunk = db.prepare(
      `INSERT INTO knowledge_chunks (
        id, document_id, user_id, chunk_index, content, embedding_model, embedding, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    db.transaction(() => {
      for (let index = 0; index < chunks.length; index += 1) {
        insertChunk.run(
          crypto.randomUUID(),
          documentId,
          userId,
          index,
          chunks[index],
          getEnv().GOOGLE_EMBEDDING_MODEL,
          JSON.stringify(embeddings[index]),
          JSON.stringify({ length: chunks[index]?.length ?? 0 })
        );
      }

      db.prepare(
        `UPDATE knowledge_documents
         SET status = 'ready', chunk_count = ?, summary = ?, metadata = ?, error = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      ).run(chunks.length, summary, metadata, documentId, userId);
    })();

    const document = readDocument(userId, documentId);
    if (!document) {
      throw new Error('Document not found after ingestion');
    }
    return document;
  } catch (error) {
    db.prepare(
      `UPDATE knowledge_documents
       SET status = 'failed', error = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    ).run(getErrorMessage(error), documentId, userId);
    logger.warn({ documentId, filename, error: getErrorMessage(error) }, 'Knowledge ingestion failed');
    throw error;
  }
};

export const listKnowledgeDocumentsForUser = (userId: string): KnowledgeDocument[] => {
  const rows = getDb()
    .prepare('SELECT * FROM knowledge_documents WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(parseDocumentRow);
};

export const getKnowledgeDocumentForUser = (
  userId: string,
  documentId: string
): { document: KnowledgeDocument; chunks: KnowledgeChunk[]; content: string } | null => {
  const document = readDocument(userId, documentId);
  if (!document) return null;
  const chunkRows = getDb()
    .prepare('SELECT * FROM knowledge_chunks WHERE user_id = ? AND document_id = ? ORDER BY chunk_index ASC')
    .all(userId, documentId) as Array<Record<string, unknown>>;
  const chunks = chunkRows.map(parseChunkRow);
  return {
    document,
    chunks,
    content: chunks.map((chunk) => chunk.content).join('\n\n'),
  };
};

export const deleteKnowledgeDocumentForUser = (userId: string, documentId: string): boolean => {
  const result = getDb().prepare('DELETE FROM knowledge_documents WHERE id = ? AND user_id = ?').run(documentId, userId);
  return result.changes > 0;
};

const keywordSearchKnowledge = (
  userId: string,
  query: string,
  limit: number
): KnowledgeSearchMatch[] => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 2)
    .slice(0, 8);

  if (words.length === 0) {
    return [];
  }

  const conditions = words.map(() => 'LOWER(kc.content) LIKE ?').join(' OR ');
  const params = words.map((w) => `%${w}%`);

  const rows = getDb()
    .prepare(
      `SELECT kc.*, kd.filename, kd.extraction_mode
       FROM knowledge_chunks kc
       INNER JOIN knowledge_documents kd ON kd.id = kc.document_id
       WHERE kc.user_id = ? AND (${conditions})
       ORDER BY kd.updated_at DESC
       LIMIT ?`
    )
    .all(userId, ...params, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const chunk = parseChunkRow(row);
    // Simple BM25-like score: count how many query words appear in the chunk
    const content = chunk.content.toLowerCase();
    const matchCount = words.filter((w) => content.includes(w)).length;
    return {
      document_id: chunk.document_id,
      filename: String(row['filename'] ?? 'Document'),
      chunk_id: chunk.id,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      score: matchCount / words.length,
      extraction_mode: String(row['extraction_mode'] ?? 'text') as KnowledgeDocument['extraction_mode'],
    };
  });
};

export const searchKnowledgeForUser = async (
  userId: string,
  query: string,
  limit = 6
): Promise<KnowledgeSearchMatch[]> => {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    throw new InvalidRequestError('query is required', 'query');
  }

  if (!hasGoogleAI()) {
    return keywordSearchKnowledge(userId, normalizedQuery, limit);
  }

  const queryEmbedding = await embedChunk(normalizedQuery);
  const rows = getDb()
    .prepare(
      `SELECT kc.*, kd.filename, kd.extraction_mode
       FROM knowledge_chunks kc
       INNER JOIN knowledge_documents kd ON kd.id = kc.document_id
       WHERE kc.user_id = ?
       ORDER BY kd.updated_at DESC`
    )
    .all(userId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => {
      const chunk = parseChunkRow(row);
      return {
        document_id: chunk.document_id,
        filename: String(row['filename'] ?? 'Document'),
        chunk_id: chunk.id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
        extraction_mode: String(row['extraction_mode'] ?? 'text') as KnowledgeDocument['extraction_mode'],
      };
    })
    .filter((match) => Number.isFinite(match.score) && match.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
};
