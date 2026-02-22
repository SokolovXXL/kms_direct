const API = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let dmListCache = [];

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
    if (!currentUser.friend_code) fetchMe();
    startNotificationStream();
    loadDmList();
    loadNotificationCount();
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
  }
}

async function fetchMe() {
  try {
    const me = await api('/api/me');
    currentUser.friend_code = me.friend_code;
    localStorage.setItem('user', JSON.stringify(currentUser));
  } catch (_) {}
}

// ---- Sound notification ----
let audioCtx = null;
function playNotificationSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (_) {}
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

// ---- Notifications (SSE): incremental updates, no full reload ----
function startNotificationStream() {
  stopNotificationStream();
  if (!token) return;
  const url = `${API}/api/notifications/stream?token=${encodeURIComponent(token)}`;
  eventSource = new EventSource(url);
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'new_message') {
        playNotificationSound();
        showNotificationToast('New message');
        const convId = data.conversationId;
        const message = data.message;
        unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
        updateBadgeFromCache();
        if (currentConversationId === convId && message) {
          appendMessageToChat(message);
          scrollMessagesToBottom();
        } else {
          updateSidebarRow(convId, message ? message.body : null);
        }
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

function updateBadgeFromCache() {
  const total = Object.values(unreadByConvo).reduce((a, b) => a + b, 0);
  const badge = $('notification-badge');
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : total;
    show(badge);
  } else {
    hide(badge);
  }
}

