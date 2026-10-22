let dashboardToken = (localStorage.getItem('dashboardToken') || '').trim();
let dashboardAuthEpoch = Number(localStorage.getItem('dashboardAuthEpoch') || '0');
let authPromptPromise = null;
let dashboardAuthed = false;
let authRequired = false;
let loginResolver = null;
let selectedTaskId = null;
let activePromptId = null;
let socket = null;

const liveConsole = document.getElementById('live-console');
const taskLogEl = document.getElementById('task-log');
const tasksEl = document.getElementById('tasks');
const promptBox = document.getElementById('prompt-box');
const promptInputRow = document.getElementById('prompt-input-row');
const promptInput = document.getElementById('prompt-input');
const promptSubmit = document.getElementById('prompt-submit');
const promptContinue = document.getElementById('prompt-continue');
const promptQuit = document.getElementById('prompt-quit');
let activePromptKind = null;
const browserSessionsEl = document.getElementById('browser-sessions');
const browserShot = document.getElementById('browser-shot');
const loginGate = document.getElementById('login-gate');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const dashboardApp = document.getElementById('dashboard-app');

function appendConsole(text, { taskId } = {}) {
  if (!text) return;
  liveConsole.textContent += text;
  liveConsole.scrollTop = liveConsole.scrollHeight;
  if (selectedTaskId && taskId === selectedTaskId && taskLogEl) {
    taskLogEl.textContent += text;
    taskLogEl.scrollTop = taskLogEl.scrollHeight;
  }
}

function setConsoleContent(text) {
  liveConsole.textContent = text || '';
  liveConsole.scrollTop = liveConsole.scrollHeight;
}

async function loadConsoleHistory() {
  try {
    const response = await api('/api/dashboard/console');
    if (!response.ok) return;
    const data = await response.json();
    setConsoleContent(data.text || '');
  } catch {
    // ignore — console history is optional during startup
  }
}

function clearDashboardToken() {
  dashboardToken = '';
  dashboardAuthEpoch = 0;
  localStorage.removeItem('dashboardToken');
  localStorage.removeItem('dashboardAuthEpoch');
}

function dashboardAuthHeaders() {
  const headers = {
    'x-dashboard-client': '1',
  };
  if (dashboardToken) {
    headers.authorization = `Bearer ${dashboardToken}`;
  }
  if (dashboardAuthEpoch) {
    headers['x-dashboard-auth-epoch'] = String(dashboardAuthEpoch);
  }
  return headers;
}

function storeDashboardSession(session) {
  if (session?.authEpoch !== undefined) {
    dashboardAuthEpoch = Number(session.authEpoch) || 0;
    localStorage.setItem('dashboardAuthEpoch', String(dashboardAuthEpoch));
  }
}

async function forceDashboardLogout({ message } = {}) {
  clearDashboardToken();
  dashboardAuthed = false;
  if (socket) {
    socket.close();
    socket = null;
  }
  showLoginGate();
  if (message) {
    showLoginError(message);
  }
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove('hidden');
}

function showLoginGate() {
  dashboardAuthed = false;
  loginGate.classList.remove('hidden');
  dashboardApp.classList.add('locked');
  dashboardApp.setAttribute('inert', '');
  loginPassword.value = '';
  loginPassword.focus();
}

function unlockDashboard() {
  dashboardAuthed = true;
  loginGate.classList.add('hidden');
  loginError.classList.add('hidden');
  dashboardApp.classList.remove('locked');
  dashboardApp.removeAttribute('inert');
}

async function submitLoginPassword() {
  const password = loginPassword.value.trim();
  loginError.classList.add('hidden');
  if (!password) {
    showLoginError('Password is required.');
    return false;
  }

  dashboardToken = password;
  localStorage.setItem('dashboardToken', dashboardToken);
  const session = await fetchDashboardSession();
  if (!session.authenticated) {
    clearDashboardToken();
    loginPassword.value = '';
    showLoginError('Incorrect password.');
    return false;
  }

  storeDashboardSession(session);
  unlockDashboard();
  return true;
}

