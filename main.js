const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { runAgentTurn } = require('./agent/agent');
const { listModels } = require('./agent/ollamaClient');

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const conversationPath = path.join(app.getPath('userData'), 'conversations.json');

function id() { return randomUUID(); }

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* defaults below */ }
  const cwd = saved.cwd || app.getPath('home');
  // An empty array is a valid saved state: users can remove every project.
  // Only create the initial project when there is no projects setting at all.
  const projects = Array.isArray(saved.projects)
    ? saved.projects
    : [{ id: id(), name: path.basename(cwd) || 'My project', cwd }];
  return {
    serverUrl: saved.serverUrl || 'http://localhost:11434',
    model: saved.model || 'qwen2.5-coder',
    streamResponses: saved.streamResponses !== false,
    allowGit: saved.allowGit === true,
    approvedWriteFiles: Array.isArray(saved.approvedWriteFiles)
      ? [...new Set(saved.approvedWriteFiles.filter(file => typeof file === 'string').map(file => path.resolve(file)))]
      : [],
    approvedShellCommandTypes: Array.isArray(saved.approvedShellCommandTypes)
      ? [...new Set(saved.approvedShellCommandTypes.filter(type => typeof type === 'string' && type.length > 0))]
      : [],
    projects,
    activeProjectId: projects.some(project => project.id === saved.activeProjectId) ? saved.activeProjectId : (projects[0]?.id || null)
  };
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function emptyChat() {
  return { id: id(), title: 'New chat', messages: [], history: [], createdAt: Date.now() };
}

function loadConversations() {
  try {
    const saved = JSON.parse(fs.readFileSync(conversationPath, 'utf8'));
    if (saved && typeof saved.projects === 'object') return saved;
  } catch { /* migrate legacy history below */ }
  let legacy = { messages: [], history: [] };
  try { legacy = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'conversation.json'), 'utf8')); } catch { /* new install */ }
  const first = settings.projects[0];
  return first
    ? { projects: { [first.id]: { chats: [{ ...emptyChat(), ...legacy, id: id() }] } } }
    : { projects: {} };
}

function saveConversations() {
  fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
  fs.writeFileSync(conversationPath, JSON.stringify(conversations, null, 2), 'utf8');
}

let settings = loadSettings();
let conversations = loadConversations();
const activeRequests = new Map();
const pendingApprovals = new Map();

function projectById(projectId) {
  return settings.projects.find(project => project.id === projectId);
}

function chatsFor(projectId) {
  if (!conversations.projects[projectId]) conversations.projects[projectId] = { chats: [emptyChat()] };
  return conversations.projects[projectId].chats;
}

function chatById(projectId, chatId) {
  return chatsFor(projectId).find(chat => chat.id === chatId);
}

function chatSummary(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt };
}

function changeSummaryParts(content) {
  if (typeof content !== 'string') return null;
  const diffMarker = '\n\nDiff data:\n';
  const diffIndex = content.lastIndexOf(diffMarker);
  if (diffIndex === -1) return null;
  try {
    const changes = JSON.parse(Buffer.from(content.slice(diffIndex + diffMarker.length).trim(), 'base64').toString('utf8'));
    const filesIndex = content.lastIndexOf('\n\nFiles changed:\n', diffIndex);
    if (filesIndex === -1 || !Array.isArray(changes)) return null;
    return { text: content.slice(0, filesIndex).trim(), changes };
  } catch {
    return null;
  }
}

function contentWithoutChanges(content, undonePaths) {
  const parsed = changeSummaryParts(content);
  if (!parsed) return content;
  const remaining = parsed.changes.filter(change => !undonePaths.has(change.path));
  if (!remaining.length) return parsed.text;
  const lines = remaining.map(change => {
    const counts = require('./agent/agentHelpers').changedLineCounts(
      change.before == null ? undefined : Buffer.from(change.before),
      change.after == null ? undefined : Buffer.from(change.after)
    );
    return `- ${change.path}: +${counts.added} / -${counts.removed}`;
  });
  const encoded = Buffer.from(JSON.stringify(remaining), 'utf8').toString('base64');
  return `${parsed.text}\n\nFiles changed:\n${lines.join('\n')}\n\nDiff data:\n${encoded}`;
}

