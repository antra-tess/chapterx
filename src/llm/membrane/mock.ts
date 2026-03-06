/**
 * Mock Membrane Adapter
 *
 * Returns instant responses for profiling pipeline latency
 * without real LLM calls. Enable with MOCK_LLM=1 env var.
 */

export class MockMembrane {
  async complete(request: any, options?: any): Promise<any> {
    const start = Date.now();
    options?.onRequest?.(request);
    const response = {
      content: [{ type: 'text', text: '[mock response]' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'mock',
      details: {
        stop: { reason: 'end_turn', wasTruncated: false },
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        timing: { totalDurationMs: 0, attempts: 1 },
        model: { requested: 'mock', actual: 'mock', provider: 'mock' },
        cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
      },
      raw: { request: {}, response: {} },
    };
    options?.onResponse?.(response);
    console.log('[PROFILE] MockMembrane.complete() took', Date.now() - start, 'ms');
    return response;
  }

  async stream(request: any, options?: any): Promise<any> {
    return this.complete(request, options);
  }
}
