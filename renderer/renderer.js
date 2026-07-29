const $ = id => document.getElementById(id);
const serverUrlEl = $('serverUrl'), streamResponsesEl = $('streamResponses'), allowGitEl = $('allowGit'), modelEl = $('model'), statusEl = $('status'), messagesEl = $('messages');
const composerForm = $('composerForm'), composerInput = $('composerInput'), sendBtn = $('sendBtn'), stopBtn = $('stopBtn');
const connectionBtn = $('connectionBtn'), settingsBtn = $('settingsBtn'), serverStatusTextEl = $('serverStatusText'), projectsListEl = $('projectsList'), chatTitleEl = $('chatTitle');
const projectModal = $('projectModal'), projectForm = $('projectForm'), projectNameEl = $('projectName'), projectPathEl = $('projectPath');
const diffModal = $('diffModal'), diffTitleEl = $('diffTitle'), diffStatsEl = $('diffStats'), diffContentEl = $('diffContent');
let sending = false, projects = [], activeProjectId = null, activeChatId = null, editingProjectId = null, streamingBubble = null;
let composerHistory = [], composerHistoryIndex = 0, composerDraft = '';

function setStatus(text) { statusEl.textContent = text; }
function setServerStatus(text, state = 'checking') { serverStatusTextEl.textContent = text; connectionBtn.classList.toggle('connected', state === 'connected'); connectionBtn.classList.toggle('error', state === 'error'); }
function setSending(value) {
  sending = value;
  sendBtn.hidden = value;
  stopBtn.hidden = !value;
  composerInput.contentEditable = String(!value);
  composerInput.dataset.placeholder = value ? 'Agent is working…' : 'Tell the agent what to build or fix…';
  composerForm.classList.toggle('is-disabled', value);
  composerForm.setAttribute('aria-busy', String(value));
}
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function splitChangeSummary(text) {
  if (typeof text !== 'string') return { content: text || '', changes: [] };
  const diffMarker = '\n\nDiff data:\n';
  const diffMarkerIndex = text.lastIndexOf(diffMarker);
  let diffs = [];
  if (diffMarkerIndex !== -1) {
    try {
      const bytes = Uint8Array.from(atob(text.slice(diffMarkerIndex + diffMarker.length).trim()), character => character.charCodeAt(0));
      diffs = JSON.parse(new TextDecoder().decode(bytes));
      text = text.slice(0, diffMarkerIndex);
    } catch { diffs = []; }
  }
  const marker = '\n\nFiles changed:\n';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) return { content: text, changes: [] };
  const lines = text.slice(markerIndex + marker.length).split('\n');
  const changes = lines.map(line => {
    const match = line.match(/^- (.+): \+(\d+) \/ -(\d+)$/);
    if (!match) return null;
    const diff = diffs.find(item => item.path === match[1]);
    return { path: match[1], added: Number(match[2]), removed: Number(match[3]), diff };
  });
  if (changes.some(change => !change)) return { content: text, changes: [] };
  return { content: text.slice(0, markerIndex).trim(), changes };
}
function diffRows(before, after) {
  const left = before === null ? [] : before.split('\n');
  const right = after === null ? [] : after.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let leftEnd = left.length - 1, rightEnd = right.length - 1;
  while (leftEnd >= start && rightEnd >= start && left[leftEnd] === right[rightEnd]) { leftEnd--; rightEnd--; }
  const rows = [];
  for (let index = 0; index < start; index++) rows.push({ before: left[index], after: right[index], type: 'same' });
  const changedLength = Math.max(leftEnd - start + 1, rightEnd - start + 1);
  for (let index = 0; index < changedLength; index++) rows.push({ before: left[start + index], after: right[start + index], type: 'changed' });
  const suffixLength = left.length - leftEnd - 1;
  for (let index = 0; index < suffixLength; index++) rows.push({ before: left[leftEnd + 1 + index], after: right[rightEnd + 1 + index], type: 'same' });
  return rows;
}
function compactDiffRows(rows, contextLines = 3) {
  const compacted = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type !== 'same') {
      compacted.push(rows[index++]);
      continue;
    }

    let end = index;
    while (end < rows.length && rows[end].type === 'same') end++;
    const runLength = end - index;
    const keepStart = index === 0 ? 0 : Math.min(contextLines, runLength);
    const keepEnd = end === rows.length ? 0 : Math.min(contextLines, runLength - keepStart);
    const omitted = runLength - keepStart - keepEnd;

    if (omitted <= contextLines) {
      compacted.push(...rows.slice(index, end));
    } else {
      compacted.push(...rows.slice(index, index + keepStart));
      compacted.push({ type: 'collapsed', count: omitted });
      compacted.push(...rows.slice(end - keepEnd, end));
    }
    index = end;
  }
  return compacted;
}
function openDiff(change) {
  if (!change.diff) return;
  diffTitleEl.textContent = change.path;
  diffStatsEl.textContent = `+${change.added}  −${change.removed}`;
  diffContentEl.replaceChildren();
  let beforeLine = 0, afterLine = 0;
  compactDiffRows(diffRows(change.diff.before, change.diff.after)).forEach(row => {
    if (row.type === 'collapsed') {
      beforeLine += row.count;
      afterLine += row.count;
      const separator = document.createElement('div');
      separator.className = 'diff-collapsed';
      separator.textContent = `⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'}`;
      diffContentEl.append(separator);
      return;
    }
    const line = document.createElement('div');
    line.className = `diff-line ${row.type}`;
    const before = document.createElement('pre');
    const after = document.createElement('pre');
    before.dataset.line = row.before === undefined ? '' : String(++beforeLine);
    after.dataset.line = row.after === undefined ? '' : String(++afterLine);
    before.textContent = row.before ?? '';
    after.textContent = row.after ?? '';
    line.append(before, after);
    diffContentEl.append(line);
  });
  diffModal.hidden = false;
  $('closeDiffBtn').focus();
}
function closeDiff() { diffModal.hidden = true; }
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
    const row = document.createElement(change.diff ? 'button' : 'div');
    row.className = 'change-row';
    if (change.diff) {
      row.type = 'button';
      row.title = `View diff for ${change.path}`;
      row.onclick = () => openDiff(change);
    }
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

