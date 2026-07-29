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

function createWindow() {
  const win = new BrowserWindow({
    width: 900, height: 700, minWidth: 480, minHeight: 400,
    backgroundColor: '#1e1f22', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
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
    return Boolean(controller);
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
      const content = await runAgentTurn({ state: chat, userMessage: text, serverUrl: settings.serverUrl, model: settings.model, cwd: project.cwd, signal: controller.signal, onEvent: event => sender.send('chat:event', { ...event, chatId }) });
      chat.history.push({ role: 'agent', content }); saveConversations();
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
    } finally { activeRequests.delete(sender.id); }
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
