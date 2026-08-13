import { Buffer } from 'node:buffer';
import { validateToolCall } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createWebTools,
  MAX_WEB_FETCH_CONTENT_CHARS,
  MAX_WEB_SEARCH_CONTENT_CHARS,
  MAX_WEB_SEARCH_TITLE_CHARS,
  MAX_WEB_SEARCH_URL_CHARS,
} from './web';

function findTool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function textOf(result: {
  content: { type: string; text?: string }[];
}): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function jsonOf<T>(result: { content: { type: string; text?: string }[] }): T {
  return JSON.parse(textOf(result)) as T;
}

function searchResponse(
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    [key: string]: unknown;
  }> = [],
) {
  return {
    query: 'provider-normalized query',
    answer: 'not exposed',
    images: [{ url: 'https://example.com/image.png' }],
    results,
    response_time: '0.5',
    usage: { credits: 1 },
    request_id: 'request-id',
  };
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('fetch was not called');
  const init = call[1];
  if (!init) throw new Error('fetch init was not provided');
  return {
    url: call[0],
    init,
    headers: new Headers(init.headers),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

describe('web tool schemas', () => {
  const tools = createWebTools({ fetchImpl: vi.fn<typeof fetch>() });

  const validate = (name: string, arguments_: Record<string, unknown>) =>
    validateToolCall(tools, {
      type: 'toolCall',
      id: 'call-id',
      name,
      arguments: arguments_,
    });

  it('accepts the curated search and fetch parameters', () => {
    expect(
      validate('web_search', {
        query: 'latest battery research',
        max_results: 10,
        search_depth: 'advanced',
        topic: 'news',
        time_range: 'week',
        include_domains: ['example.com'],
        exclude_domains: ['spam.example'],
      }),
    ).toEqual({
      query: 'latest battery research',
      max_results: 10,
      search_depth: 'advanced',
      topic: 'news',
      time_range: 'week',
      include_domains: ['example.com'],
      exclude_domains: ['spam.example'],
    });
    expect(
      validate('web_fetch', {
        url: 'https://example.com/article',
        query: 'battery lifetime',
        extract_depth: 'advanced',
      }),
    ).toEqual({
      url: 'https://example.com/article',
      query: 'battery lifetime',
      extract_depth: 'advanced',
    });
  });

  it.each([
    { query: '' },
    { query: ' '.repeat(3) },
    { query: 'x'.repeat(2_001) },
    { query: 'x', max_results: 0 },
    { query: 'x', max_results: 11 },
    { query: 'x', search_depth: 'fast' },
    { query: 'x', topic: 'sports' },
    { query: 'x', time_range: 'd' },
    { query: 'x', include_domains: Array.from({ length: 11 }, () => 'x.com') },
    { query: 'x', exclude_domains: [''] },
  ])('rejects invalid web_search arguments %#', (arguments_) => {
    expect(() => validate('web_search', arguments_)).toThrow(
      /Validation failed for tool "web_search"/,
    );
  });

  it.each([
    { url: '' },
    { url: 'x'.repeat(4_097) },
    { url: 'https://example.com', query: '' },
    { url: 'https://example.com', query: ' '.repeat(3) },
    { url: 'https://example.com', query: 'x'.repeat(1_001) },
    { url: 'https://example.com', extract_depth: 'deep' },
  ])('rejects invalid web_fetch arguments %#', (arguments_) => {
    expect(() => validate('web_fetch', arguments_)).toThrow(
      /Validation failed for tool "web_fetch"/,
    );
  });
});

describe('web_search', () => {
  it.each([undefined, null, '', '   '])(
    'uses only keyless authentication for API key %j',
    async (tavilyApiKey) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json(searchResponse()),
      );
      const search = findTool(
        createWebTools({ tavilyApiKey, fetchImpl: fetchMock }),
        'web_search',
      );

      await search.execute('search', { query: 'query' });

      const { headers } = fetchCall(fetchMock);
      expect(headers.get('x-tavily-access-mode')).toBe('keyless');
      expect(headers.has('authorization')).toBe(false);
    },
  );

  it('sends the curated Tavily request and returns only stable result fields', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        searchResponse([
          {
            title: 'Battery paper',
            url: 'https://example.com/paper',
            content: 'Relevant source excerpt containing tvly-secret.',
            score: 0.95,
            raw_content: 'not exposed',
            favicon: 'https://example.com/favicon.ico',
          },
        ]),
      ),
    );
    const search = findTool(
      createWebTools({
        tavilyApiKey: '  tvly-secret  ',
        fetchImpl: fetchMock,
      }),
      'web_search',
    );

    const result = await search.execute(
      'search',
      {
        query: '  battery research  ',
        max_results: 7,
        search_depth: 'advanced',
        topic: 'finance',
        time_range: 'month',
        include_domains: [' example.com '],
        exclude_domains: [' spam.example '],
      },
      signal,
    );

    const request = fetchCall(fetchMock);
    expect(request.url).toBe('https://api.tavily.com/search');
    expect(request.init).toMatchObject({ method: 'POST', signal });
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('authorization')).toBe('Bearer tvly-secret');
    expect(request.headers.has('x-tavily-access-mode')).toBe(false);
    expect(request.body).toEqual({
      query: 'battery research',
      max_results: 7,
      search_depth: 'advanced',
      chunks_per_source: 3,
      topic: 'finance',
      time_range: 'month',
      include_domains: ['example.com'],
      exclude_domains: ['spam.example'],
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      auto_parameters: false,
      include_usage: false,
    });
    expect(jsonOf(result)).toEqual({
      query: 'battery research',
      results: [
        {
          title: 'Battery paper',
          url: 'https://example.com/paper',
          content: 'Relevant source excerpt containing [redacted].',
          score: 0.95,
        },
      ],
    });
    expect(result.details).toEqual({});
    expect(textOf(result)).not.toContain('tvly-secret');
    expect(textOf(result)).not.toContain('not exposed');
  });

  it('applies stable defaults and preserves every returned result', async () => {
    const results = Array.from({ length: 6 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      content: `Content ${index}`,
      score: 1 - index / 10,
    }));
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(searchResponse(results)),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    const result = await search.execute('search', { query: 'defaults' });

    expect(fetchCall(fetchMock).body).toMatchObject({
      query: 'defaults',
      max_results: 5,
      search_depth: 'basic',
      topic: 'general',
    });
    const output = jsonOf<{ results: { title: string }[] }>(result);
    expect(output.results.map(({ title }) => title)).toEqual(
      results.map(({ title }) => title),
    );
  });

  it('limits each snippet to 2000 complete Unicode characters', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        searchResponse([
          {
            title: 'Unicode',
            url: 'https://example.com/unicode',
            content: '🙂'.repeat(2_001),
            score: 1,
          },
        ]),
      ),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    const output = jsonOf<{
      results: { content: string; content_truncated?: true }[];
    }>(await search.execute('search', { query: 'unicode' }));

    expect([...output.results[0]!.content]).toHaveLength(
      MAX_WEB_SEARCH_CONTENT_CHARS,
    );
    expect(output.results[0]!.content).not.toContain('\uFFFD');
    expect(output.results[0]!.content_truncated).toBe(true);
  });

  it('limits every snippet independently without removing results', async () => {
    const content = '🙂"\\'.repeat(1_000);
    const results = Array.from({ length: 10 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      content,
      score: 1 - index / 100,
    }));
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(searchResponse(results)),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    const result = await search.execute('search', {
      query: 'large',
      max_results: 10,
    });
    const output = jsonOf<{
      results: { content: string; content_truncated?: true }[];
    }>(result);

    expect(output.results).toHaveLength(10);
    expect(
      output.results.every(
        (item) => [...item.content].length === MAX_WEB_SEARCH_CONTENT_CHARS,
      ),
    ).toBe(true);
    expect(output.results.every((item) => item.content_truncated)).toBe(true);
    expect(
      output.results.every((item) => !item.content.includes('\uFFFD')),
    ).toBe(true);
  });

  it('limits title and URL fields without changing result order', async () => {
    const oversizedTitle = `${'t'.repeat(MAX_WEB_SEARCH_TITLE_CHARS - 1)}🙂tail`;
    const oversizedUrl = `${'u'.repeat(MAX_WEB_SEARCH_URL_CHARS - 1)}🙂tail`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        searchResponse([
          {
            title: oversizedTitle,
            url: 'https://example.com/first',
            content: 'First content',
            score: 1,
          },
          {
            title: 'Middle result',
            url: oversizedUrl,
            content: 'Middle content',
            score: 0.5,
          },
          {
            title: 'Final result',
            url: 'https://example.com/final',
            content: 'Final content',
            score: 0,
          },
        ]),
      ),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    const result = await search.execute('search', {
      query: 'metadata',
      max_results: 3,
    });
    const output = jsonOf<{
      results: Array<{
        title: string;
        url: string;
        content: string;
        score: number;
        title_truncated?: true;
        url_truncated?: true;
      }>;
    }>(result);

    expect(output.results.map(({ score }) => score)).toEqual([1, 0.5, 0]);
    expect([...output.results[0]!.title]).toHaveLength(
      MAX_WEB_SEARCH_TITLE_CHARS,
    );
    expect(output.results[0]).toMatchObject({
      title_truncated: true,
      url: 'https://example.com/first',
      content: 'First content',
    });
    expect(output.results[0]!.title.endsWith('🙂')).toBe(true);
    expect(output.results[0]).not.toHaveProperty('url_truncated');
    expect([...output.results[1]!.url]).toHaveLength(MAX_WEB_SEARCH_URL_CHARS);
    expect(output.results[1]).toMatchObject({
      title: 'Middle result',
      url_truncated: true,
      content: 'Middle content',
    });
    expect(output.results[1]!.url.endsWith('🙂')).toBe(true);
    expect(output.results[1]).not.toHaveProperty('title_truncated');
    expect(output.results[2]).toEqual({
      title: 'Final result',
      url: 'https://example.com/final',
      content: 'Final content',
      score: 0,
    });
    expect(
      output.results.every(
        ({ title, url }) =>
          !title.includes('\uFFFD') && !url.includes('\uFFFD'),
      ),
    ).toBe(true);
  });
});