function appendInlineMarkdown(parent, source) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    let element;
    if (token.startsWith('`')) {
      element = document.createElement('code');
      element.textContent = token.slice(1, -1);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong');
      appendInlineMarkdown(element, token.slice(2, -2));
    } else if (token.startsWith('~~')) {
      element = document.createElement('del');
      appendInlineMarkdown(element, token.slice(2, -2));
    } else if (token.startsWith('[')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      element = document.createElement('a');
      element.textContent = parts[1];
      element.href = parts[2];
      element.target = '_blank';
      element.rel = 'noreferrer noopener';
    } else {
      element = document.createElement('em');
      appendInlineMarkdown(element, token.slice(1, -1));
    }
    parent.append(element);
    cursor = match.index + token.length;
  }
  parent.append(document.createTextNode(source.slice(cursor)));
}

function renderMarkdown(element, markdown) {
  element.replaceChildren();
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list = null;
  let quote = [];

  const appendTextBlock = (tag, content) => {
    const block = document.createElement(tag);
    appendInlineMarkdown(block, content);
    element.append(block);
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    appendTextBlock('p', paragraph.join('\n'));
    paragraph = [];
  };
  const flushList = () => { list = null; };
  const flushQuote = () => {
    if (!quote.length) return;
    const block = document.createElement('blockquote');
    appendInlineMarkdown(block, quote.join('\n'));
    element.append(block);
    quote = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      flushParagraph(); flushList(); flushQuote();
      const codeLines = [];
      while (++index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index]);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.className = `language-${fence[1]}`;
      code.textContent = codeLines.join('\n');
      pre.append(code);
      element.append(pre);
      continue;
    }
    if (!line.trim()) {
      flushParagraph(); flushList(); flushQuote();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      appendTextBlock(`h${heading[1].length}`, heading[2]);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph(); flushList(); flushQuote();
      element.append(document.createElement('hr'));
      continue;
    }
    const item = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (item) {
      flushParagraph(); flushQuote();
      const tag = item[2] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        element.append(list);
      }
      const listItem = document.createElement('li');
      appendInlineMarkdown(listItem, item[3]);
      list.append(listItem);
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph(); flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(line);
  }
  flushParagraph(); flushQuote();
}

