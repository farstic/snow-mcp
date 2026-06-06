import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callLlm } from '../../src/direct/llm-client.js';

const msgs: any = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
function mockFetch(shape: unknown, ok = true, status = 200) {
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    ok, status, json: async () => shape, text: async () => JSON.stringify(shape),
  } as unknown as Response);
}

describe('llm-client — provider routing + API-key errors', () => {
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; });
  afterEach(() => vi.restoreAllMocks());

  it('throws when a cloud provider has no API key', async () => {
    await expect(callLlm({ provider: 'anthropic' }, msgs)).rejects.toThrow(/API key required for anthropic/);
    await expect(callLlm({ provider: 'openai' }, msgs)).rejects.toThrow(/API key required for openai/);
  });

  it('local provider (ollama) needs no key and hits the local URL', async () => {
    const spy = mockFetch({ message: { content: 'pong' }, model: 'llama3.3' });
    const r = await callLlm({ provider: 'ollama' }, msgs);
    expect(r.content).toBe('pong');
    expect(String((spy.mock.calls[0] as any)[0])).toContain('localhost:11434');
  });

  it('routes anthropic: x-api-key header + system split out of messages', async () => {
    const spy = mockFetch({ content: [{ text: 'A' }], model: 'claude-x', usage: { input_tokens: 1, output_tokens: 2 } });
    const r = await callLlm({ provider: 'anthropic', apiKey: 'k' }, msgs);
    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('k');
    const body = JSON.parse(init.body);
    expect(body.system).toBe('sys');
    expect(body.messages).toHaveLength(1); // system message excluded
    expect(r.content).toBe('A');
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  it('routes openai: Bearer auth + choices parsing', async () => {
    const spy = mockFetch({ choices: [{ message: { content: 'O' } }], model: 'gpt', usage: { prompt_tokens: 1, completion_tokens: 2 } });
    const r = await callLlm({ provider: 'openai', apiKey: 'k' }, msgs);
    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer k');
    expect(r.content).toBe('O');
  });

  it('routes lmstudio (local, openai-format) to localhost:1234', async () => {
    const spy = mockFetch({ choices: [{ message: { content: 'L' } }], model: 'auto' });
    const r = await callLlm({ provider: 'lmstudio' }, msgs);
    expect(String((spy.mock.calls[0] as any)[0])).toContain('localhost:1234');
    expect(r.content).toBe('L');
  });

  it('honors baseUrl override and the per-provider default model', async () => {
    const spy = mockFetch({ message: { content: 'x' }, model: '' });
    await callLlm({ provider: 'ollama', baseUrl: 'http://custom:9999/api/chat' }, msgs);
    const [url, init] = spy.mock.calls[0] as any;
    expect(url).toBe('http://custom:9999/api/chat');
    expect(JSON.parse(init.body).model).toBe('llama3.3'); // DEFAULT_MODELS.ollama
  });

  it('reads the API key from the provider env var when not passed', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const spy = mockFetch({ content: [{ text: 'ok' }], model: 'm' });
    await callLlm({ provider: 'anthropic' }, msgs);
    expect((spy.mock.calls[0] as any)[1].headers['x-api-key']).toBe('env-key');
  });

  it('surfaces a non-OK provider response as an error', async () => {
    mockFetch('bad credentials', false, 401);
    await expect(callLlm({ provider: 'anthropic', apiKey: 'k' }, msgs)).rejects.toThrow(/Anthropic API error \(401\)/);
  });
});
