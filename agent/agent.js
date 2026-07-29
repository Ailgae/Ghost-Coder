const { chat } = require('./ollamaClient');
const { getToolDefinitions, executeTool } = require('./tools');
const { extractFallbackToolCalls } = require('./toolCallFallback');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ITERATIONS = 25;
const MAX_CHANGE_RETRIES = 2;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);

function requiresFileChange(text) {
  const informationalRequest = /^\s*(?:how|why|what|when|where|which|who|should\s+i|can\s+you\s+(?:explain|describe|review|summarize)|could\s+you\s+(?:explain|describe|review|summarize)|explain|describe|review|summarize)\b/i;
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

function systemPrompt(cwd, allowGit) {
  const gitCapabilities = allowGit
    ? 'You may run Git commands and modify Git metadata when needed to fulfill the user’s request.'
    : 'Never run Git commands, access or modify .git metadata, create commits or tags, change branches, or push to a remote. Repository management belongs exclusively to the user.';
  return `You are an autonomous coding agent running on the user's Mac, operating in the project directory: ${cwd}

You have tools to read/write files, list directories, and run shell commands (npm, pip, tests, builds, etc). File writes, deletions, and shell commands require the user's approval before they execute. Read-only tools run automatically.

Guidelines:
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

/**
 * Runs one full agent turn: takes the user's message, drives the tool-calling
 * loop against Ollama, and streams progress via onEvent. Mutates `state.messages`.
 *
 * onEvent also receives incremental `content_delta` events while Ollama
 * generates text, along with tool, thinking, note, and final events.
 */
async function runAgentTurn({ state, userMessage, serverUrl, model, streamResponses = true, allowGit = false, cwd, onEvent, approveTool, signal }) {
  const changeRequired = requiresFileChange(userMessage);
  let changeRetries = 0;
  let mutationDenied = false;
  const initialSnapshot = projectSnapshot(cwd);
  let lastSnapshot = initialSnapshot;

  const prompt = { role: 'system', content: systemPrompt(cwd, allowGit) };
  if (state.messages[0]?.role === 'system') state.messages[0] = prompt;
  else state.messages.unshift(prompt);
  state.messages.push({ role: 'user', content: userMessage });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal && signal.aborted) throw new Error('Response stopped.');
    const message = await chat({
      serverUrl,
      model,
      messages: state.messages,
      tools: getToolDefinitions(allowGit),
      stream: streamResponses,
      signal,
      onContent: streamResponses ? content => onEvent({ type: 'content_delta', content }) : null
    });
    state.messages.push(message);

    const thinking = typeof message.thinking === "string" ? message.thinking.trim() : "";
    if (thinking) onEvent({ type: "thinking", content: thinking });

    let toolCalls = (message.tool_calls || []).map(call => ({
      name: call.function.name,
      arguments: call.function.arguments,
      id: call.id
    }));

    let usedFallback = false;
    if (toolCalls.length === 0) {
      const fallback = extractFallbackToolCalls(message.content);
      if (fallback.length > 0) {
        toolCalls = fallback;
        usedFallback = true;
      }
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const { name, arguments: args, id } = call;
        onEvent({ type: 'tool_call', name, args });

        const approvalRequired = name === 'write_file' || name === 'delete_file' || name === 'run_shell';
        const approved = !approvalRequired || (approveTool && await approveTool(name, args));
        const result = approved
          ? await executeTool(name, args, cwd, { allowGit })
          : { ok: false, denied: true, error: 'The user denied this tool request.' };
        if (result.denied) mutationDenied = true;
        const nextSnapshot = projectSnapshot(cwd);
        const changedFiles = changedPaths(lastSnapshot, nextSnapshot);
        if (changedFiles.length > 0) {
          result.changedFiles = changedFiles;
        }
        lastSnapshot = nextSnapshot;
        onEvent({ type: 'tool_result', name, result });

        state.messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          ...(id ? { tool_call_id: id } : {})
        });
      }
      continue; // loop back with tool results
    }

    // A plain-text answer is not evidence that a requested edit happened.
    // Give the model a bounded opportunity to use the editing tool instead.
    const currentSnapshot = projectSnapshot(cwd);
    const hasNetFileChanges = changedPaths(initialSnapshot, currentSnapshot).length > 0;
    if (changeRequired && !hasNetFileChanges && !mutationDenied) {
      if (changeRetries < MAX_CHANGE_RETRIES) {
        changeRetries++;
        state.messages.push({
          role: 'user',
          content: `Continue implementing the original request: ${JSON.stringify(userMessage)}\n\nYou have not made a verified file change. Do not claim that anything was updated. Inspect the relevant files, use write_file or run_shell to implement this original request, then verify it before replying.`
        });
        onEvent({ type: 'note', content: 'No verified file change yet — asking the model to use the editing tools.' });
        continue;
      }

      const noChangeMessage = 'No files were modified. The model did not make a verified write after retrying, so the requested change was not applied.';
      onEvent({ type: 'final', content: noChangeMessage });
      return noChangeMessage;
    }

    // No tool calls -> this is the final answer.
    const responseText = typeof message.content === "string" && message.content.trim()
      ? message.content
      : "The model returned an empty response. Please try again.";
    const finalText = appendChangeSummary(
      responseText,
      fileChangeSummary(initialSnapshot, projectSnapshot(cwd))
    );
    onEvent({ type: 'final', content: finalText });
    return finalText;
  }

  const timeoutMsg = 'Stopped after reaching the maximum number of tool-call steps for this turn. Ask me to continue if more work is needed.';
  onEvent({ type: 'final', content: timeoutMsg });
  return timeoutMsg;
}

module.exports = { runAgentTurn };