function waitForLogin() {
  showLoginGate();
  return new Promise((resolve) => {
    loginResolver = resolve;
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ok = await submitLoginPassword();
  if (ok && loginResolver) {
    loginResolver(true);
    loginResolver = null;
  }
});

async function promptForDashboardToken() {
  if (!authPromptPromise) {
    authPromptPromise = waitForLogin().then((ok) => {
      authPromptPromise = null;
      return ok ? dashboardToken : '';
    });
  }
  return authPromptPromise;
}

async function api(path, options = {}, { retried = false } = {}) {
  if (authRequired && !dashboardAuthed) {
    await waitForLogin();
  }

  const headers = { ...dashboardAuthHeaders(), ...(options.headers || {}) };
  const body = options.body;
  if (body && typeof body === 'string' && !headers['content-type'] && !headers['Content-Type']) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers, body });
  if (response.status === 401 && !retried) {
    await forceDashboardLogout();
    const token = await promptForDashboardToken();
    if (token) {
      connectSocket();
      return api(path, options, { retried: true });
    }
  }
  return response;
}

async function fetchDashboardSession() {
  const response = await fetch('/api/dashboard/session', {
    headers: dashboardAuthHeaders(),
  });
  if (!response.ok) {
    return { required: true, authenticated: false };
  }
  const session = await response.json();
  storeDashboardSession(session);
  return session;
}

async function ensureDashboardAuth() {
  const session = await fetchDashboardSession();
  authRequired = Boolean(session.required);
  if (!session.required || session.authenticated) {
    storeDashboardSession(session);
    unlockDashboard();
    return true;
  }

  await forceDashboardLogout();
  await waitForLogin();
  return dashboardAuthed;
}

function switchTab(name) {
  if (!dashboardAuthed) return;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  });
  if (name === 'config') loadConfig();
  if (name === 'assets') loadAssets();
  if (name === 'codes') loadCodes();
  if (name === 'products') loadProducts();
  if (name === 'tasks') refreshTasks();
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab?.dataset.tab) switchTab(tab.dataset.tab);
});

async function runCommand(command, args = []) {
  if (!dashboardAuthed) return;
  const response = await api('/api/dashboard/run', {
    method: 'POST',
    body: JSON.stringify({ command, args }),
  });
  const data = await response.json();
  if (!response.ok) {
    appendConsole(`[error] ${data.error || response.statusText}\n`);
    return;
  }
  selectedTaskId = data.id;
  refreshTasks();
}

document.getElementById('console-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('console-input');
  const raw = input.value.trim();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);
  runCommand(command, args);
  input.value = '';
});

document.getElementById('clear-console').onclick = () => {
  liveConsole.scrollTop = 0;
};

document.getElementById('sign-out')?.addEventListener('click', () => {
  forceDashboardLogout();
});

