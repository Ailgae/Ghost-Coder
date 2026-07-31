const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibe', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  pickDirectory: () => ipcRenderer.invoke('settings:pickDirectory'),
  listModels: () => ipcRenderer.invoke('models:list'),
  checkServer: () => ipcRenderer.invoke('server:check'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (project) => ipcRenderer.invoke('projects:create', project),
  updateProject: (project) => ipcRenderer.invoke('projects:update', project),
  removeProject: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  selectProject: (projectId) => ipcRenderer.invoke('projects:select', projectId),
  listChats: (projectId) => ipcRenderer.invoke('chats:list', projectId),
  getChat: (projectId, chatId) => ipcRenderer.invoke('chats:get', projectId, chatId),
  newChat: (projectId) => ipcRenderer.invoke('chats:new', projectId),
  removeChat: (projectId, chatId) => ipcRenderer.invoke('chats:remove', projectId, chatId),
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  undoChanges: (payload) => ipcRenderer.invoke('chat:undo-changes', payload),
  answerApproval: (payload) => ipcRenderer.invoke('chat:approve', payload),
  stopMessage: () => ipcRenderer.invoke('chat:stop'),
  onEvent: (callback) => {
    const handler = (_evt, payload) => callback(payload);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  }
});
