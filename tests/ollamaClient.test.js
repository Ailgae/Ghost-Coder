const assert = require('node:assert/strict');
const { chat, listModels } = require('../agent/ollamaClient');

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { value: encoder.encode(chunks[index++]), done: false }
          : { value: undefined, done: true }
      })
    }
  };
}

describe('ollama client', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('streams content, thinking, and tool calls across chunk boundaries', async () => {
    const deltas = [];
    global.fetch = async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/chat');
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      assert.equal(body.options.temperature, 0.2);
      return streamResponse([
        '{"message":{"content":"hel',
        'lo","thinking":"plan"}}\n{"message":{"content":"!","thinking":" more",',
        '"tool_calls":[{"function":{"name":"read_file","arguments":{"path":"a"}}}]}}\n'
      ]);
    };

    const message = await chat({
      serverUrl: 'http://localhost:11434/',
      model: 'model',
      messages: [],
      tools: [],
      onContent: value => deltas.push(value)
    });
    assert.equal(message.content, 'hello!');
    assert.equal(message.thinking, 'plan more');
    assert.deepEqual(deltas, ['hello', '!']);
    assert.equal(message.tool_calls[0].function.name, 'read_file');
  });

  it('consumes a final JSON line without a trailing newline', async () => {
    global.fetch = async () => streamResponse(['{"message":{"content":"done"}}']);
    const message = await chat({
      serverUrl: 'http://host', model: 'm', messages: [], tools: []
    });
    assert.equal(message.content, 'done');
  });

  it('throws a useful API error including response text', async () => {
    global.fetch = async () => ({
      ok: false, status: 500, statusText: 'Server Error', text: async () => 'offline'
    });
    await assert.rejects(
      chat({ serverUrl: 'http://host', model: 'm', messages: [], tools: [] }),
      /Ollama request failed \(500\): offline/
    );
  });

  it('rejects an empty streaming response body', async () => {
    global.fetch = async () => ({ ok: true, body: null });
    await assert.rejects(
      chat({ serverUrl: 'http://host', model: 'm', messages: [], tools: [] }),
      /empty response body/
    );
  });

  it('uses OpenAI conversion and required tool choice when requireTool is set', async () => {
    global.fetch = async (url, options) => {
      assert.equal(url, 'http://host/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.equal(body.tool_choice, 'required');
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].tool_calls[0].id, 'call_0_0');
      assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"path":"a"}');
      assert.equal(body.messages[1].tool_call_id, 'call_0_0');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [] } }] })
      };
    };
    const result = await chat({
      serverUrl: 'http://host/',
      model: 'm',
      tools: [],
      requireTool: true,
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] },
        { role: 'tool', content: 'ok', tool_call_id: 'call_0_0' }
      ]
    });
    assert.equal(result.role, 'assistant');
  });

  it('rejects empty required-tool responses', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
    await assert.rejects(
      chat({ serverUrl: 'http://host', model: 'm', messages: [], tools: [], requireTool: true }),
      /empty required-tool response/
    );
  });

  it('lists model names and normalizes a trailing slash', async () => {
    global.fetch = async url => {
      assert.equal(url, 'http://host/api/tags');
      return { ok: true, json: async () => ({ models: [{ name: 'a' }, { name: 'b' }] }) };
    };
    assert.deepEqual(await listModels('http://host/'), ['a', 'b']);
  });

  it('reports model-list failures', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(listModels('http://host'), /Failed to list models \(503\)/);
  });
});