document.getElementById('sign-out-all')?.addEventListener('click', async () => {
  if (!dashboardAuthed) return;
  if (!window.confirm('Sign out every dashboard browser session? You will need to sign in again.')) {
    return;
  }
  const response = await api('/api/dashboard/revoke-sessions', { method: 'POST' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    appendConsole(`[error] Could not revoke sessions: ${data.error || response.statusText}\n`);
    return;
  }
  const data = await response.json();
  storeDashboardSession(data);
  await forceDashboardLogout({ message: 'All dashboard sessions were signed out.' });
});

async function loadCommands() {
  const container = document.getElementById('command-buttons');
  if (!container) return;

  try {
    const response = await api('/api/dashboard/commands');
    const data = await response.json();
    container.innerHTML = '';
    for (const cmd of data.commands || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<strong>${cmd.label}</strong><small>${cmd.description}</small>`;
      btn.onclick = () => runCommand(cmd.id);
      container.appendChild(btn);
    }
  } catch (err) {
    container.innerHTML = `<p class="hint">Could not load commands: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

async function refreshTasks() {
  const response = await api('/api/autoreuploader/tasks');
  const data = await response.json();
  tasksEl.innerHTML = '';
  for (const task of data.tasks || []) {
    const card = document.createElement('div');
    card.className = `task-card${selectedTaskId === task.id ? ' active' : ''}`;
    card.innerHTML = `
      <strong>${task.command}</strong>
      <div>Status: ${task.status}${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ''}</div>
      <div>Pending prompts: ${task.promptCount}</div>
      <pre class="log-tail">${escapeHtml(task.logTail || '')}</pre>
    `;
    card.onclick = () => selectTask(task.id);
    tasksEl.appendChild(card);
  }
}

async function selectTask(id) {
  selectedTaskId = id;
  const response = await api(`/api/autoreuploader/tasks/${id}`);
  const task = await response.json();
  taskLogEl.textContent = task.logs || '';
  refreshTasks();
}

document.getElementById('refresh-tasks').onclick = refreshTasks;

function showPrompt(payload) {
  activePromptId = payload.id;
  activePromptKind = payload.meta?.kind === 'input' ? 'input' : 'confirm';
  promptBox.className = 'prompt active';
  promptBox.textContent = payload.message;
  promptQuit.disabled = false;

  if (activePromptKind === 'input') {
    promptInputRow.classList.remove('hidden');
    promptContinue.disabled = true;
    promptSubmit.disabled = false;
    const isPassword =
      payload.meta?.inputType === 'password' ||
      /cookie|api key|password|token/i.test(payload.message);
    promptInput.type = isPassword ? 'password' : 'text';
    promptInput.value = '';
    promptInput.placeholder = isPassword ? 'Enter secret value…' : 'Type your answer…';
    promptInput.focus();
  } else {
    promptInputRow.classList.add('hidden');
    promptInput.value = '';
    promptContinue.disabled = false;
    promptSubmit.disabled = true;
  }
}

function clearPrompt() {
  activePromptId = null;
  activePromptKind = null;
  promptBox.className = 'prompt idle';
  promptBox.textContent = 'No pending action.';
  promptInputRow.classList.add('hidden');
  promptInput.value = '';
  promptInput.type = 'text';
  promptContinue.disabled = true;
  promptSubmit.disabled = true;
  promptQuit.disabled = true;
}

function sendPromptAck(answer) {
  if (!activePromptId || !socket) return;
  socket.send(JSON.stringify({ type: 'prompt-ack', id: activePromptId, answer }));
  clearPrompt();
}

promptContinue.onclick = () => sendPromptAck('continue');

promptSubmit.onclick = () => {
  if (activePromptKind !== 'input') return;
  sendPromptAck(promptInput.value);
};

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && activePromptKind === 'input' && !promptSubmit.disabled) {
    event.preventDefault();
    promptSubmit.click();
  }
});

promptQuit.onclick = () => sendPromptAck('quit');

function connectSocket() {
  if (!dashboardAuthed) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  window.__dashboardSocket = socket;

  socket.onopen = () => {
    if (dashboardToken) {
      socket.send(JSON.stringify({ type: 'auth', token: dashboardToken }));
    }
  };

  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'auth-required') return;
    if (payload.type === 'auth-revoked') {
      if (payload.authEpoch !== undefined) {
        dashboardAuthEpoch = Number(payload.authEpoch) || 0;
        localStorage.setItem('dashboardAuthEpoch', String(dashboardAuthEpoch));
      }
      forceDashboardLogout({ message: 'Your session was signed out by an administrator.' });
      return;
    }
    if (payload.type === 'hello') {
      if (payload.authEpoch !== undefined && Number(payload.authEpoch) !== dashboardAuthEpoch) {
        forceDashboardLogout({ message: 'Your session expired — sign in again.' });
        return;
      }
      if (payload.consoleSnapshot != null) {
        setConsoleContent(payload.consoleSnapshot);
      }
    }
    if (payload.type === 'prompt') showPrompt(payload);
    if (payload.type === 'console-log') appendConsole(payload.chunk, { taskId: payload.taskId });
    if (payload.type === 'task-log') appendConsole(payload.chunk, { taskId: payload.taskId });
    if (payload.type === 'task-end') {
      refreshTasks();
    }
    if (payload.type === 'browser-screenshot') {
      browserShot.src = `data:image/jpeg;base64,${payload.imageBase64}`;
      browserShot.style.display = 'block';
    }
  };

  socket.onclose = (event) => {
    if (!dashboardAuthed || event.code === 4401) return;
    setTimeout(async () => {
      await loadConsoleHistory();
      connectSocket();
    }, 2000);
  };
}

