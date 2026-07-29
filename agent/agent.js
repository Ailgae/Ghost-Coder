const { chat } = require('./ollamaClient');
const { toolDefinitions, executeTool } = require('./tools');
const { extractFallbackToolCalls } = require('./toolCallFallback');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ITERATIONS = 25;
const MAX_CHANGE_RETRIES = 2;
const SNAPSHOT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);

function requiresFileChange(text) {
  return /\b(add|build|change|create|delete|edit|fix|implement|modify|move|rearrange|remove|rename|replace|update|write)\b/i.test(text);
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
          files.set(path.relative(cwd, absolutePath), crypto.createHash('sha256').update(contents).digest('hex'));
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
  return [...paths].filter(filePath => before.get(filePath) !== after.get(filePath));
}

function systemPrompt(cwd) {
  return `You are an autonomous coding agent running on the user's Mac, operating in the project directory: ${cwd}

You have tools to read/write files, list directories, and run shell commands (git, npm, pip, tests, builds, etc). You have full autonomy to use them without asking for confirmation.

Guidelines:
- Break down the user's request into concrete steps and carry them out using the tools, rather than just describing what should be done.
- Always invoke tools using the proper tool-calling mechanism. Never write raw JSON describing a tool call as plain text in your reply — if you want to call a tool, actually call it.
- For a request to change the project, you must inspect the relevant files and make the edit with write_file or run_shell before replying. A plan or explanation alone is not a completed change.
- Prefer running commands (e.g. "git status", "npm test") to verify state before and after changes.
- When you write code, write complete, working files rather than snippets.
- When you are done, give a concise summary of what you did and any follow-up the user should know about.
- If something fails, read the error, adjust, and retry a reasonable number of times before reporting the failure back to the user.`;
}

/**
 * Runs one full agent turn: takes the user's message, drives the tool-calling
 * loop against Ollama, and streams progress via onEvent. Mutates `state.messages`.
 *
 * onEvent also receives incremental `content_delta` events while Ollama
 * generates text, along with tool, thinking, note, and final events.
 */
async function runAgentTurn({ state, userMessage, serverUrl, model, cwd, onEvent, signal }) {
  const changeRequired = requiresFileChange(userMessage);
  let verifiedChanges = 0;
  let changeRetries = 0;
  let lastSnapshot = changeRequired ? projectSnapshot(cwd) : null;

  if (state.messages.length === 0) {
    state.messages.push({ role: 'system', content: systemPrompt(cwd) });
  }
  state.messages.push({ role: 'user', content: userMessage });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal && signal.aborted) throw new Error('Response stopped.');
    const message = await chat({
      serverUrl,
      model,
      messages: state.messages,
      tools: toolDefinitions,
      signal,
      onContent: content => onEvent({ type: 'content_delta', content })
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

        const result = await executeTool(name, args, cwd);
        if (lastSnapshot) {
          const nextSnapshot = projectSnapshot(cwd);
          const changedFiles = changedPaths(lastSnapshot, nextSnapshot);
          if (changedFiles.length > 0) {
            verifiedChanges += changedFiles.length;
            result.changedFiles = changedFiles;
          }
          lastSnapshot = nextSnapshot;
        }
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
    if (changeRequired && verifiedChanges === 0) {
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
    const finalText = typeof message.content === "string" && message.content.trim()
      ? message.content
      : "The model returned an empty response. Please try again.";
    onEvent({ type: 'final', content: finalText });
    return finalText;
  }

  const timeoutMsg = 'Stopped after reaching the maximum number of tool-call steps for this turn. Ask me to continue if more work is needed.';
  onEvent({ type: 'final', content: timeoutMsg });
  return timeoutMsg;
}

module.exports = { runAgentTurn };
