const loginCard = document.querySelector('#loginCard');
const adminApp = document.querySelector('#adminApp');
const loginForm = document.querySelector('#loginForm');
const uploadForm = document.querySelector('#uploadForm');
const fileInput = document.querySelector('#knowledgeFile');
const fileList = document.querySelector('#fileList');
const personality = document.querySelector('#personality');
const savePersonality = document.querySelector('#savePersonality');
const toast = document.querySelector('#toast');
const fileCount = document.querySelector('#fileCount');
const totalCharacters = document.querySelector('#totalCharacters');
const personalityLoaded = document.querySelector('#personalityLoaded');

let adminPassword = sessionStorage.getItem('adminPassword') || '';

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'x-admin-password': adminPassword
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Admin request failed');
  return payload;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function renderFiles(files = []) {
  fileList.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No knowledge files uploaded.';
    fileList.append(empty);
    return;
  }

  for (const file of files) {
    const row = document.createElement('article');
    row.className = 'file-row';

    const details = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'file-name';
    name.textContent = file.name;
    const meta = document.createElement('p');
    meta.className = 'file-meta';
    meta.textContent = `${formatSize(file.size)} · Uploaded ${formatDate(file.uploadedAt)}`;
    details.append(name, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      await adminFetch(`/api/admin/knowledge/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
      showToast('File deleted');
      await refreshStatus();
    });

    row.append(details, remove);
    fileList.append(row);
  }
}

function renderStatus(status) {
  renderFiles(status.files);
  fileCount.textContent = status.fileCount;
  totalCharacters.textContent = status.totalCharacters.toLocaleString();
  personalityLoaded.textContent = status.personalityLoaded ? 'Yes' : 'No';
}

async function refreshStatus() {
  renderStatus(await adminFetch('/api/admin/status'));
}

async function loadAdmin() {
  const [{ text }, status] = await Promise.all([
    adminFetch('/api/admin/personality'),
    adminFetch('/api/admin/status')
  ]);
  personality.value = text;
  renderStatus(status);
  loginCard.classList.add('hidden');
  adminApp.classList.remove('hidden');
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminPassword = new FormData(loginForm).get('password');
  try {
    await loadAdmin();
    sessionStorage.setItem('adminPassword', adminPassword);
    showToast('Logged in');
  } catch (err) {
    showToast(err.message);
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  const body = new FormData();
  body.set('file', file);
  try {
    const payload = await adminFetch('/api/admin/knowledge', { method: 'POST', body });
    fileInput.value = '';
    renderStatus(payload.status);
    showToast('File uploaded');
  } catch (err) {
    showToast(err.message);
  }
});

savePersonality.addEventListener('click', async () => {
  try {
    await adminFetch('/api/admin/personality', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: personality.value })
    });
    await refreshStatus();
    showToast('Personality saved');
  } catch (err) {
    showToast(err.message);
  }
});

if (adminPassword) {
  loadAdmin().catch(() => sessionStorage.removeItem('adminPassword'));
}
