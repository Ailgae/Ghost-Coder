// Thin wrapper around Ollama's /api/chat endpoint with tool-calling support.
// Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools

function openAIMessage(message, index) {
  const converted = { role: message.role, content: message.content ?? '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    converted.tool_calls = message.tool_calls.map((call, callIndex) => ({
      id: call.id || `call_${index}_${callIndex}`,
      type: 'function',
      function: {
        name: call.function.name,
        arguments: typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments || {})
      }
    }));
  }
  if (message.role === 'tool') {
    converted.tool_call_id = message.tool_call_id;
  }
  return converted;
}

async function chatWithRequiredTool({ serverUrl, model, messages, tools, signal }) {
  const url = `${serverUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: messages.map(openAIMessage),
      tools,
      tool_choice: 'required',
      stream: false,
      temperature: 0.2
    }),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama could not require an editing tool (${res.status}): ${text || res.statusText}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('Ollama returned an empty required-tool response');
  return message;
}

async function chat({ serverUrl, model, messages, tools, stream = true, requireTool = false, signal, onContent }) {
  if (requireTool) {
    return chatWithRequiredTool({ serverUrl, model, messages, tools, signal });
  }

  const url = `${serverUrl.replace(/\/$/, '')}/api/chat`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream,
      options: {
        temperature: 0.2
      }
    }),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama request failed (${res.status}): ${text || res.statusText}`);
  }

  if (!res.body) throw new Error('Ollama returned an empty response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];

  const consume = line => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    const chunk = data.message || {};
    if (typeof chunk.content === 'string' && chunk.content) {
      message.content += chunk.content;
      if (onContent) onContent(chunk.content);
    }
    if (typeof chunk.thinking === 'string' && chunk.thinking) {
      message.thinking = (message.thinking || '') + chunk.thinking;
    }
    if (Array.isArray(chunk.tool_calls)) toolCalls.push(...chunk.tool_calls);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

async function listModels(serverUrl, { signal, timeoutMs = 4000 } = {}) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/tags`;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const abort = () => timeoutController.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const res = await fetch(url, { signal: timeoutController.signal });
    if (!res.ok) throw new Error(`Failed to list models (${res.status})`);
    const data = await res.json();
    return (data.models || []).map(m => m.name);
  } catch (error) {
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new Error(`Server did not respond within ${timeoutMs / 1000} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { chat, listModels };