async function loadNotificationCount() {
  if (!token) return;
  try {
    const data = await api('/api/notifications/count');
    const byConvo = await api('/api/notifications');
    unreadByConvo = byConvo;
    const badge = $('notification-badge');
    if (data.count > 0) {
      badge.textContent = data.count > 99 ? '99+' : data.count;
      show(badge);
    } else {
      hide(badge);
    }
  } catch (_) {}
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function appendMessageToChat(message) {
  const list = $('messages-list');
  const div = document.createElement('div');
  div.className = 'message ' + (message.sender_id === currentUser.id ? 'mine' : 'theirs');
  div.innerHTML = `
    <div>${escapeHtml(message.body)}</div>
    <div class="message-meta">${new Date(message.created_at).toLocaleString()}</div>
  `;
  list.appendChild(div);
}

function scrollMessagesToBottom() {
  const container = $('messages-container');
  if (container) container.scrollTop = container.scrollHeight;
}

function updateSidebarRow(convId, lastMessageText) {
  const btn = document.querySelector(`.dm-item[data-id="${convId}"]`);
  if (!btn) return;
  const preview = btn.querySelector('.dm-preview');
  if (preview) preview.textContent = lastMessageText || 'No messages yet';
  let unreadEl = btn.querySelector('.dm-unread');
  const unread = unreadByConvo[convId] || 0;
  if (unread > 0) {
    if (!unreadEl) {
      unreadEl = document.createElement('span');
      unreadEl.className = 'dm-unread';
      btn.appendChild(unreadEl);
    }
    unreadEl.textContent = unread > 99 ? '99+' : unread;
  } else if (unreadEl) {
    unreadEl.remove();
  }
}

// ---- DMs ----
async function loadDmList() {
  const list = $('dm-list');
  list.innerHTML = '';
  try {
    const [dms, notifByConvoResp] = await Promise.all([api('/api/dms'), api('/api/notifications')]);
    unreadByConvo = notifByConvoResp;
    dmListCache = dms;
    for (const dm of dms) {
      const unread = notifByConvoResp[dm.id] || 0;
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
    updateBadgeFromCache();
  } catch (_) {
    list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Could not load conversations</p>';
  }
}

async function selectConversation(convId) {
  currentConversationId = convId;
  try {
    await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ conversationId: convId }) });
  } catch (_) {}
  unreadByConvo[convId] = 0;
  updateBadgeFromCache();
  updateSidebarRow(convId, null);
  let dm = dmListCache.find(d => d.id === convId);
  if (!dm) {
    await loadDmList();
    dm = dmListCache.find(d => d.id === convId);
  }
  hide($('chat-placeholder'));
  show($('chat-active'));
  $('chat-with-name').textContent = dm ? dm.otherUser.username : '…';
  document.querySelectorAll('.dm-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id, 10) === convId);
  });
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
    scrollMessagesToBottom();
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
    const msg = await api(`/api/dms/${currentConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    appendMessageToChat(msg);
    scrollMessagesToBottom();
    updateSidebarRow(currentConversationId, body);
    const dm = dmListCache.find(d => d.id === currentConversationId);
    if (dm) dm.lastMessage = body;
  } catch (err) {
    input.value = body;
    showNotificationToast(err.message || 'Failed to send');
  }
});

// ---- New DM modal (friends only) ----
$('btn-new-dm').addEventListener('click', async () => {
  show($('modal-new-dm'));
  const ul = $('user-list');
  ul.innerHTML = '';
  try {
    const friends = await api('/api/friends');
    for (const u of friends) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = u.username;
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ otherUserId: u.id }) });
          hide($('modal-new-dm'));
          selectConversation(data.conversationId);
        } catch (err) {
          showNotificationToast(err.message || 'Failed');
        }
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    if (friends.length === 0) ul.innerHTML = '<li style="color:var(--text-muted)">Add friends first (Friends → paste their code)</li>';
  } catch (_) {
    ul.innerHTML = '<li style="color:var(--text-muted)">Could not load friends</li>';
  }
});

$('btn-close-modal').addEventListener('click', () => hide($('modal-new-dm')));

$('modal-new-dm').addEventListener('click', (e) => {
  if (e.target.id === 'modal-new-dm') hide($('modal-new-dm'));
});

// ---- Friends modal ----
$('btn-friends').addEventListener('click', async () => {
  show($('modal-friends'));
  $('friends-error').textContent = '';
  $('my-friend-code').textContent = currentUser.friend_code || '…';
  $('friend-code-input').value = '';
  const ul = $('friends-list');
  ul.innerHTML = '';
  try {
    const friends = await api('/api/friends');
    for (const u of friends) {
      const li = document.createElement('li');
      li.textContent = u.username;
      ul.appendChild(li);
    }
    if (friends.length === 0) ul.innerHTML = '<li style="color:var(--text-muted)">No friends yet. Share your code or add someone else\'s.</li>';
  } catch (_) {
    ul.innerHTML = '<li style="color:var(--text-muted)">Could not load</li>';
  }
});

$('btn-copy-code').addEventListener('click', () => {
  const code = currentUser.friend_code;
  if (code && navigator.clipboard) {
    navigator.clipboard.writeText(code);
    showNotificationToast('Copied!');
  }
});

$('btn-add-friend').addEventListener('click', async () => {
  const code = $('friend-code-input').value.trim();
  const errEl = $('friends-error');
  errEl.textContent = '';
  if (!code) {
    errEl.textContent = 'Enter a friend code';
    return;
  }
  try {
    await api('/api/friends', { method: 'POST', body: JSON.stringify({ friendCode: code }) });
    $('friend-code-input').value = '';
    errEl.textContent = '';
    showNotificationToast('Friend added');
    const friends = await api('/api/friends');
    const ul = $('friends-list');
    ul.innerHTML = '';
    for (const u of friends) {
      const li = document.createElement('li');
      li.textContent = u.username;
      ul.appendChild(li);
    }
  } catch (err) {
    errEl.textContent = err.message || 'Failed';
  }
});

$('btn-close-friends').addEventListener('click', () => hide($('modal-friends')));
$('modal-friends').addEventListener('click', (e) => {
  if (e.target.id === 'modal-friends') hide($('modal-friends'));
});

// ---- Delete account ----
$('btn-delete-account').addEventListener('click', () => {
  hide($('modal-friends'));
  show($('modal-delete-confirm'));
  $('delete-password').value = '';
  $('delete-error').textContent = '';
});

$('btn-cancel-delete').addEventListener('click', () => hide($('modal-delete-confirm')));
$('modal-delete-confirm').addEventListener('click', (e) => {
  if (e.target.id === 'modal-delete-confirm') hide($('modal-delete-confirm'));
});

$('btn-confirm-delete').addEventListener('click', async () => {
  const password = $('delete-password').value;
  const errEl = $('delete-error');
  errEl.textContent = '';
  if (!password) {
    errEl.textContent = 'Enter your password';
    return;
  }
  try {
    await api('/api/account', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    hide($('modal-delete-confirm'));
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    currentConversationId = null;
    renderScreen();
  } catch (err) {
    errEl.textContent = err.message || 'Failed';
  }
});

renderScreen();
