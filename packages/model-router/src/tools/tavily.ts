import { ModelError, logger } from '@orchestrator/shared';

const TAVILY_BASE_URL = process.env['TAVILY_BASE_URL'] || 'https://api.tavily.com';
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

const getTavilyApiKey = () => process.env['TAVILY_API_KEY'];

const hasBrave = () => {
  const key = process.env['BRAVE_SEARCH_API_KEY'];
  return Boolean(key && key !== '...');
};

const getBraveSearchApiKey = () => process.env['BRAVE_SEARCH_API_KEY'];

const ensureConfigured = () => {
  const key = getTavilyApiKey();
  if (!key || key === '...') {
    throw new ModelError('Tavily API key is not configured', 'tavily_not_configured');
  }
};

const hasTavily = () => {
  const key = getTavilyApiKey();
  return Boolean(key && key !== '...');
};

const stripHtml = (content: string): string =>
  content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const postTavily = async <T>(path: string, payload: Record<string, unknown>): Promise<T> => {
  ensureConfigured();
  await waitForRateLimit();

  const apiKey = getTavilyApiKey();
  const response = await fetch(`${TAVILY_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
  provider: 'tavily' | 'brave' | 'duckduckgo';
  query: string;
  answer?: string;
  results: TavilySearchResult[];
}

export interface TavilyFetchResponse {
  provider: 'tavily' | 'direct';
  url: string;
  title?: string;
  content: string;
  raw_content?: string;
  images?: string[];
}

const searchWebWithBrave = async (query: string): Promise<TavilySearchResponse> => {
  if (!hasBrave()) {
    throw new ModelError('No web search provider is configured', 'search_not_configured');
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': getBraveSearchApiKey()!,
      },
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error({ status: response.status, errorBody }, 'Brave search request failed');
    throw new ModelError(`Brave search failed with ${response.status}: ${response.statusText}`, 'brave_search_failed');
  }

  const data = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  return {
    provider: 'brave',
    query,
    results: (data.web?.results ?? []).map((result) => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.description ?? '',
    })),
  };
};

const fetchUrlDirect = async (url: string): Promise<TavilyFetchResponse> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'orchestrator-platform/0.1',
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new ModelError(`Direct fetch failed with ${response.status}: ${response.statusText}`, 'direct_fetch_failed');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const content = contentType.includes('text/html') ? stripHtml(raw) : raw.trim();

  if (!content) {
    throw new ModelError(`Direct fetch returned no content for URL: ${url}`, 'direct_fetch_empty');
  }

  return {
    provider: 'direct',
    url: response.url,
    title: titleMatch?.[1]?.trim(),
    content,
    raw_content: raw,
  };
};

const searchWebWithPublicFallback = async (query: string): Promise<TavilySearchResponse> => {
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'orchestrator-platform/0.1',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new ModelError(
      `Public search fallback failed with ${response.status}: ${response.statusText}`,
      'public_search_failed'
    );
  }

  const html = await response.text();
  const matches = [
    ...html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    ),
  ]
    .slice(0, 10)
    .map((match) => ({
      title: stripHtml(match[2] ?? ''),
      url: match[1] ?? '',
      snippet: stripHtml(match[3] ?? ''),
    }))
    .filter((result) => result.title && result.url);

  if (matches.length === 0) {
    throw new ModelError('Public search fallback returned no results', 'public_search_empty');
  }

  return {
    provider: 'duckduckgo',
    query,
    results: matches,
  };
};

export interface SearchWebOptions {
  searchDepth?: 'basic' | 'advanced';
}

export const searchWeb = async (query: string, options: SearchWebOptions = {}): Promise<TavilySearchResponse> => {
  if (!hasTavily()) {
    return searchWebWithPublicFallback(query);
  }

  try {
    const data = await postTavily<{
      query: string;
      answer?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
      }>;
    }>('/search', {
      query,
      search_depth: options.searchDepth ?? 'basic',
      max_results: 10,
      include_answer: true,
      include_raw_content: false,
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
      })),
    };
  } catch (error) {
    logger.warn({ query, error }, 'Tavily search failed, falling back to public search');
    return searchWebWithPublicFallback(query);
  }
};

export const fetchUrl = async (url: string): Promise<TavilyFetchResponse> => {
  if (!hasTavily()) {
    return fetchUrlDirect(url);
  }

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
    throw new ModelError(
      `Could not extract content from ${url}. The site may block crawlers, require authentication, or have no extractable content. Try a different URL or check if the page is publicly accessible.`,
      'fetch_url_empty'
    );
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
