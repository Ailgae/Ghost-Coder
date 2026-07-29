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
  if (!content || typeof content !== 'string') return [];

  const calls = [];
  if (content.includes('{')) {
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
  }

  if (calls.length > 0) return calls;

  // Some Qwen/Ollama template combinations emit concise command-like lines
  // instead of structured tool_calls, for example:
  //   run_shell git status
  //   read_file package.json
  //   write_file README.md "# Ghost Coder"
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(/^(read_file|list_dir|delete_file)\s+(.+)$/);
    if (match) {
      calls.push({ name: match[1], arguments: { path: unquote(match[2].trim()) } });
      continue;
    }

    match = line.match(/^run_shell\s+(.+)$/);
    if (match) {
      calls.push({ name: 'run_shell', arguments: { command: unquote(match[1].trim()) } });
      continue;
    }

    match = line.match(/^write_file\s+(\S+)\s+([\s\S]+)$/);
    if (match) {
      calls.push({
        name: 'write_file',
        arguments: {
          path: unquote(match[1]),
          content: parseInlineContent(match[2].trim())
        }
      });
    }
  }

  return calls;
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      if (first === '"') {
        try { return JSON.parse(value); } catch { /* use inner text */ }
      }
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseInlineContent(value) {
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { /* preserve malformed text */ }
  }
  return value;
}

module.exports = { extractFallbackToolCalls };