async function refreshBrowserSessions() {
  const response = await api('/api/browser-sessions');
  const data = await response.json();
  browserSessionsEl.innerHTML = (data.sessions || [])
    .map((s) => `<div><code>${s.id}</code><br><small>${escapeHtml(JSON.stringify(s.meta))}</small></div>`)
    .join('') || '<span class="hint">No active browser sessions</span>';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isMultiline(value) {
  return String(value).includes('\n') || String(value).length > 120;
}

const CONFIG_PATH_UPLOADS = {
  rbxlPath: { kind: 'rbxl', accept: '.rbxl,.rbxlx', label: 'Upload place file' },
  iconPath: { kind: 'icon', accept: 'image/png', label: 'Upload icon' },
  thumbnailPath: { kind: 'thumbnail', accept: 'image/png', label: 'Upload thumbnail' },
};

function getPathUploadSpec(field) {
  const key = field.key.split('.').pop();
  return CONFIG_PATH_UPLOADS[key] || null;
}

function createConfigInput(field) {
  let input;
  if (field.assetIdList || field.multiline || isMultiline(field.value)) {
    input = document.createElement('textarea');
    input.value = field.value;
    if (field.assetIdList) {
      input.placeholder = '123456789, 987654321, ...';
    }
  } else {
    input = document.createElement('input');
    input.type = field.sensitive ? 'password' : 'text';
    input.value = field.value;
  }
  input.id = `cfg-${field.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  input.dataset.key = field.key;
  return input;
}

function createConfigPathUpload(field, textInput) {
  const spec = getPathUploadSpec(field);
  if (!spec) {
    return null;
  }

  const wrap = document.createElement('div');
  wrap.className = 'config-path-upload';

  const status = document.createElement('p');
  status.className = 'config-upload-status hint';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = spec.accept;
  fileInput.hidden = true;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = spec.label;
  button.onclick = () => fileInput.click();

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    button.disabled = true;
    status.textContent = `Uploading ${file.name}…`;
    status.classList.remove('error');

    try {
      const data = await uploadAssetFile(spec.kind, file);
      if (data) {
        textInput.value = data.configPath || data.path;
        status.textContent = `Uploaded · ${formatBytes(data.size)}`;
      }
    } catch (error) {
      status.textContent = error.message || 'Upload failed';
      status.classList.add('error');
    } finally {
      fileInput.value = '';
      button.disabled = false;
    }
  });

  wrap.appendChild(button);
  wrap.appendChild(fileInput);
  wrap.appendChild(status);
  return wrap;
}

function appendConfigFieldRow(parent, field) {
  const row = document.createElement('div');
  row.className = 'config-row';
  const label = document.createElement('label');
  label.textContent = field.label;
  const input = createConfigInput(field);
  label.setAttribute('for', input.id);
  row.appendChild(label);
  row.appendChild(input);
  const pathUpload = createConfigPathUpload(field, input);
  if (pathUpload) {
    row.appendChild(pathUpload);
  }
  parent.appendChild(row);
}

async function saveConfigFields({ quiet = false } = {}) {
  const fields = {};
  document.querySelectorAll('#config-fields [data-key]').forEach((el) => {
    fields[el.dataset.key] = el.value;
  });
  if (!Object.keys(fields).length) {
    return null;
  }
  const response = await api('/api/dashboard/config', {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (!quiet) {
      alert(data.error || 'Failed to save config');
    }
    throw new Error(data.error || 'Failed to save config');
  }
  if (!quiet) {
    appendConsole('[dashboard] Configuration saved.\n');
  }
  return data;
}

async function addBackupAccount(template) {
  try {
    await saveConfigFields({ quiet: true });
  } catch {
    // Allow adding even if pending edits fail validation.
  }
  const response = await api('/api/dashboard/config/backups', {
    method: 'POST',
    body: JSON.stringify({ template }),
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to add backup account');
    return;
  }
  appendConsole(`[dashboard] Added backup account (${template}). Fill in credentials and save.\n`);
  renderConfig(data);
}

async function removeBackupAccount(index, title) {
  if (!confirm(`Remove ${title}? This cannot be undone.`)) {
    return;
  }
  try {
    await saveConfigFields({ quiet: true });
  } catch {
    // Continue removing even if save fails.
  }
  const response = await api(`/api/dashboard/config/backups/${index}`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to remove backup account');
    return;
  }
  appendConsole(`[dashboard] Removed ${title}.\n`);
  renderConfig(data);
}

function renderAccountCard(account, { defaultOpen = false } = {}) {
  const card = document.createElement('details');
  card.className = 'config-account';
  card.open = defaultOpen;

  const summary = document.createElement('summary');
  summary.className = 'config-account-head';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'config-account-title';
  titleWrap.innerHTML = `<strong>${escapeHtml(account.title)}</strong>${
    account.subtitle ? `<span class="config-section-sub">${escapeHtml(account.subtitle)}</span>` : ''
  }`;
  summary.appendChild(titleWrap);

  if (account.removable) {
    const actions = document.createElement('div');
    actions.className = 'config-section-actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeBackupAccount(account.backupIndex, account.title);
    };
    actions.appendChild(removeBtn);
    summary.appendChild(actions);
  }

  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'config-section-body';
  for (const field of account.fields || []) {
    appendConfigFieldRow(body, field);
  }
  card.appendChild(body);
  return card;
}

function renderConfigGroup(group) {
  const wrap = document.createElement('div');
  wrap.className = 'config-group';

  const head = document.createElement('div');
  head.className = 'config-group-head';

  const title = document.createElement('h3');
  title.textContent = group.title;
  head.appendChild(title);

  if (group.addable) {
    const actions = document.createElement('div');
    actions.className = 'config-section-actions';
    const addBlank = document.createElement('button');
    addBlank.type = 'button';
    addBlank.textContent = 'Add backup';
    addBlank.onclick = () => addBackupAccount('blank');
    const addFromPrimary = document.createElement('button');
    addFromPrimary.type = 'button';
    addFromPrimary.textContent = 'Copy from primary';
    addFromPrimary.onclick = () => addBackupAccount('primary');
    actions.appendChild(addBlank);
    actions.appendChild(addFromPrimary);
    head.appendChild(actions);
  }

  wrap.appendChild(head);

  const list = document.createElement('div');
  list.className = 'config-account-list';

  if (!group.accounts?.length) {
    const empty = document.createElement('p');
    empty.className = 'hint config-group-empty';
    empty.textContent = group.emptyHint || 'No accounts in this group.';
    list.appendChild(empty);
  } else {
    for (const account of group.accounts) {
      list.appendChild(
        renderAccountCard(account, {
          defaultOpen: group.kind === 'primary' || group.accounts.length === 1,
        })
      );
    }
  }

  wrap.appendChild(list);
  return wrap;
}

function renderConfigSection(section) {
  const card = document.createElement('details');
  card.className = 'config-section';
  card.open = false;

  const summary = document.createElement('summary');
  summary.className = 'config-section-head';
  summary.innerHTML = `<div><strong>${escapeHtml(section.title)}</strong></div>`;
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'config-section-body';
  for (const field of section.fields || []) {
    appendConfigFieldRow(body, field);
  }
  card.appendChild(body);
  return card;
}

function renderConfig(data) {
  document.getElementById('config-path').textContent = data.exists
    ? `Config file: ${data.path}`
    : `Config file missing: ${data.path}`;

  const container = document.getElementById('config-fields');
  container.innerHTML = '';

  const groups = data.groups || [];
  const sections = data.sections || [];

  if (!groups.length && !sections.length) {
    container.innerHTML = '<p class="hint">No configuration loaded.</p>';
    return;
  }

  for (const group of groups) {
    container.appendChild(renderConfigGroup(group));
  }

  if (sections.length) {
    const other = document.createElement('div');
    other.className = 'config-group';
    const head = document.createElement('div');
    head.className = 'config-group-head';
    const title = document.createElement('h3');
    title.textContent = 'Other settings';
    head.appendChild(title);
    other.appendChild(head);

    const list = document.createElement('div');
    list.className = 'config-section-list';
    for (const section of sections) {
      list.appendChild(renderConfigSection(section));
    }
    other.appendChild(list);
    container.appendChild(other);
  }
}

async function loadConfig() {
  const response = await api('/api/dashboard/config');
  const data = await response.json();
  renderConfig(data);
  loadPlaceIds();
}

async function loadPlaceIds() {
  const metaEl = document.getElementById('placeids-meta');
  const previewEl = document.getElementById('placeids-preview');
  if (!metaEl || !previewEl) return;

  const response = await api('/api/dashboard/placeids');
  const data = await response.json();
  metaEl.textContent = data.path
    ? `${data.exists ? 'Saved at' : 'Missing file:'} ${data.path}${data.error ? ` (${data.error})` : ''}`
    : '';
  previewEl.textContent = data.data ? JSON.stringify(data.data, null, 2) : 'No placeids.json yet — run Push Place IDs or a full/normal upload task.';
}

document.getElementById('reload-placeids')?.addEventListener('click', loadPlaceIds);
document.getElementById('push-placeids')?.addEventListener('click', async () => {
  const response = await api('/api/dashboard/placeids/push', { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to push place IDs');
    return;
  }
  appendConsole(`[dashboard] Place IDs pushed via ${data.method || 'export'}.\n`);
  loadPlaceIds();
});

document.getElementById('reload-config').onclick = loadConfig;

document.getElementById('save-config').onclick = async () => {
  try {
    await saveConfigFields();
    loadConfig();
  } catch {
    // Alert already shown.
  }
};

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setAssetUploadStatus(kind, message, { error = false, busy = false } = {}) {
  const status = document.getElementById(`upload-status-${kind}`);
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('error', Boolean(error));
  status.classList.toggle('busy', Boolean(busy));
}

async function uploadAssetFile(kind, file) {
  setAssetUploadStatus(kind, `Uploading ${file.name} (${formatBytes(file.size)})…`, { busy: true });

  const card = document.querySelector(`.asset-card[data-kind="${kind}"]`);
  const fileInput = card?.querySelector('[data-upload]');
  const downloadBtn = card?.querySelector('[data-download]');
  if (fileInput) fileInput.disabled = true;
  if (downloadBtn) downloadBtn.disabled = true;

  try {
    const response = await api(`/api/dashboard/assets/${kind}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Upload failed');
    }

    setAssetUploadStatus(kind, `Saved · ${formatBytes(data.size)} · ${data.path}`);
    appendConsole(`[dashboard] Saved ${kind} → ${data.path}\n`);
    if (fileInput) fileInput.value = '';
    await loadAssets();
    return data;
  } catch (error) {
    setAssetUploadStatus(kind, error.message || 'Upload failed', { error: true });
    appendConsole(`[error] ${error.message || 'Upload failed'}\n`);
    throw error;
  } finally {
    if (fileInput) fileInput.disabled = false;
    if (downloadBtn) downloadBtn.disabled = false;
  }
}