function restoreChange(project, change) {
  if (!change || typeof change.path !== 'string') return { ok: false, path: change?.path, error: 'Invalid change data.' };
  const root = path.resolve(project.cwd);
  const target = path.resolve(root, change.path);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, path: change.path, error: 'The file is outside the project.' };
  }

  let current = null;
  try { current = fs.readFileSync(target, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, path: change.path, error: error.message };
  }
  if (current !== change.after) {
    return { ok: false, path: change.path, error: 'The file changed again after this edit, so it was not overwritten.' };
  }

  try {
    if (change.before === null) {
      fs.unlinkSync(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, change.before, 'utf8');
    }
    return { ok: true, path: change.path };
  } catch (error) {
    return { ok: false, path: change.path, error: error.message };
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900, height: 700, minWidth: 480, minHeight: 400,
    backgroundColor: '#1e1f22', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

function parseToolArgs(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs || {};
  try { return JSON.parse(rawArgs); } catch { return {}; }
}

function shellCommandType(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  // Compound shell syntax can hide unrelated commands, so it is never covered
  // by a remembered command-type permission.
  if (!trimmed || /[\n\r;&|<>`$()]/.test(trimmed)) return null;
  const tokens = trimmed.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [];
  const executable = tokens.find(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (!executable || executable.startsWith('-')) return null;
  return path.basename(executable.replace(/^['"]|['"]$/g, ''));
}

function approveTool(sender, chatId, cwd, name, rawArgs) {
  const args = parseToolArgs(rawArgs);
  const target = args.path
    ? path.resolve(cwd, args.path)
    : null;
  const commandType = name === 'run_shell' ? shellCommandType(args.command) : null;

  if (name === 'write_file' && target && settings.approvedWriteFiles.includes(target)) {
    return true;
  }
  if (name === 'run_shell' && commandType && settings.approvedShellCommandTypes.includes(commandType)) {
    return true;
  }

  const descriptions = {
    write_file: {
      message: 'Allow the agent to write this file?',
      detail: target || '(path not provided)'
    },
    delete_file: {
      message: 'Allow the agent to delete this file?',
      detail: target || '(path not provided)'
    },
    run_shell: {
      message: 'Allow the agent to run this shell command?',
      detail: args.command || '(command not provided)'
    }
  };
  const request = descriptions[name];
  if (!request) return true;
  const rememberKind = name === 'write_file' && target
    ? 'file'
    : name === 'run_shell' && commandType
      ? 'command_type'
      : null;

  return new Promise(resolve => {
    const approvalId = id();
    pendingApprovals.set(approvalId, {
      senderId: sender.id,
      resolve,
      name,
      target,
      commandType,
      rememberKind
    });
    sender.send('chat:event', {
      type: 'approval_request',
      chatId,
      approvalId,
      name,
      message: request.message,
      detail: request.detail,
      rememberKind,
      commandType
    });
  });
}

function cancelPendingApprovals(sender) {
  for (const [approvalId, approval] of pendingApprovals) {
    if (approval.senderId !== sender.id) continue;
    pendingApprovals.delete(approvalId);
    approval.resolve(false);
    sender.send('chat:event', { type: 'approval_cancelled', approvalId });
  }
}

app.whenReady().then(() => {
  const win = createWindow();
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_evt, partial) => { settings = { ...settings, ...partial }; saveSettings(); return settings; });
  ipcMain.handle('settings:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });
  ipcMain.handle('models:list', () => listModels(settings.serverUrl));

  ipcMain.handle('projects:list', () => settings.projects);
  ipcMain.handle('projects:create', (_evt, project) => {
    const cwd = project.cwd || app.getPath('home');
    const created = { id: id(), name: project.name?.trim() || path.basename(cwd) || 'New project', cwd };
    settings.projects.push(created);
    settings.activeProjectId = created.id;
    chatsFor(created.id);
    saveSettings(); saveConversations();
    return created;
  });
  ipcMain.handle('projects:update', (_evt, project) => {
    const existing = projectById(project.id);
    if (!existing) throw new Error('Project not found');
    existing.name = project.name?.trim() || existing.name;
    existing.cwd = project.cwd || existing.cwd;
    saveSettings();
    return existing;
  });
  ipcMain.handle('projects:remove', (_evt, projectId) => {
    const index = settings.projects.findIndex(project => project.id === projectId);
    if (index === -1) throw new Error('Project not found');
    settings.projects.splice(index, 1);
    delete conversations.projects[projectId];
    if (settings.activeProjectId === projectId) settings.activeProjectId = settings.projects[0]?.id || null;
    saveSettings(); saveConversations();
    return settings.activeProjectId;
  });
  ipcMain.handle('projects:select', (_evt, projectId) => {
    if (!projectById(projectId)) throw new Error('Project not found');
    settings.activeProjectId = projectId; saveSettings();
    return projectId;
  });

  ipcMain.handle('chats:list', (_evt, projectId) => chatsFor(projectId).map(chatSummary));
  ipcMain.handle('chats:get', (_evt, projectId, chatId) => {
    const chat = chatById(projectId, chatId);
    if (!chat) throw new Error('Chat not found');
    return { id: chat.id, history: chat.history };
  });
  ipcMain.handle('chats:new', (_evt, projectId) => {
    const chat = emptyChat(); chatsFor(projectId).unshift(chat); saveConversations(); return chatSummary(chat);
  });
  ipcMain.handle('chats:remove', (_evt, projectId, chatId) => {
    const chats = chatsFor(projectId);
    const index = chats.findIndex(chat => chat.id === chatId);
    if (index === -1) return null;
    chats.splice(index, 1);
    if (!chats.length) chats.push(emptyChat());
    saveConversations();
    return chatSummary(chats[0]);
  });

  ipcMain.handle('chat:stop', evt => {
    const controller = activeRequests.get(evt.sender.id);
    if (controller) controller.abort();
    cancelPendingApprovals(evt.sender);
    return Boolean(controller);
  });
  ipcMain.handle('chat:approve', (evt, { approvalId, choice }) => {
    const approval = pendingApprovals.get(approvalId);
    if (!approval || approval.senderId !== evt.sender.id) return false;
    pendingApprovals.delete(approvalId);

    const rememberWrite = choice === 'always_file' && approval.rememberKind === 'file' && Boolean(approval.target);
    const rememberCommandType = choice === 'allow_type' && approval.rememberKind === 'command_type' && Boolean(approval.commandType);
    const approved = choice === 'allow' || rememberWrite || rememberCommandType;
    if (rememberWrite) {
      if (!settings.approvedWriteFiles.includes(approval.target)) {
        settings.approvedWriteFiles.push(approval.target);
        saveSettings();
      }
    }
    if (rememberCommandType) {
      if (!settings.approvedShellCommandTypes.includes(approval.commandType)) {
        settings.approvedShellCommandTypes.push(approval.commandType);
        saveSettings();
      }
    }
    approval.resolve(approved);
    return true;
  });
  ipcMain.handle('chat:undo-changes', (_evt, { projectId, chatId, sourceContent, changes }) => {
    const project = projectById(projectId);
    const chat = chatById(projectId, chatId);
    if (!project || !chat) return { ok: false, error: 'Project or chat no longer exists.', results: [] };
    if (!Array.isArray(changes) || !changes.length) return { ok: false, error: 'No changes were selected.', results: [] };

    const results = changes.map(change => restoreChange(project, change));
    const undonePaths = new Set(results.filter(result => result.ok).map(result => result.path));
    if (undonePaths.size) {
      for (let index = chat.history.length - 1; index >= 0; index--) {
        if (chat.history[index].content !== sourceContent) continue;
        chat.history[index].content = contentWithoutChanges(chat.history[index].content, undonePaths);
        break;
      }
      saveConversations();
    }
    return { ok: results.every(result => result.ok), results };
  });
  ipcMain.handle('chat:send', async (evt, { projectId, chatId, text }) => {
    const sender = evt.sender;
    const project = projectById(projectId);
    const chat = chatById(projectId, chatId);
    if (!project || !chat) return { ok: false, error: 'Project or chat no longer exists.' };
    if (activeRequests.has(sender.id)) return { ok: false, error: 'A response is already in progress.' };
    const controller = new AbortController(); activeRequests.set(sender.id, controller);
    chat.history.push({ role: 'user', content: text });
    if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 42) || 'New chat';
    saveConversations();
    try {
      const content = await runAgentTurn({ state: chat, userMessage: text, serverUrl: settings.serverUrl, model: settings.model, streamResponses: settings.streamResponses, allowGit: settings.allowGit, cwd: project.cwd, signal: controller.signal, approveTool: (name, args) => approveTool(sender, chatId, project.cwd, name, args), onEvent: event => sender.send('chat:event', { ...event, chatId }) });
      saveConversations();
      return { ok: true, content, title: chat.title };
    } catch (err) {
      const unsupportedTools = /does not support tools/i.test(err.message || '');
      const error = controller.signal.aborted
        ? 'Response stopped.'
        : unsupportedTools
          ? 'The selected model does not support tool calls, so it cannot edit files. Choose a tool-capable coding model such as qwen2.5-coder in the Model selector.'
          : err.message;
      chat.history.push({ role: 'error', content: `Error: ${error}` }); saveConversations();
      return { ok: false, error, title: chat.title };
    } finally {
      cancelPendingApprovals(sender);
      activeRequests.delete(sender.id);
    }
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
