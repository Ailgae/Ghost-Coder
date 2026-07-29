const $ = id => document.getElementById(id);
const serverUrlEl = $('serverUrl'), streamResponsesEl = $('streamResponses'), allowGitEl = $('allowGit'), modelEl = $('model'), statusEl = $('status'), messagesEl = $('messages');
const composerForm = $('composerForm'), composerInput = $('composerInput'), sendBtn = $('sendBtn'), stopBtn = $('stopBtn');
const connectionBtn = $('connectionBtn'), settingsBtn = $('settingsBtn'), serverStatusTextEl = $('serverStatusText'), projectsListEl = $('projectsList'), chatTitleEl = $('chatTitle');
const projectModal = $('projectModal'), projectForm = $('projectForm'), projectNameEl = $('projectName'), projectPathEl = $('projectPath');
let sending = false, projects = [], activeProjectId = null, activeChatId = null, editingProjectId = null, streamingBubble = null;

function setStatus(text) { statusEl.textContent = text; }
function setServerStatus(text, state = 'checking') { serverStatusTextEl.textContent = text; connectionBtn.classList.toggle('connected', state === 'connected'); connectionBtn.classList.toggle('error', state === 'error'); }
function setSending(value) { sending = value; sendBtn.hidden = value; stopBtn.hidden = !value; composerInput.disabled = value; }
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function splitChangeSummary(text) {
  if (typeof text !== 'string') return { content: text || '', changes: [] };
  const marker = '\n\nFiles changed:\n';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) return { content: text, changes: [] };
  const lines = text.slice(markerIndex + marker.length).split('\n');
  const changes = lines.map(line => {
    const match = line.match(/^- (.+): \+(\d+) \/ -(\d+)$/);
    return match ? { path: match[1], added: Number(match[2]), removed: Number(match[3]) } : null;
  });
  if (changes.some(change => !change)) return { content: text, changes: [] };
  return { content: text.slice(0, markerIndex).trim(), changes };
}
function addChangePanel(changes, afterElement) {
  if (!changes.length) return null;
  const panel = document.createElement('section');
  panel.className = 'change-panel';
  panel.setAttribute('aria-label', 'Files changed');
  const totalAdded = changes.reduce((sum, change) => sum + change.added, 0);
  const totalRemoved = changes.reduce((sum, change) => sum + change.removed, 0);
  const header = document.createElement('header');
  header.className = 'change-panel-header';
  const title = document.createElement('strong');
  title.textContent = `${changes.length} file${changes.length === 1 ? '' : 's'} changed`;
  const totals = document.createElement('span');
  totals.innerHTML = `<span class="change-added">+${totalAdded}</span><span class="change-removed">−${totalRemoved}</span>`;
  header.append(title, totals);
  const list = document.createElement('div');
  list.className = 'change-list';
  changes.forEach(change => {
    const row = document.createElement('div');
    row.className = 'change-row';
    const meta = document.createElement('div');
    meta.className = 'change-meta';
    const file = document.createElement('span');
    file.className = 'change-path';
    file.textContent = change.path;
    file.title = change.path;
    const stats = document.createElement('span');
    stats.className = 'change-stats';
    stats.innerHTML = `<span class="change-added">+${change.added}</span><span class="change-removed">−${change.removed}</span>`;
    meta.append(file, stats);
    const bar = document.createElement('div');
    bar.className = 'change-bar';
    const total = change.added + change.removed;
    const added = document.createElement('span');
    added.className = 'change-bar-added';
    added.style.flexGrow = total ? change.added : 0;
    const removed = document.createElement('span');
    removed.className = 'change-bar-removed';
    removed.style.flexGrow = total ? change.removed : 0;
    bar.append(added, removed);
    row.append(meta, bar);
    list.append(row);
  });
  panel.append(header, list);
  afterElement.after(panel);
  return panel;
}
function renderFinalAgentContent(element, text) {
  const { content, changes } = splitChangeSummary(text);
  element.textContent = content;
  addChangePanel(changes, element);
  scrollToBottom();
}
function addBubble(role, text) {
  if (!text?.trim()) return null;
  const element = document.createElement('div');
  element.className = `bubble ${role}`;
  messagesEl.append(element);
  if (role === 'agent') renderFinalAgentContent(element, text);
  else { element.textContent = text; scrollToBottom(); }
  return element;
}
function appendStreamedContent(content) { if (!streamingBubble) { streamingBubble = document.createElement('div'); streamingBubble.className = 'bubble agent'; messagesEl.append(streamingBubble); } streamingBubble.textContent += content; scrollToBottom(); }
function discardStreamedContent() { if (streamingBubble) streamingBubble.remove(); streamingBubble = null; }
function addAction(title, detail) { const element = document.createElement('details'); element.className = 'action'; element.innerHTML = '<summary></summary><pre></pre>'; element.querySelector('summary').textContent = title; element.querySelector('pre').textContent = detail; messagesEl.append(element); scrollToBottom(); }
function describeToolCall(name, args) { return ({ read_file: `Reading ${args.path}`, write_file: `Writing ${args.path}`, list_dir: `Listing ${args.path || '.'}`, run_shell: `$ ${args.command}` })[name] || `Calling ${name}`; }

