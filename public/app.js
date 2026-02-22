const API = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};

const $ = (id) => document.getElementById(id);

function show(el) {
  el.classList.remove('hidden');
}
function hide(el) {
  el.classList.add('hidden');
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function showAuthError(msg) {
  const el = $('auth-error');
  el.textContent = msg || '';
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = res.ok ? await res.json().catch(() => ({})) : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderScreen() {
  if (token && currentUser) {
    hide($('auth-screen'));
    show($('main-screen'));
    $('header-username').textContent = currentUser.username;
    startNotificationStream();
    loadDmList();
    loadNotificationCount();
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
  }
}

// ---- Auth ----
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('login-username').value.trim(),
        password: $('login-password').value,
      }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    $('login-password').value = '';
    renderScreen();
  } catch (err) {
    showAuthError(err.message);
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError('');
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('register-username').value.trim(),
        password: $('register-password').value,
      }),
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    $('register-password').value = '';
    renderScreen();
  } catch (err) {
    showAuthError(err.message);
  }
});

$('btn-logout').addEventListener('click', () => {
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  currentConversationId = null;
  renderScreen();
});

// ---- Notifications (SSE) ----
function startNotificationStream() {
  stopNotificationStream();
  if (!token) return;
  const url = `${API}/api/notifications/stream?token=${encodeURIComponent(token)}`;
  eventSource = new EventSource(url);
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'new_message') {
        loadNotificationCount();
        showNotificationToast('New message');
        if (currentConversationId !== data.conversationId) loadDmList();
        else loadMessages(currentConversationId);
      }
    } catch (_) {}
  };
}

function stopNotificationStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function showNotificationToast(text) {
  const toast = $('notification-toast');
  toast.textContent = text;
  show(toast);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(toast), 3000);
}

async function loadNotificationCount() {
  if (!token) return;
  try {
    const data = await api('/api/notifications/count');
    const badge = $('notification-badge');
    if (data.count > 0) {
      badge.textContent = data.count > 99 ? '99+' : data.count;
      show(badge);
    } else {
      hide(badge);
    }
  } catch (_) {}
}

// ---- DMs ----
async function loadDmList() {
  const list = $('dm-list');
  list.innerHTML = '';
  try {
    const [dms, notifByConvo] = await Promise.all([api('/api/dms'), api('/api/notifications')]);
    for (const dm of dms) {
      const unread = notifByConvo[dm.id] || 0;
      unreadByConvo[dm.id] = unread;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dm-item' + (dm.id === currentConversationId ? ' active' : '');
      item.dataset.id = dm.id;
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <span class="dm-name">${escapeHtml(dm.otherUser.username)}</span>
          <span class="dm-preview">${escapeHtml(dm.lastMessage || 'No messages yet')}</span>
        </div>
        ${unread > 0 ? `<span class="dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      `;
      item.addEventListener('click', () => selectConversation(dm.id));
      list.appendChild(item);
    }
    loadNotificationCount();
  } catch (_) {
    list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Could not load conversations</p>';
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function selectConversation(convId) {
  currentConversationId = convId;
  try {
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ conversationId: convId }) });
  } catch (_) {}
  unreadByConvo[convId] = 0;
  loadNotificationCount();
  loadDmList();
  const dms = await api('/api/dms').catch(() => []);
  const dm = dms.find(d => d.id === convId);
  hide($('chat-placeholder'));
  show($('chat-active'));
  $('chat-with-name').textContent = dm ? dm.otherUser.username : '…';
  loadMessages(convId);
}

async function loadMessages(convId) {
  const list = $('messages-list');
  list.innerHTML = '';
  try {
    const messages = await api(`/api/dms/${convId}/messages`);
    for (const m of messages) {
      const div = document.createElement('div');
      div.className = 'message ' + (m.sender_id === currentUser.id ? 'mine' : 'theirs');
      div.innerHTML = `
        <div>${escapeHtml(m.body)}</div>
        <div class="message-meta">${new Date(m.created_at).toLocaleString()}</div>
      `;
      list.appendChild(div);
    }
    list.parentElement.scrollTop = list.parentElement.scrollHeight;
  } catch (_) {
    list.innerHTML = '<p style="color:var(--text-muted)">Could not load messages</p>';
  }
}

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentConversationId) return;
  const input = $('message-input');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  try {
    await api(`/api/dms/${currentConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    loadMessages(currentConversationId);
    loadDmList();
  } catch (err) {
    input.value = body;
    showNotificationToast(err.message || 'Failed to send');
  }
});

// ---- New DM modal ----
$('btn-new-dm').addEventListener('click', async () => {
  show($('modal-new-dm'));
  const ul = $('user-list');
  ul.innerHTML = '';
  try {
    const users = await api('/api/users');
    for (const u of users) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = u.username;
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ otherUserId: u.id }) });
          hide($('modal-new-dm'));
          selectConversation(data.conversationId);
        } catch (_) {}
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  } catch (_) {
    ul.innerHTML = '<li style="color:var(--text-muted)">Could not load users</li>';
  }
});

$('btn-close-modal').addEventListener('click', () => hide($('modal-new-dm')));

$('modal-new-dm').addEventListener('click', (e) => {
  if (e.target.id === 'modal-new-dm') hide($('modal-new-dm'));
});

// Unread per-conversation: we don't have an API for it; use count and mark read when opening. Badge is global.
// Init
renderScreen();
