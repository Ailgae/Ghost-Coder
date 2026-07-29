const { chat } = require('./ollamaClient');
const { getToolDefinitions, executeTool } = require('./tools');
const { extractFallbackToolCalls } = require('./toolCallFallback');
const {
  requiresFileChange,
  projectSnapshot,
  changedPaths,
  fileChangeSummary,
  appendChangeSummary,
  compactPreviousContext,
  finishTurn,
  systemPrompt
} = require('./agentHelpers');

const MAX_ITERATIONS = 25;
const MAX_CHANGE_RETRIES = 2;

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
  let requireToolNext = false;
  let mutationDenied = false;
  const initialSnapshot = projectSnapshot(cwd);
  let lastSnapshot = initialSnapshot;

  const previousMessages = Array.isArray(state.messages) ? state.messages : [];
  if (previousMessages.at(-1)?.role === 'user' && previousMessages.at(-1)?.content === userMessage) {
    previousMessages.pop();
  }
  state.messages = compactPreviousContext(previousMessages);
  const prompt = { role: 'system', content: systemPrompt(cwd, allowGit) };
  if (state.messages[0]?.role === 'system') state.messages[0] = prompt;
  else state.messages.unshift(prompt);
  const turnStartIndex = state.messages.length;
  state.messages.push({ role: 'user', content: userMessage });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal && signal.aborted) throw new Error('Response stopped.');
    const requireTool = requireToolNext;
    requireToolNext = false;
    const availableTools = getToolDefinitions(allowGit);
    const tools = requireTool && changeRetries >= MAX_CHANGE_RETRIES
      ? availableTools.filter(tool => ['write_file', 'run_shell', 'delete_file'].includes(tool.function.name))
      : availableTools;
    const message = await chat({
      serverUrl,
      model,
      messages: state.messages,
      tools,
      stream: streamResponses && !requireTool,
      requireTool,
      signal,
      onContent: streamResponses && !requireTool
        ? content => onEvent({ type: 'content_delta', content })
        : null
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
        requireToolNext = true;
        state.messages.push({
          role: 'user',
          content: changeRetries >= MAX_CHANGE_RETRIES
            ? `Finish implementing the original request: ${JSON.stringify(userMessage)}\n\nYou already had opportunities to inspect the project. Your next response must modify the project with write_file, run_shell, or delete_file. Read-only tools are no longer available. Do not answer with prose and do not repeat another inspection.`
            : `Continue implementing the original request: ${JSON.stringify(userMessage)}\n\nYou have not made a verified file change. Your next response is required to be a tool call. Inspect the relevant files first when necessary, then use write_file or run_shell to implement the request. Do not answer with prose until the requested change exists on disk.`
        });
        onEvent({ type: 'note', content: 'No verified file change yet — requiring the model to call a project tool.' });
        continue;
      }

      const noChangeMessage = 'No files were modified. The model did not make a verified write after retrying, so the requested change was not applied.';
      onEvent({ type: 'final', content: noChangeMessage });
      finishTurn(state, turnStartIndex, userMessage, noChangeMessage);
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
    finishTurn(state, turnStartIndex, userMessage, responseText);
    return finalText;
  }

  const timeoutMsg = 'Stopped after reaching the maximum number of tool-call steps for this turn. Ask me to continue if more work is needed.';
  onEvent({ type: 'final', content: timeoutMsg });
  finishTurn(state, turnStartIndex, userMessage, timeoutMsg);
  return timeoutMsg;
}

module.exports = { runAgentTurn };
