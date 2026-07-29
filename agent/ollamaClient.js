// Thin wrapper around Ollama's /api/chat endpoint with tool-calling support.
// Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools

async function chat({ serverUrl, model, messages, tools, signal }) {
  const url = `${serverUrl.replace(/\/$/, '')}/api/chat`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
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

  const data = await res.json();
  // data.message = { role: 'assistant', content: '...', tool_calls?: [...] }
  return data.message;
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
