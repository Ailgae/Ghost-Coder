// Thin wrapper around Ollama's /api/chat endpoint with tool-calling support.
// Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools

async function chat({ serverUrl, model, messages, tools, stream = true, signal, onContent }) {
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

async function listModels(serverUrl) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/tags`;
  console.log(`Fetching models from URL: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to list models (${res.status})`);
  const data = await res.json();
  console.log(`Received response:`, data);
  return (data.models || []).map(m => m.name);
}

module.exports = { chat, listModels };