async function setAssetPreview(kind) {
  const preview = document.getElementById(`preview-${kind}`);
  if (!preview) return;
  const response = await api(`/api/dashboard/assets/${kind}/download`);
  if (!response.ok) {
    preview.classList.remove('visible');
    return;
  }
  const blob = await response.blob();
  if (preview.dataset.objectUrl) {
    URL.revokeObjectURL(preview.dataset.objectUrl);
  }
  const objectUrl = URL.createObjectURL(blob);
  preview.dataset.objectUrl = objectUrl;
  preview.src = objectUrl;
  preview.classList.add('visible');
}

async function loadAssets() {
  const response = await api('/api/dashboard/assets');
  const data = await response.json();
  const note = document.getElementById('assets-storage-note');
  if (note) {
    if (data.volumeBacked) {
      note.textContent = `Persistent storage: ${data.dataDir} (survives redeploys when Railway volume is mounted here).`;
      note.className = 'hint';
    } else {
      note.textContent =
        `Warning: assets are stored in ${data.dataDir} without a Railway volume — uploads are lost on redeploy. Mount a volume at /data in Railway.`;
      note.className = 'hint warn';
    }
  }
  for (const asset of data.assets || []) {
    const meta = document.getElementById(`meta-${asset.kind}`);
    if (meta) {
      meta.textContent = asset.exists
        ? `${asset.path} · ${formatBytes(asset.size)} · ${asset.updatedAt || ''}`
        : 'No file uploaded yet';
    }
    if (asset.exists && asset.kind !== 'rbxl') {
      await setAssetPreview(asset.kind);
    } else {
      const preview = document.getElementById(`preview-${asset.kind}`);
      if (preview) preview.classList.remove('visible');
    }
  }
}

