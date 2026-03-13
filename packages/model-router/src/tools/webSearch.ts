import { searchWeb, type TavilySearchResponse } from './tavily.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  raw_content?: string;
}

export interface WebSearchResponse extends TavilySearchResponse {}

export async function executeWebSearch(query: string): Promise<WebSearchResponse> {
  return searchWeb(query);
}