function renderFinalAgentContent(element, text) {
  const { content, changes } = splitChangeSummary(text);
  element.classList.add('markdown');
  renderMarkdown(element, content);
  addChangePanel(changes, element);
  scrollToBottom();
}
function addBubble(role, text) {
  if (!text?.trim()) return null;
  const element = document.createElement('div');
  element.className = `bubble ${role}`;
  messagesEl.append(element);
  if (role === 'agent') renderFinalAgentContent(element, text);
  else if (role === 'user') {
    element.classList.add('markdown');
    renderMarkdown(element, text);
    scrollToBottom();
  } else {
    element.textContent = text;
    scrollToBottom();
  }
  return element;
}
function appendStreamedContent(content) { if (!streamingBubble) { streamingBubble = document.createElement('div'); streamingBubble.className = 'bubble agent'; messagesEl.append(streamingBubble); } streamingBubble.textContent += content; scrollToBottom(); }
function discardStreamedContent() { if (streamingBubble) streamingBubble.remove(); streamingBubble = null; }
function addAction(title, detail) { const element = document.createElement('details'); element.className = 'action'; element.innerHTML = '<summary></summary><pre></pre>'; element.querySelector('summary').textContent = title; element.querySelector('pre').textContent = detail; messagesEl.append(element); scrollToBottom(); }
function describeToolCall(name, args) { return ({ read_file: `Reading ${args.path}`, write_file: `Writing ${args.path}`, list_dir: `Listing ${args.path || '.'}`, run_shell: `$ ${args.command}` })[name] || `Calling ${name}`; }
function removeApproval(approvalId) { messagesEl.querySelector(`[data-approval-id="${approvalId}"]`)?.remove(); }
function addApproval(event) {
  const card = document.createElement('section');
  card.className = 'approval-card';
  card.dataset.approvalId = event.approvalId;
  const heading = document.createElement('strong');
  heading.textContent = event.message;
  const detail = document.createElement('pre');
  detail.textContent = event.detail;
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const choices = [
    { value: 'deny', label: 'Deny', className: 'approval-deny' },
    { value: 'allow', label: 'Allow', className: 'approval-allow' }
  ];
  if (event.rememberKind === 'file') {
    choices.push({ value: 'always_file', label: 'Always allow for this file', className: 'approval-always' });
  } else if (event.rememberKind === 'command_type') {
    choices.push({ value: 'allow_type', label: `Allow this command type (${event.commandType})`, className: 'approval-always' });
  }
  choices.forEach(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = choice.className;
    button.textContent = choice.label;
    button.onclick = async () => {
      actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
      const accepted = await window.vibe.answerApproval({ approvalId: event.approvalId, choice: choice.value });
      if (accepted) {
        card.remove();
        setStatus('Working…');
      } else {
        actions.querySelectorAll('button').forEach(item => { item.disabled = false; });
      }
    };
    actions.append(button);
  });
  card.append(heading, detail, actions);
  messagesEl.append(card);
  setStatus('Waiting for approval…');
  scrollToBottom();
}

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
async function selectChat(chatId, repaint = true) { if (!chatId) return; activeChatId = chatId; const chat = await window.vibe.getChat(activeProjectId, chatId); messagesEl.replaceChildren(); chat.history.forEach(item => addBubble(item.role, item.content)); composerHistory = chat.history.filter(item => item.role === 'user' && item.content?.trim()).map(item => item.content); composerHistoryIndex = composerHistory.length; composerDraft = ''; composerInput.replaceChildren(); const chats = await window.vibe.listChats(activeProjectId); chatTitleEl.textContent = chats.find(item => item.id === chatId)?.title || 'New chat'; if (repaint) await renderProjects(); }
async function newChat(projectId) { if (sending) return; if (projectId !== activeProjectId) { activeProjectId = projectId; await window.vibe.selectProject(projectId); } const chat = await window.vibe.newChat(projectId); await selectChat(chat.id); setStatus('New chat started'); }
async function removeChat(projectId, chatId) { if (sending) return; const replacement = await window.vibe.removeChat(projectId, chatId); if (projectId === activeProjectId && chatId === activeChatId) await selectChat(replacement.id, false); await renderProjects(); }