document.querySelectorAll('[data-upload]').forEach((input) => {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const kind = input.dataset.upload;
    try {
      await uploadAssetFile(kind, file);
    } catch (error) {
      alert(error.message || 'Upload failed');
    }
  });
});

document.querySelectorAll('[data-download]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const kind = btn.dataset.download;
    const response = await api(`/api/dashboard/assets/${kind}/download`);
    if (!response.ok) {
      alert('File not available');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = kind === 'rbxl' ? 'game.rbxl' : `${kind}.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

const codeEditors = new Map();

function destroyCodeEditors() {
  for (const cm of codeEditors.values()) {
    cm.toTextArea();
  }
  codeEditors.clear();
}

function initFunctionEditor(textarea) {
  if (!window.CodeMirror || codeEditors.has(textarea)) {
    return codeEditors.get(textarea);
  }
  const initialValue = String(textarea.value || '').replace(/\t/g, '    ');
  const cm = CodeMirror.fromTextArea(textarea, {
    mode: 'lua',
    theme: 'dracula',
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    smartIndent: true,
    lineWrapping: false,
    viewportMargin: Infinity,
    extraKeys: {
      Tab(cm) {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
        } else {
          cm.replaceSelection('    ', 'end');
        }
      },
      'Shift-Tab'(cm) {
        cm.indentSelection('subtract');
      },
    },
  });
  cm.setValue(initialValue);
  codeEditors.set(textarea, cm);
  requestAnimationFrame(() => {
    cm.refresh();
  });
  return cm;
}

function createCodeFieldCard(label, value, { dataset = {}, type = 'text', wide = false, checkbox = false } = {}) {
  const card = document.createElement('div');
  card.className = `code-field-card${wide ? ' code-field-card-wide' : ''}`;

  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  card.appendChild(labelEl);

  if (checkbox) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    for (const [key, val] of Object.entries(dataset)) {
      input.dataset[key] = val;
    }
    card.appendChild(input);
  } else {
    const input = document.createElement('input');
    input.type = type;
    input.value = value ?? '';
    for (const [key, val] of Object.entries(dataset)) {
      input.dataset[key] = val;
    }
    card.appendChild(input);
  }

  return card;
}

function createFunctionFieldCard(value) {
  const card = document.createElement('div');
  card.className = 'code-field-card code-field-card-wide';

  const labelEl = document.createElement('label');
  labelEl.textContent = 'Function';
  card.appendChild(labelEl);

  const wrap = document.createElement('div');
  wrap.className = 'code-function-editor';
  const textarea = document.createElement('textarea');
  textarea.dataset.field = 'functionBody';
  textarea.value = value ?? '';
  wrap.appendChild(textarea);
  card.appendChild(wrap);
  return card;
}

function getFunctionBodyFromCard(card) {
  const textarea = card.querySelector('[data-field="functionBody"]');
  if (!textarea) return '';
  const cm = codeEditors.get(textarea);
  return cm ? cm.getValue() : textarea.value;
}

function collectCodesFromDom() {
  const cards = [...document.querySelectorAll('#codes-list .code-card')];
  return cards.map((card) => {
    const get = (field) => card.querySelector(`[data-field="${field}"]`)?.value ?? '';
    const limitRaw = get('limit').trim();
    return {
      name: get('name').trim(),
      date: Number(get('date')) || 999999999999,
      limit: !limitRaw || limitRaw.toLowerCase() === 'false' ? false : Number(limitRaw),
      rewards: get('rewards'),
      groupLock: card.querySelector('[data-field="groupLock"]')?.checked || false,
      groupId: get('groupId') ? Number(get('groupId')) : null,
      groupRank: get('groupRank') ? Number(get('groupRank')) : null,
      functionBody: getFunctionBodyFromCard(card),
    };
  });
}

function renderCodeCard(code, index) {
  const card = document.createElement('article');
  card.className = 'code-card';
  card.dataset.codeIndex = String(index);

  const head = document.createElement('div');
  head.className = 'code-card-head';
  head.innerHTML = `<div class="code-card-title">
    <h3>${escapeHtml(code.name || 'Unnamed code')}</h3>
    <p>${escapeHtml(code.rewards || '')}</p>
  </div>`;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.textContent = 'Remove';
  removeBtn.onclick = () => removeCode(index, code.name || 'this code');
  head.appendChild(removeBtn);
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'code-field-grid';
  grid.appendChild(createCodeFieldCard('Name', code.name, { dataset: { field: 'name' } }));
  grid.appendChild(createCodeFieldCard('Date', code.date, { dataset: { field: 'date' } }));
  grid.appendChild(
    createCodeFieldCard('Limit', code.limit === false ? 'false' : code.limit, {
      dataset: { field: 'limit' },
    })
  );
  grid.appendChild(createCodeFieldCard('Rewards', code.rewards, { dataset: { field: 'rewards' } }));
  grid.appendChild(
    createCodeFieldCard('GroupLock', code.groupLock, {
      dataset: { field: 'groupLock' },
      checkbox: true,
    })
  );
  grid.appendChild(createCodeFieldCard('GroupId', code.groupId ?? '', { dataset: { field: 'groupId' } }));
  grid.appendChild(createCodeFieldCard('GroupRank', code.groupRank ?? '', { dataset: { field: 'groupRank' } }));
  grid.appendChild(createFunctionFieldCard(code.functionBody || ''));
  card.appendChild(grid);

  return card;
}

function renderCodes(data) {
  destroyCodeEditors();

  document.getElementById('codes-meta').textContent = data.meta?.path
    ? `Live Lua: ${data.meta.path} · JSON: ${data.meta.jsonPath || 'n/a'} · updated ${data.meta.updatedAt || 'unknown'}`
    : '';

  const container = document.getElementById('codes-list');
  container.innerHTML = '';
  const codes = data.codes || [];

  if (!codes.length) {
    const empty = document.createElement('div');
    empty.className = 'code-card code-card-empty';
    empty.innerHTML = '<p class="hint">No promo codes yet. Click <strong>Add code</strong>.</p>';
    container.appendChild(empty);
    return;
  }

  codes.forEach((code, index) => container.appendChild(renderCodeCard(code, index)));

  container.querySelectorAll('[data-field="functionBody"]').forEach((textarea) => {
    initFunctionEditor(textarea);
  });
  requestAnimationFrame(() => {
    for (const cm of codeEditors.values()) {
      cm.refresh();
    }
  });
}

async function saveCodes({ quiet = false } = {}) {
  const codes = collectCodesFromDom();
  const response = await api('/api/dashboard/codes', {
    method: 'PUT',
    body: JSON.stringify({ codes }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (!quiet) alert(data.error || 'Failed to save codes');
    throw new Error(data.error || 'Failed to save codes');
  }
  if (!quiet) appendConsole('[dashboard] Promo codes saved.\n');
  renderCodes(data);
  return data;
}

async function addCode() {
  try {
    await saveCodes({ quiet: true });
  } catch {
    // Continue if nothing to save yet.
  }
  const response = await api('/api/dashboard/codes', { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to add code');
    return;
  }
  appendConsole('[dashboard] Added new promo code.\n');
  renderCodes(data);
}

async function removeCode(index, title) {
  if (!confirm(`Remove promo code "${title}"?`)) return;
  try {
    await saveCodes({ quiet: true });
  } catch {
    // Continue removing.
  }
  const response = await api(`/api/dashboard/codes/${index}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to remove code');
    return;
  }
  appendConsole(`[dashboard] Removed promo code "${title}".\n`);
  renderCodes(data);
}

