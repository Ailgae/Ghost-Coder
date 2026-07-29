# Ghost coder

**A vibe coder that's vibe coded!**

A tiny native-feeling chat app that talks to a remote Ollama server and acts
as a coding agent: it can read/write files, run non-Git shell commands (npm,
tests, builds — anything), and loop on tool calls until the task is done.

## 1. Requirements
- [Node.js](https://nodejs.org) 18+ (for the built-in `fetch` used to call Ollama)
- Ollama running locally at `http://localhost:11434`,
  with a tool-calling-capable model pulled, e.g.:

  ```bash
  # on the local machine
  ollama pull qwen2.5-coder
  ```

  To make Ollama listen on all network interfaces, run:

  ```bash
  export OLLAMA_HOST=0.0.0.0
  ollama serve
  ```

## 2. Install & run (development)

```bash
cd ghost-coder
npm install
npm start
```

## UI Description

The sidebar lists your projects and their saved chats. Click **+** beside
**Projects** to add a project and choose the directory the agent can work in.
Use the **+** beside a project to start another chat or **⋯** to edit the
project.

The model selector is below the message box. The server-status button at the
bottom of the sidebar shows the connection state; click it to change the
Ollama endpoint, which defaults to `http://localhost:11434`.

Type what you want built or fixed in the chat box. The agent will show each
tool call it makes (reading files, writing files, running shell commands) as
a collapsible line above its reply — click to expand and see arguments/output.
Responses appear progressively as Ollama generates them.

The settings button allows you to configure various preferences for the application.
Click on it to access different settings options.

## 3. Build a distributable package

```bash
npm run dist
```

This uses `electron-builder` to produce the packaged application under `dist/`.

## How it works

- `main.js` — Electron main process: window, settings persistence, IPC.
- The Ollama client module calls `/api/chat` with `tools` attached.
- `agent/tools.js` — implements `read_file`, `write_file`, `list_dir`, `run_shell`.
- `agent/agent.js` — the loop: send messages → if the model asks for tool
calls, run them locally and feed results back → repeat until the model
gives a final text answer (capped at 25 steps per turn as a safety valve).
- `renderer/` — the chat UI (plain HTML/CSS/JS, no framework).

## Notes & things to tighten up later

- **Approval prompts.** Reading files and listing directories happen
  automatically. Writing or deleting files and running shell commands require
  approval in an inline chat card before they execute; the card disappears
  after a choice is made. File-write prompts can be permanently approved for
  that exact file path. Simple shell commands can be permanently approved by
  executable type (for example, `npm`); compound commands using shell operators
  always require one-time approval. Deletions always require approval.
- **Git is protected by default.** Enable **Allow Git modifications** in
  Settings to let the agent run Git commands and modify `.git` metadata.
- **Model must support tool calling.** Qwen2.5-coder, Llama 3.1+, and Mistral
  Nemo all work with Ollama's tool-calling format. Older/smaller models may
  ignore the `tools` field and just reply with plain text.