describe('web_fetch', () => {
  it('sends a single-URL Markdown extraction request without optional chunks', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          {
            url: 'https://redirected.example/article',
            raw_content: '# Article\n\nReadable content.',
            images: ['https://example.com/image.png'],
          },
        ],
        failed_results: [],
        response_time: 0.1,
      }),
    );
    const fetchTool = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_fetch',
    );

    const result = await fetchTool.execute('fetch', {
      url: 'https://example.com/article',
    });

    const request = fetchCall(fetchMock);
    expect(request.url).toBe('https://api.tavily.com/extract');
    expect(request.body).toEqual({
      urls: ['https://example.com/article'],
      extract_depth: 'basic',
      include_images: false,
      include_favicon: false,
      format: 'markdown',
      include_usage: false,
    });
    expect(jsonOf(result)).toEqual({
      url: 'https://example.com/article',
      content: '# Article\n\nReadable content.',
      content_truncated: false,
    });
    expect(result.details).toEqual({});
  });

  it('adds reranking chunks, depth, keyed auth, and the cancellation signal', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          {
            url: 'https://example.com/article',
            raw_content: 'Relevant chunk containing tvly-key',
          },
        ],
        failed_results: [],
      }),
    );
    const fetchTool = findTool(
      createWebTools({
        tavilyApiKey: 'tvly-key',
        fetchImpl: fetchMock,
      }),
      'web_fetch',
    );

    const result = await fetchTool.execute(
      'fetch',
      {
        url: 'https://example.com/article',
        query: '  pricing details  ',
        extract_depth: 'advanced',
      },
      signal,
    );

    const request = fetchCall(fetchMock);
    expect(request.init.signal).toBe(signal);
    expect(request.headers.get('authorization')).toBe('Bearer tvly-key');
    expect(request.headers.has('x-tavily-access-mode')).toBe(false);
    expect(request.body).toEqual({
      urls: ['https://example.com/article'],
      query: 'pricing details',
      chunks_per_source: 3,
      extract_depth: 'advanced',
      include_images: false,
      include_favicon: false,
      format: 'markdown',
      include_usage: false,
    });
    expect(jsonOf<{ content: string }>(result).content).toBe(
      'Relevant chunk containing [redacted]',
    );
  });

  it.each([
    '../relative',
    'ftp://example.com/file',
    'data:text/plain,hello',
    'https://user:password@example.com/private',
  ])('rejects unsupported URL %s before making a request', async (url) => {
    const fetchMock = vi.fn<typeof fetch>();
    const fetchTool = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_fetch',
    );

    await expect(fetchTool.execute('fetch', { url })).rejects.toThrow(
      /HTTP\(S\) URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a partial extraction failure into a redacted tool error', async () => {
    const url = 'https://example.com/missing';
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [],
        failed_results: [
          { url, error: 'Access with tvly-secret was rejected' },
        ],
      }),
    );
    const fetchTool = findTool(
      createWebTools({
        tavilyApiKey: 'tvly-secret',
        fetchImpl: fetchMock,
      }),
      'web_fetch',
    );

    await expect(fetchTool.execute('fetch', { url })).rejects.toThrow(
      'Access with [redacted] was rejected',
    );
    await expect(fetchTool.execute('fetch', { url })).rejects.not.toThrow(
      /tvly-secret/,
    );
  });

  it('rejects an empty successful extraction response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ results: [], failed_results: [] }),
    );
    const fetchTool = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_fetch',
    );

    await expect(
      fetchTool.execute('fetch', { url: 'https://example.com/empty' }),
    ).rejects.toThrow('Tavily returned no content');
  });

  it('limits fetched content by complete Unicode characters', async () => {
    const rawContent = `${'a'.repeat(MAX_WEB_FETCH_CONTENT_CHARS - 1)}🙂tail`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          { url: 'https://example.com/large', raw_content: rawContent },
        ],
        failed_results: [],
      }),
    );
    const fetchTool = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_fetch',
    );

    const result = await fetchTool.execute('fetch', {
      url: 'https://example.com/large',
    });
    const outputText = textOf(result);
    const output = JSON.parse(outputText) as {
      content: string;
      content_truncated: boolean;
    };

    expect([...output.content]).toHaveLength(MAX_WEB_FETCH_CONTENT_CHARS);
    expect(output.content.endsWith('🙂')).toBe(true);
    expect(output.content_truncated).toBe(true);
    expect(output.content).not.toContain('\uFFFD');
  });
});

