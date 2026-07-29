// Some models (and some Ollama versions) don't reliably use the structured
// tool_calls field — instead they write one or more JSON objects like
// {"name": "run_shell", "arguments": {...}} directly into the text content.
// This scans a string for balanced top-level {...} blocks and returns any
// that parse as valid tool calls, so the agent loop can execute them anyway.

function findBalancedJsonBlocks(str) {
  const blocks = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          blocks.push(str.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return blocks;
}

function extractFallbackToolCalls(content) {
  if (!content || typeof content !== 'string' || !content.includes('{')) return [];

  const calls = [];
  for (const block of findBalancedJsonBlocks(content)) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }

    // Accept either {"name": "...", "arguments": {...}}
    // or the OpenAI-style {"function": {"name": "...", "arguments": {...}}}
    const candidate = parsed.function || parsed;
    if (candidate && typeof candidate.name === 'string' && candidate.arguments !== undefined) {
      calls.push({ name: candidate.name, arguments: candidate.arguments });
    }
  }
  return calls;
}

module.exports = { extractFallbackToolCalls };