async function loadCodes() {
  const response = await api('/api/dashboard/codes');
  const data = await response.json();
  renderCodes(data);
}

document.getElementById('reload-codes').onclick = loadCodes;
document.getElementById('reformat-codes').onclick = async () => {
  const response = await api('/api/dashboard/codes/reformat', { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Failed to reformat codes');
    return;
  }
  renderCodes(data);
  appendConsole('[dashboard] Reformatted promo code Lua (blocks + table fields).\n');
};
document.getElementById('add-code').onclick = addCode;
document.getElementById('save-codes').onclick = () => saveCodes();

function renderProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';

  const head = document.createElement('div');
  head.className = 'product-card-head';
  head.innerHTML = `<div class="product-card-title">
    <h3>${escapeHtml(product.productKey || 'unknown')}</h3>
    <p>${escapeHtml(product.displayName || '')} · ${product.priceRobux || 0} R$ · ${product.shirtCount || 0} shirt(s)</p>
  </div>`;
  card.appendChild(head);

  const field = document.createElement('div');
  field.className = 'product-field-card';
  const label = document.createElement('label');
  label.textContent = 'Asset IDs';
  field.appendChild(label);

  const list = document.createElement('div');
  list.className = 'product-asset-list';
  list.textContent = product.assetIdList || (product.assetIds || []).join(', ') || 'No shirts uploaded yet';
  field.appendChild(list);
  card.appendChild(field);

  return card;
}

