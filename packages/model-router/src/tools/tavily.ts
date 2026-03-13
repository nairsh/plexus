import { ModelError, logger } from '@orchestrator/shared';

const TAVILY_BASE_URL = process.env['TAVILY_BASE_URL'] || 'https://api.tavily.com';
const TAVILY_API_KEY = process.env['TAVILY_API_KEY'];
const RATE_LIMIT_MS = parseInt(process.env['TAVILY_RATE_LIMIT_MS'] || '300', 10);

let nextAvailableAt = 0;

const waitForRateLimit = async () => {
  const now = Date.now();
  const delay = Math.max(0, nextAvailableAt - now);

  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  nextAvailableAt = Date.now() + RATE_LIMIT_MS;
};

const ensureConfigured = () => {
  if (!TAVILY_API_KEY || TAVILY_API_KEY === '...') {
    throw new ModelError('Tavily API key is not configured', 'tavily_not_configured');
  }
};

const postTavily = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
  ensureConfigured();
  await waitForRateLimit();

  const response = await fetch(`${TAVILY_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error({ path, status: response.status, errorBody }, 'Tavily request failed');
    throw new ModelError(
      `Tavily request failed with ${response.status}: ${response.statusText}`,
      'tavily_request_failed'
    );
  }

  return (await response.json()) as T;
};

export interface TavilySearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  raw_content?: string;
}

export interface TavilySearchResponse {
  provider: 'tavily';
  query: string;
  answer?: string;
  results: TavilySearchResult[];
}

export interface TavilyFetchResponse {
  provider: 'tavily';
  url: string;
  title?: string;
  content: string;
  raw_content?: string;
  images?: string[];
}

export const searchWeb = async (query: string): Promise<TavilySearchResponse> => {
  const data = await postTavily<{
    query: string;
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
      raw_content?: string;
    }>;
  }>('/search', {
    query,
    search_depth: 'advanced',
    max_results: 5,
    include_answer: true,
    include_raw_content: 'markdown',
  });

  return {
    provider: 'tavily',
    query: data.query,
    answer: data.answer,
    results: (data.results ?? []).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.content ?? '',
      score: result.score,
      raw_content: result.raw_content,
    })),
  };
};

export const fetchUrl = async (url: string): Promise<TavilyFetchResponse> => {
  const data = await postTavily<{
    results?: Array<{
      url?: string;
      title?: string;
      raw_content?: string;
      content?: string;
      images?: string[];
    }>;
  }>('/extract', {
    urls: url,
    extract_depth: 'advanced',
    include_images: false,
  });

  const result = data.results?.[0];

  if (!result) {
    throw new ModelError(`Tavily returned no content for URL: ${url}`, 'tavily_empty_extract');
  }

  return {
    provider: 'tavily',
    url: result.url ?? url,
    title: result.title,
    content: result.raw_content ?? result.content ?? '',
    raw_content: result.raw_content,
    images: result.images,
  };
};
