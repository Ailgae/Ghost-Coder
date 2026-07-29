const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);

function requiresFileChange(text) {
  const informationalRequest = /^\s*(?:please\s+)?(?:how|why|what|when|where|which|who|should\s+i|can\s+you\s+(?:explain|describe|review|summarize)|could\s+you\s+(?:explain|describe|review|summarize)|explain|describe|review|summarize)\b/i;
  if (informationalRequest.test(text)) return false;

  const editVerb = /\b(?:add|adjust|build|change|configure|correct|create|delete|edit|enhance|fix|implement|improve|make|modif(?:y|ies|ied|ying|ication|ications)|move|rearrange|refactor|remove|rename|repair|replace|resolve|restyle|set|style|tweak|update|upgrade|write)(?:s|d|ed|ing)?\b/i;
  const requiredOutcome = /\b(?:please|should|must|needs?\s+to|i\s+(?:need|want|would\s+like))\b/i;
  return editVerb.test(text) || requiredOutcome.test(text);
}

// Do not rely on which tool the model chose. Shell commands can legitimately
// edit files too, so verify the project state itself before declaring failure.
function projectSnapshot(cwd) {
  const files = new Map();

  function visit(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        try {
          const contents = fs.readFileSync(absolutePath);
          files.set(path.relative(cwd, absolutePath), {
            hash: crypto.createHash('sha256').update(contents).digest('hex'),
            contents
          });
        } catch {
          // A file may disappear while a command is running; the next snapshot
          // will accurately reflect the stable filesystem state.
        }
      }
    }
  }

  visit(cwd);
  return files;
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter(filePath => before.get(filePath)?.hash !== after.get(filePath)?.hash);
}

function linesIn(contents) {
  if (!contents || contents.length === 0) return [];
  const text = contents.toString('utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

// Myers' diff algorithm gives the shortest number of inserted/deleted lines
// without requiring Git or storing a quadratic edit matrix.
function changedLineCounts(oldContents, newContents) {
  const oldLines = linesIn(oldContents);
  const newLines = linesIn(newContents);
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const furthestX = new Map([[1, 0]]);

  for (let edits = 0; edits <= oldLength + newLength; edits++) {
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      let x;
      if (
        diagonal === -edits ||
        (diagonal !== edits &&
          (furthestX.get(diagonal - 1) ?? -Infinity) < (furthestX.get(diagonal + 1) ?? -Infinity))
      ) {
        x = furthestX.get(diagonal + 1) ?? 0;
      } else {
        x = (furthestX.get(diagonal - 1) ?? 0) + 1;
      }

      let y = x - diagonal;
      while (x < oldLength && y < newLength && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      furthestX.set(diagonal, x);

      if (x >= oldLength && y >= newLength) {
        return {
          added: (edits + newLength - oldLength) / 2,
          removed: (edits + oldLength - newLength) / 2
        };
      }
    }
  }

  return { added: newLength, removed: oldLength };
}

function fileChangeSummary(before, after) {
  return changedPaths(before, after).sort().map(filePath => {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    const counts = changedLineCounts(oldFile?.contents, newFile?.contents);

    return {
      path: filePath,
      ...counts,
      before: oldFile?.contents.toString('utf8') ?? null,
      after: newFile?.contents.toString('utf8') ?? null
    };
  });
}

function appendChangeSummary(text, changes) {
  if (changes.length === 0) return text;

  const lines = changes.map(change =>
    `- ${change.path}: +${change.added} / -${change.removed}`
  );
  const diffData = Buffer.from(JSON.stringify(changes.map(({ path: filePath, before, after }) => ({
    path: filePath,
    before,
    after
  }))), 'utf8').toString('base64');
  return `${text.trim()}\n\nFiles changed:\n${lines.join('\n')}\n\nDiff data:\n${diffData}`;
}

function stripChangeSummary(text) {
  if (typeof text !== 'string') return text;
  const diffMarker = '\n\nDiff data:\n';
  const diffIndex = text.lastIndexOf(diffMarker);
  if (diffIndex === -1) return text;
  const filesIndex = text.lastIndexOf('\n\nFiles changed:\n', diffIndex);
  if (filesIndex === -1) return text;
  return text.slice(0, filesIndex).trim();
}

function compactPreviousContext(messages) {
  return messages.filter((message, index) => {
    if (message.role === 'tool') return false;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) return false;
    if (message.role === 'assistant' && messages[index + 1]?.role === 'tool') return false;
    if (
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.startsWith('Continue implementing the original request:')
    ) return false;
    return true;
  }).map(message => {
    if (message.role === 'agent' || message.role === 'error') {
      return { ...message, role: 'assistant', content: stripChangeSummary(message.content) };
    }
    return message.role === 'assistant'
      ? { ...message, content: stripChangeSummary(message.content) }
      : message;
  });
}

function finishTurn(state, turnStartIndex, userMessage, assistantMessage) {
  state.messages.splice(
    turnStartIndex,
    state.messages.length - turnStartIndex,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: assistantMessage }
  );
}

function systemPrompt(cwd, allowGit) {
  const gitCapabilities = allowGit
    ? 'You may run Git commands and modify Git metadata when needed to fulfill the user’s request.'
    : 'Never run Git commands, access or modify .git metadata, create commits or tags, change branches, or push to a remote. Repository management belongs exclusively to the user.';
  return `You are an autonomous coding agent running on the user's Mac, operating in the project directory: ${cwd}

You have tools to read/write files, list directories, and run shell commands (npm, pip, tests, builds, etc). File writes, deletions, and shell commands require the user's approval before they execute. Read-only tools run automatically.

Guidelines:
- Treat every user message as part of the current conversation. Use prior user and assistant messages to resolve references such as "it", "that", "the widget", and "the previous change"; do not handle a follow-up as a new unrelated request.
- Break down the user's request into concrete steps and carry them out using the tools, rather than just describing what should be done.
- ${gitCapabilities}
- Always invoke tools using the proper tool-calling mechanism. Never write raw JSON describing a tool call as plain text in your reply — if you want to call a tool, actually call it.
- If the user denies a tool request, do not repeat the same request. Explain what was not completed or use a safe alternative.
- For a request to change the project, you must inspect the relevant files and make the edit with write_file or run_shell before replying. A plan or explanation alone is not a completed change.
- Prefer running relevant tests or build commands (e.g. "npm test") to verify changes.
- When you write code, write complete, working files rather than snippets.
- When you are done, give a concise summary of what you did and any follow-up the user should know about. The application automatically appends the changed filenames and added/removed line counts, so do not invent or duplicate that list.
- If something fails, read the error, adjust, and retry a reasonable number of times before reporting the failure back to the user.`;
}

module.exports = {
  requiresFileChange,
  projectSnapshot,
  changedPaths,
  changedLineCounts,
  fileChangeSummary,
  appendChangeSummary,
  stripChangeSummary,
  compactPreviousContext,
  finishTurn,
  systemPrompt
};
