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
    };
    options?.onResponse?.(response);
    console.log('[PROFILE] MockMembrane.complete() took', Date.now() - start, 'ms');
    return response;
  }

  async stream(request: any, options?: any): Promise<any> {
    return this.complete(request, options);
  }
}