async function loadProducts() {
  const response = await api('/api/dashboard/products');
  if (!response.ok) {
    const message = response.headers.get('content-type')?.includes('application/json')
      ? (await response.json()).error
      : response.statusText;
    appendConsole(`[dashboard] Could not load products: ${message || response.status}\n`);
    return;
  }
  const data = await response.json();
  const container = document.getElementById('products-list');
  const products = data.products || [];
  container.innerHTML = '';

  if (!products.length) {
    const empty = document.createElement('div');
    empty.className = 'product-card product-card-empty';
    empty.innerHTML =
      '<p class="hint">No products in the catalog yet. They appear when ProductBridge resolves a purchase and uploads shirts.</p>';
    container.appendChild(empty);
    return;
  }

  for (const product of products) {
    container.appendChild(renderProductCard(product));
  }
}

document.getElementById('reload-products')?.addEventListener('click', loadProducts);

async function loadDeploymentStatus() {
  try {
    const response = await fetch('/health');
    const data = await response.json();
    const deployment = data.deployment;
    const pill = document.getElementById('auth-status');
    if (!pill || !deployment) return;

    const parts = [];
    if (deployment.railway) parts.push('Railway');
    if (deployment.checks?.dashboardAuth) parts.push('auth required');
    if (deployment.checks?.volumeBacked) parts.push('volume OK');
    else if (deployment.railway) parts.push('no volume');
    if (deployment.publicUrl) parts.push(new URL(deployment.publicUrl).host);
    pill.textContent = parts.length ? parts.join(' · ') : 'Dashboard';
    pill.title = (deployment.warnings || []).join('\n') || deployment.publicUrl || '';
  } catch {
    // ignore — health may be unavailable during local dev
  }
}

async function initDashboard() {
  const authed = await ensureDashboardAuth();
  if (!authed) return;

  await loadConsoleHistory();
  await loadDeploymentStatus();
  connectSocket();
  loadCommands();
  loadConfig();
  loadAssets();
  loadCodes();
  loadProducts();
  refreshTasks();
  refreshBrowserSessions();
  setInterval(refreshTasks, 5000);
  setInterval(refreshBrowserSessions, 8000);
}

initDashboard();