function setModelOptions(models, selected, placeholder) { modelEl.replaceChildren(); const first = new Option(placeholder, ''); first.disabled = true; modelEl.add(first); models.forEach(model => modelEl.add(new Option(model, model))); modelEl.value = models.includes(selected) ? selected : ''; }
function preferredModel(models, preferred) { if (models.includes(preferred)) return preferred; if (preferred && !preferred.includes(':') && models.includes(`${preferred}:latest`)) return `${preferred}:latest`; return models[0] || ''; }
async function refreshModelList(preferred = modelEl.value) {
  modelEl.disabled = true; setModelOptions([], '', 'Loading models...');
  try { const models = await window.vibe.listModels(); if (!models.length) { setModelOptions([], '', 'No models available'); setServerStatus('Connected — no models', 'connected'); return; }
    const selected = preferredModel(models, preferred); setModelOptions(models, selected, 'Select a model...'); if (selected !== preferred) await window.vibe.setSettings({ model: selected }); modelEl.disabled = false; setServerStatus('Server connected', 'connected');
  } catch (error) { setModelOptions([], '', 'Unable to load models'); setServerStatus('Server unavailable', 'error'); setStatus(`Can't reach server: ${error.message}`); }
}

async function renderProjects() {
  projectsListEl.replaceChildren();
  for (const project of projects) {
    const group = document.createElement('section'); group.className = `project-group${project.id === activeProjectId ? ' active' : ''}`;
    const header = document.createElement('div'); header.className = 'project-row';
    const select = document.createElement('button'); select.className = 'project-select'; select.type = 'button'; select.textContent = project.name; select.title = project.cwd; select.onclick = () => selectProject(project.id);
    const add = document.createElement('button'); add.className = 'mini-btn add-chat-btn'; add.type = 'button'; add.textContent = '+'; add.title = `Add chat to ${project.name}`; add.onclick = () => newChat(project.id);
    const edit = document.createElement('button'); edit.className = 'mini-btn'; edit.type = 'button'; edit.textContent = '⋯'; edit.title = `Edit ${project.name}`; edit.onclick = () => openProjectModal(project);
    header.append(select, add, edit); group.append(header);
    const list = document.createElement('div'); list.className = 'chat-list';
    for (const chat of await window.vibe.listChats(project.id)) {
      const row = document.createElement('div'); row.className = `chat-row${project.id === activeProjectId && chat.id === activeChatId ? ' active' : ''}`;
      const choose = document.createElement('button'); choose.className = 'chat-select'; choose.type = 'button'; choose.textContent = chat.title; choose.onclick = () => openChat(project.id, chat.id);
      const remove = document.createElement('button'); remove.className = 'remove-chat'; remove.type = 'button'; remove.textContent = '×'; remove.title = 'Remove chat'; remove.onclick = () => removeChat(project.id, chat.id);
      row.append(choose, remove); list.append(row);
    }
    group.append(list); projectsListEl.append(group);
  }
}
async function selectProject(projectId) { if (sending) return; activeProjectId = projectId; await window.vibe.selectProject(projectId); const chats = await window.vibe.listChats(projectId); await selectChat(chats[0]?.id, false); await renderProjects(); }
async function openChat(projectId, chatId) { if (sending) return; if (projectId !== activeProjectId) { activeProjectId = projectId; await window.vibe.selectProject(projectId); } await selectChat(chatId); }
async function selectChat(chatId, repaint = true) { if (!chatId) return; activeChatId = chatId; const chat = await window.vibe.getChat(activeProjectId, chatId); messagesEl.replaceChildren(); chat.history.forEach(item => addBubble(item.role, item.content)); const chats = await window.vibe.listChats(activeProjectId); chatTitleEl.textContent = chats.find(item => item.id === chatId)?.title || 'New chat'; if (repaint) await renderProjects(); }
async function newChat(projectId) { if (sending) return; if (projectId !== activeProjectId) { activeProjectId = projectId; await window.vibe.selectProject(projectId); } const chat = await window.vibe.newChat(projectId); await selectChat(chat.id); setStatus('New chat started'); }
async function removeChat(projectId, chatId) { if (sending) return; const replacement = await window.vibe.removeChat(projectId, chatId); if (projectId === activeProjectId && chatId === activeChatId) await selectChat(replacement.id, false); await renderProjects(); }

