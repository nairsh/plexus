import { fetchUrl, type TavilyFetchResponse } from './tavily.js';

export async function executeFetchUrl(url: string): Promise<TavilyFetchResponse> {
  return fetchUrl(url);
}