function openProjectModal(project) { editingProjectId = project?.id || null; $('projectModalTitle').textContent = project ? 'Edit project' : 'Add project'; projectNameEl.value = project?.name || ''; projectPathEl.value = project?.cwd || ''; $('removeProjectBtn').hidden = !project; projectModal.hidden = false; projectNameEl.focus(); }
function closeProjectModal() { projectModal.hidden = true; }
function showNoProject() { activeProjectId = null; activeChatId = null; composerHistory = []; composerHistoryIndex = 0; composerDraft = ''; composerInput.replaceChildren(); messagesEl.replaceChildren(); chatTitleEl.textContent = 'No project selected'; setStatus('No projects. Add a project to start.'); }
async function initialize() { setSending(false); const settings = await window.vibe.getSettings(); serverUrlEl.value = settings.serverUrl || ''; streamResponsesEl.checked = settings.streamResponses !== false; allowGitEl.checked = settings.allowGit === true; projects = await window.vibe.listProjects(); activeProjectId = settings.activeProjectId || projects[0]?.id || null; if (activeProjectId) { const chats = await window.vibe.listChats(activeProjectId); await selectChat(chats[0]?.id, false); } else showNoProject(); await renderProjects(); refreshModelList(settings.model || ''); }

$('addProjectBtn').onclick = () => openProjectModal();
$('pickProjectDirBtn').onclick = async () => { const path = await window.vibe.pickDirectory(); if (path) { projectPathEl.value = path; if (!projectNameEl.value) projectNameEl.value = path.split('/').filter(Boolean).pop() || ''; } };
$('cancelProjectBtn').onclick = closeProjectModal; projectModal.onclick = event => { if (event.target === projectModal) closeProjectModal(); };
$('closeDiffBtn').onclick = closeDiff;
diffModal.onclick = event => { if (event.target === diffModal) closeDiff(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !diffModal.hidden) closeDiff(); });
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
let composerFormatTimer = null;
function composerNodeMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u200B/g, '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const inner = [...node.childNodes].map(composerNodeMarkdown).join('');
  const tag = node.tagName.toLowerCase();
  if (tag === 'strong' || tag === 'b') return `**${inner}**`;
  if (tag === 'em' || tag === 'i') return `*${inner}*`;
  if (tag === 'del' || tag === 's') return `~~${inner}~~`;
  if (tag === 'code' && node.parentElement?.tagName !== 'PRE') return `\`${inner}\``;
  if (tag === 'pre') return `\`\`\`\n${node.innerText.replace(/\n$/, '')}\n\`\`\``;
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inner}\n`;
  if (tag === 'blockquote') return `${node.innerText.split('\n').map(line => `> ${line}`).join('\n')}\n`;
  if (tag === 'a') return `[${inner}](${node.href})`;
  if (tag === 'li') {
    const ordered = node.parentElement?.tagName === 'OL';
    const index = ordered ? [...node.parentElement.children].indexOf(node) + 1 : null;
    return `${ordered ? `${index}.` : '-'} ${inner}\n`;
  }
  if (tag === 'br') return '\n';
  if (['p', 'div'].includes(tag)) return `${inner}\n`;
  if (tag === 'hr') return '---\n';
  return inner;
}
function composerMarkdown() {
  // Block elements contribute one structural newline. Remove only that one;
  // real trailing blank lines (for example Shift+Enter) remain intact.
  return [...composerInput.childNodes].map(composerNodeMarkdown).join('').replace(/\n$/, '');
}
function placeCaretAtEnd(element) {
  const range = document.createRange();
  const lastBlock = element.lastElementChild;
  const target = lastBlock?.matches('pre') ? lastBlock.querySelector('code') : (lastBlock || element);
  const lastMeaningfulNode = target
    ? [...target.childNodes].reverse().find(node => node.nodeType !== Node.TEXT_NODE || node.textContent.length > 0)
    : null;
  const inlineCode = lastMeaningfulNode?.nodeType === Node.ELEMENT_NODE && lastMeaningfulNode.matches('code')
    ? lastMeaningfulNode
    : null;
  if (inlineCode) {
    let caretText = inlineCode.nextSibling;
    if (!caretText || caretText.nodeType !== Node.TEXT_NODE) {
      caretText = document.createTextNode('\u200B');
      inlineCode.after(caretText);
    } else if (!caretText.textContent) {
      caretText.textContent = '\u200B';
    }
    range.setStart(caretText, caretText.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(target || element);
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
function formatComposer() {
  const source = composerMarkdown();
  // Keep an empty line created with Shift+Enter editable. Rendering Markdown
  // would otherwise discard that trailing blank line and move the caret back.
  if (source.endsWith('\n')) return;
  if (!source.trim()) return composerInput.replaceChildren();
  renderMarkdown(composerInput, source);
  placeCaretAtEnd(composerInput);
}
function setComposerMarkdown(source) {
  clearTimeout(composerFormatTimer);
  if (!source) composerInput.replaceChildren();
  else renderMarkdown(composerInput, source);
  placeCaretAtEnd(composerInput);
}
function navigateComposerHistory(direction) {
  if (!composerHistory.length) return false;
  if (direction < 0) {
    if (composerHistoryIndex === composerHistory.length) composerDraft = composerMarkdown();
    if (composerHistoryIndex === 0) return true;
    composerHistoryIndex--;
    setComposerMarkdown(composerHistory[composerHistoryIndex]);
    return true;
  }
  if (composerHistoryIndex >= composerHistory.length) return true;
  composerHistoryIndex++;
  setComposerMarkdown(composerHistoryIndex === composerHistory.length ? composerDraft : composerHistory[composerHistoryIndex]);
  return true;
}
composerInput.oninput = event => {
  composerHistoryIndex = composerHistory.length;
  composerDraft = composerMarkdown();
  clearTimeout(composerFormatTimer);
  // Do not re-render an opening backtick. Transform only a completed inline
  // code pair or a line containing exactly three backticks.
  if (event.data === '`') {
    const source = composerMarkdown();
    const currentLine = source.split('\n').at(-1);
    if (currentLine === '```' || /`[^`\n]+`/.test(source)) formatComposer();
    return;
  }
  composerFormatTimer = setTimeout(formatComposer, 350);
};
composerInput.onkeydown = event => {
  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && navigateComposerHistory(event.key === 'ArrowUp' ? -1 : 1)) {
    event.preventDefault();
    return;
  }
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
  const codeBlock = anchorElement?.closest?.('pre');
  if (event.key === 'ArrowDown' && codeBlock && selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const tail = range.cloneRange();
    tail.selectNodeContents(codeBlock);
    tail.setStart(range.endContainer, range.endOffset);
    if (!tail.toString()) {
      event.preventDefault();
      const paragraph = document.createElement('p');
      paragraph.append(document.createElement('br'));
      codeBlock.after(paragraph);
      const nextRange = document.createRange();
      nextRange.setStart(paragraph, 0);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composerForm.requestSubmit();
  }
};
composerForm.onsubmit = async event => { event.preventDefault(); clearTimeout(composerFormatTimer); const text = composerMarkdown().trim(); if (sending || !text || !modelEl.value) return; if (!activeProjectId || !activeChatId) return setStatus('Add a project before sending a message.'); composerHistory.push(text); composerHistoryIndex = composerHistory.length; composerDraft = ''; composerInput.replaceChildren(); streamingBubble = null; addBubble('user', text); setSending(true); setStatus('Working…'); const result = await window.vibe.sendMessage({ projectId: activeProjectId, chatId: activeChatId, text }); if (result.ok) { if (streamingBubble) renderFinalAgentContent(streamingBubble, result.content); else addBubble('agent', result.content); chatTitleEl.textContent = result.title; } else addBubble('error', `Error: ${result.error}`); streamingBubble = null; setStatus(result.ok ? 'Ready' : 'Error'); setSending(false); stopBtn.disabled = false; await renderProjects(); };
window.vibe.onEvent(event => {
  if (event.type === 'approval_cancelled') return removeApproval(event.approvalId);
  if (event.chatId !== activeChatId) return;
  if (event.type === 'content_delta') appendStreamedContent(event.content);
  else if (event.type === 'note') { discardStreamedContent(); addBubble('agent', event.content); }
  else if (event.type === 'thinking') addAction('Thinking', event.content);
  else if (event.type === 'tool_call') { discardStreamedContent(); addAction(describeToolCall(event.name, event.args), JSON.stringify(event.args, null, 2)); }
  else if (event.type === 'tool_result') addAction(`${event.result?.ok ? '✓' : '✗'} ${event.name} result`, JSON.stringify(event.result, null, 2));
  else if (event.type === 'approval_request') addApproval(event);
});
initialize().catch(error => setStatus(`Startup error: ${error.message}`));