describe('Tavily response failures', () => {
  it.each([
    [400, { detail: { error: 'invalid request' } }, 'invalid request'],
    [401, { error: 'invalid API key' }, 'invalid API key'],
    [432, { detail: { error: 'plan limit reached' } }, 'plan limit reached'],
    [433, { error: 'pay-as-you-go limit reached' }, 'pay-as-you-go limit'],
    [500, { detail: { error: 'internal failure' } }, 'internal failure'],
  ])(
    'reports Tavily HTTP %i without retrying',
    async (status, body, message) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json(body, { status }),
      );
      const search = findTool(
        createWebTools({ fetchImpl: fetchMock }),
        'web_search',
      );

      await expect(
        search.execute('search', { query: 'query' }),
      ).rejects.toThrow(new RegExp(`\\(${status}\\).*${message}`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('prefers detail.error and includes retry-after on a 429', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          detail: { error: 'slow down' },
          error: 'less specific',
        },
        { status: 429, headers: { 'retry-after': '12' } },
      ),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    await expect(search.execute('search', { query: 'query' })).rejects.toThrow(
      /\(429\): slow down Retry after 12 seconds/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded plain-text fallback and redacts the configured key', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(`Rejected tvly-secret ${'x'.repeat(10_000)}`, {
          status: 500,
        }),
    );
    const search = findTool(
      createWebTools({
        tavilyApiKey: 'tvly-secret',
        fetchImpl: fetchMock,
      }),
      'web_search',
    );

    let error: unknown;
    try {
      await search.execute('search', { query: 'query' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Rejected [redacted]');
    expect(message).not.toContain('tvly-secret');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts the configured key from transport failures', async () => {
    const apiKey = 'tvly-super-secret';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`socket failed for ${apiKey}`));
    const search = findTool(
      createWebTools({ tavilyApiKey: apiKey, fetchImpl: fetchMock }),
      'web_search',
    );

    const outcome = search.execute(
      'call',
      { query: 'transport failure' },
      undefined,
    );

    await expect(outcome).rejects.toThrow('[redacted]');
    await expect(outcome).rejects.not.toThrow(apiKey);
  });

  it('cancels a body rejected from its declared content length', async () => {
    const cancel = vi.fn<(reason?: unknown) => void>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      status: 500,
      headers: { 'content-length': String(11 * 1024 * 1024) },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    await expect(
      search.execute('call', { query: 'oversized' }),
    ).rejects.toThrow('response exceeded the size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized chunked response', async () => {
    const cancel = vi.fn<(reason?: unknown) => void>();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new Uint8Array(11 * 1024 * 1024));
      },
      cancel,
    });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(body)),
    );
    const search = findTool(
      createWebTools({ fetchImpl: fetchMock }),
      'web_search',
    );

    await expect(
      search.execute('call', { query: 'oversized' }),
    ).rejects.toThrow('response exceeded the size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not leak the configured key from abort failures', async () => {
    const apiKey = 'tvly-abort-secret';
    const abortError = new Error(`aborted with ${apiKey}`);
    abortError.name = 'AbortError';
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(abortError);
    const search = findTool(
      createWebTools({ tavilyApiKey: apiKey, fetchImpl: fetchMock }),
      'web_search',
    );

    const outcome = search.execute(
      'call',
      { query: 'abort failure' },
      undefined,
    );

    await expect(outcome).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Tavily request was aborted.',
    });
    await expect(outcome).rejects.not.toThrow(apiKey);
  });

  it.each([
    ['web_search', new Response('not JSON')],
    ['web_fetch', Response.json({ results: [] })],
  ])(
    'rejects malformed successful responses from %s',
    async (name, response) => {
      const fetchMock = vi.fn<typeof fetch>(async () => response);
      const tool = findTool(
        createWebTools({ fetchImpl: fetchMock }),
        name as string,
      );
      const arguments_ =
        name === 'web_search'
          ? { query: 'query' }
          : { url: 'https://example.com' };

      await expect(tool.execute('call', arguments_)).rejects.toThrow(
        /returned invalid JSON|returned an invalid response/,
      );
    },
  );
});
