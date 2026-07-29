# Ghost coder

A tiny native-feeling Mac chat app that talks to a remote Ollama server and acts
as a coding agent: it can read/write files, run shell commands (git, npm,
tests, builds — anything), and loop on tool calls until the task is done.

## 1. Requirements

- macOS
- [Node.js](https://nodejs.org) 18+ (for the built-in `fetch` used to call Ollama)
- Your Ollama server reachable at `<YOUR_OLLAMA_SERVER_ADDRESS>:<PORT>` (or wherever you point it),
  with a tool-calling-capable model pulled, e.g.:

  ```bash
  # on the server (<YOUR_OLLAMA_SERVER_ADDRESS>)
  ollama pull qwen2.5-coder
  ```

  Make sure Ollama is listening on the network, not just localhost. On the
  server, set before starting it:

  ```bash
  export OLLAMA_HOST=0.0.0.0:<PORT>
  ollama serve
  ```

## 2. Install & run (development)

```bash
cd ghost-coder
npm install
npm start
```

The app opens with a sidebar where you can set:
- **Ollama server** — defaults to `http://<YOUR_OLLAMA_SERVER_ADDRESS>:<PORT>`
- **Model** — shows the models currently available on the configured Ollama server
- **Project directory** — the folder the agent reads/writes/runs commands in. Pick this before you start chatting.

Type what you want built or fixed in the chat box. The agent will show each
tool call it makes (reading files, writing files, running shell commands) as
a collapsible line above its reply — click to expand and see arguments/output.

## 3. Build a real .app you can double-click

```bash
npm run dist
```

This uses `electron-builder` to produce a `.dmg`/`.app` under `dist/`. Drag it
to Applications like any other Mac app.

## How it works

- `main.js` — Electron main process: window, settings persistence, IPC.
- `agent/ollamaClient.js` — calls Ollama's `/api/chat` with `tools` attached.
- `agent/tools.js` — implements `read_file`, `write_file`, `list_dir`, `run_shell`.
- `agent/agent.js` — the loop: send messages → if the model asks for tool
  calls, run them locally and feed results back → repeat until the model
  gives a final text answer (capped at 25 steps per turn as a safety valve).
- `renderer/` — the chat UI (plain HTML/CSS/JS, no framework).

## Notes & things to tighten up later

- **No confirmation prompts.** As requested, the agent has full autonomy —
  it will run shell commands (including destructive ones) without asking.
  If you want a safety net, the easiest addition is a per-command confirm
  dialog in `tools.js`'s `run_shell` case.
- **Non-streaming.** Replies come back all at once rather than token-by-token.
  Ollama supports streaming (`stream: true` + reading the response body as
  newline-delimited JSON) if you want a more "live typing" feel later.
- **Single conversation.** The current conversation and agent context persist
  across app restarts. Use "New chat" to clear the saved conversation.
- **Model must support tool calling.** Qwen2.5-coder, Llama 3.1+, and Mistral
  Nemo all work with Ollama's tool-calling format. Older/smaller models may
  ignore the `tools` field and just reply with plain text.