function openProjectModal(project) { editingProjectId = project?.id || null; $('projectModalTitle').textContent = project ? 'Edit project' : 'Add project'; projectNameEl.value = project?.name || ''; projectPathEl.value = project?.cwd || ''; $('removeProjectBtn').hidden = !project; projectModal.hidden = false; projectNameEl.focus(); }
function closeProjectModal() { projectModal.hidden = true; }
function showNoProject() { activeProjectId = null; activeChatId = null; messagesEl.replaceChildren(); chatTitleEl.textContent = 'No project selected'; setStatus('No projects. Add a project to start.'); }
async function initialize() { setSending(false); const settings = await window.vibe.getSettings(); serverUrlEl.value = settings.serverUrl || ''; streamResponsesEl.checked = settings.streamResponses !== false; allowGitEl.checked = settings.allowGit === true; projects = await window.vibe.listProjects(); activeProjectId = settings.activeProjectId || projects[0]?.id || null; if (activeProjectId) { const chats = await window.vibe.listChats(activeProjectId); await selectChat(chats[0]?.id, false); } else showNoProject(); await renderProjects(); refreshModelList(settings.model || ''); }

$('addProjectBtn').onclick = () => openProjectModal();
$('pickProjectDirBtn').onclick = async () => { const path = await window.vibe.pickDirectory(); if (path) { projectPathEl.value = path; if (!projectNameEl.value) projectNameEl.value = path.split('/').filter(Boolean).pop() || ''; } };
$('cancelProjectBtn').onclick = closeProjectModal; projectModal.onclick = event => { if (event.target === projectModal) closeProjectModal(); };
$('removeProjectBtn').onclick = async () => { const project = projects.find(item => item.id === editingProjectId); if (!project || !window.confirm(`Remove “${project.name}” and its saved chats? Project files on disk will not be deleted.`)) return; try { const nextProjectId = await window.vibe.removeProject(project.id); projects = await window.vibe.listProjects(); closeProjectModal(); if (nextProjectId) await selectProject(nextProjectId); else { showNoProject(); await renderProjects(); } } catch (error) { setStatus(error.message); } };
projectForm.onsubmit = async event => { event.preventDefault(); if (!projectPathEl.value) return setStatus('Choose a project directory'); const payload = { id: editingProjectId, name: projectNameEl.value, cwd: projectPathEl.value }; let projectId = editingProjectId; if (projectId) await window.vibe.updateProject(payload); else projectId = (await window.vibe.createProject(payload)).id; projects = await window.vibe.listProjects(); closeProjectModal(); await selectProject(projectId); };
function openConnection() { $('connectionModal').hidden = false; serverUrlEl.focus(); }
function openSettings() { $('settingsModal').hidden = false; streamResponsesEl.focus(); }
connectionBtn.onclick = openConnection;
settingsBtn.onclick = openSettings;
$('cancelConnectionBtn').onclick = () => { $('connectionModal').hidden = true; };
$('connectionModal').onclick = event => { if (event.target === $('connectionModal')) $('connectionModal').hidden = true; };
$('cancelSettingsBtn').onclick = () => { $('settingsModal').hidden = true; };
$('settingsModal').onclick = event => { if (event.target === $('settingsModal')) $('settingsModal').hidden = true; };
$('settingsForm').onsubmit = async event => { event.preventDefault(); await window.vibe.setSettings({ streamResponses: streamResponsesEl.checked, allowGit: allowGitEl.checked }); $('settingsModal').hidden = true; };
$('connectionForm').onsubmit = async event => { event.preventDefault(); await window.vibe.setSettings({ serverUrl: serverUrlEl.value.trim() }); await refreshModelList(modelEl.value); $('connectionModal').hidden = true; };
modelEl.onchange = () => window.vibe.setSettings({ model: modelEl.value });
stopBtn.onclick = async () => { if (sending) { stopBtn.disabled = true; setStatus('Stopping…'); await window.vibe.stopMessage(); } };
composerInput.oninput = () => { composerInput.style.height = 'auto'; composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`; };
composerInput.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composerForm.requestSubmit(); } };
composerForm.onsubmit = async event => { event.preventDefault(); const text = composerInput.value.trim(); if (sending || !text || !modelEl.value) return; if (!activeProjectId || !activeChatId) return setStatus('Add a project before sending a message.'); composerInput.value = ''; composerInput.style.height = 'auto'; streamingBubble = null; addBubble('user', text); setSending(true); setStatus('Working…'); const result = await window.vibe.sendMessage({ projectId: activeProjectId, chatId: activeChatId, text }); if (result.ok) { if (streamingBubble) renderFinalAgentContent(streamingBubble, result.content); else addBubble('agent', result.content); chatTitleEl.textContent = result.title; } else addBubble('error', `Error: ${result.error}`); streamingBubble = null; setStatus(result.ok ? 'Ready' : 'Error'); setSending(false); stopBtn.disabled = false; await renderProjects(); };
window.vibe.onEvent(event => { if (event.chatId !== activeChatId) return; if (event.type === 'content_delta') appendStreamedContent(event.content); else if (event.type === 'note') addBubble('agent', event.content); else if (event.type === 'thinking') addAction('Thinking', event.content); else if (event.type === 'tool_call') { discardStreamedContent(); addAction(describeToolCall(event.name, event.args), JSON.stringify(event.args, null, 2)); } else if (event.type === 'tool_result') addAction(`${event.result?.ok ? '✓' : '✗'} ${event.name} result`, JSON.stringify(event.result, null, 2)); });
initialize().catch(error => setStatus(`Startup error: ${error.message}`));
