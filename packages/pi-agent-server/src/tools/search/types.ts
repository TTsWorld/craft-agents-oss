export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchProvider {
  /** 搜索结果归属里显示的名称（例如 "Google"、"OpenAI"） */
  name: string;
  /** 执行 web 搜索并返回结构化结果。 */
  search(query: string, count: number): Promise<WebSearchResult[]>;
}
