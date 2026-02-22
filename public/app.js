const API = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let dmListCache = [];
let isAtBottom = true; // Для отслеживания позиции скролла

const $ = (id) => document.getElementById(id);

// Определяем мобильное устройство
const isMobile = () => window.innerWidth <= 768;

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
    
    // На мобильных показываем список чатов
    if (isMobile()) {
      showSidebar();
    }
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
  }
}

// Функции для мобильной навигации
function showSidebar() {
  const sidebar = $('sidebar');
  const chatArea = $('chat-area');
  if (isMobile()) {
    sidebar.classList.remove('mobile-hidden');
    chatArea.classList.remove('mobile-visible');
    chatArea.classList.add('mobile-hidden');
  }
}

function showChat() {
  const sidebar = $('sidebar');
  const chatArea = $('chat-area');
  if (isMobile()) {
    sidebar.classList.add('mobile-hidden');
    chatArea.classList.remove('mobile-hidden');
    chatArea.classList.add('mobile-visible');
  }
}

// Добавляем кнопку "Назад" в шапку чата
function addBackButtonToChat() {
  const chatHeader = $('chat-header');
  const backBtn = document.createElement('button');
  backBtn.className = 'btn-back';
  backBtn.innerHTML = '←';
  backBtn.setAttribute('aria-label', 'Back');
  backBtn.addEventListener('click', () => {
    showSidebar();
    // На мобильных сбрасываем активный чат
    if (isMobile()) {
      currentConversationId = null;
    }
  });
  
  // Вставляем кнопку в начало заголовка
  chatHeader.prepend(backBtn);
}

// Создаём кнопку "Прокрутить вниз"
function createScrollDownButton() {
  const chatArea = $('chat-area');
  const btn = document.createElement('button');
  btn.className = 'btn-scroll-down hidden';
  btn.innerHTML = '↓';
  btn.setAttribute('aria-label', 'Scroll to bottom');
  btn.addEventListener('click', () => {
    scrollMessagesToBottom();
    btn.classList.add('hidden');
  });
  chatArea.appendChild(btn);
  return btn;
}

const scrollDownBtn = createScrollDownButton();

// Отслеживаем скролл
function setupScrollListener() {
  const container = $('chat-messages-wrapper');
  container.addEventListener('scroll', () => {
    const threshold = 100; // пикселей от низа
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    isAtBottom = bottom;
    
    if (bottom) {
      scrollDownBtn.classList.add('hidden');
    } else {
      // Показываем кнопку только если есть сообщения и не внизу
      if ($('messages-list').children.length > 0) {
        scrollDownBtn.classList.remove('hidden');
      }
    }
  });
}

async function fetchMe() {
  try {
    const me = await api('/api/me');
    currentUser.friend_code = me.friend_code;
    localStorage.setItem('user', JSON.stringify(currentUser));
  } catch (_) {}
}

// ---- Sound notification (убрали toast) ----
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
        playNotificationSound(); // Только звук, без toast
        const convId = data.conversationId;
        const message = data.message;
        unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
        if (currentConversationId === convId && message) {
          appendMessageToChat(message);
          
          // Если пользователь был внизу, прокручиваем
          if (isAtBottom) {
            scrollMessagesToBottom();
          } else {
            // Показываем кнопку прокрутки
            scrollDownBtn.classList.remove('hidden');
          }
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

// Убираем функцию showNotificationToast, она больше не нужна

function updateBadgeFromCache() {
  // Обновляем только уведомления в списке чатов
  const total = Object.values(unreadByConvo).reduce((a, b) => a + b, 0);
  // Обновляем заголовок страницы
  if (total > 0) {
    document.title = `(${total}) Messenger`;
  } else {
    document.title = 'Messenger';
  }
}

async function loadNotificationCount() {
  if (!token) return;
  try {
    const data = await api('/api/notifications/count');
    const byConvo = await api('/api/notifications');
    unreadByConvo = byConvo;
    updateBadgeFromCache();
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
  const container = $('chat-messages-wrapper');
  if (container) {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth'
    });
    isAtBottom = true;
    scrollDownBtn.classList.add('hidden');
  }
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
  
  // На мобильных показываем чат
  if (isMobile()) {
    showChat();
  }
  
  // Сбрасываем состояние скролла
  setTimeout(() => {
    isAtBottom = true;
    scrollMessagesToBottom();
  }, 100);
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
    // Вместо toast показываем ошибку в консоли или можно добавить другое уведомление
    console.error(err.message);
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
          console.error(err.message);
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
    if (friends.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No friends yet. Share your code or add someone else\'s.';
      li.style.color = 'var(--text-muted)';
      li.style.fontStyle = 'italic';
      ul.appendChild(li);
    }
  } catch (_) {
    const li = document.createElement('li');
    li.textContent = 'Could not load friends';
    li.style.color = 'var(--text-muted)';
    li.style.fontStyle = 'italic';
    ul.appendChild(li);
  }
});

$('btn-copy-code').addEventListener('click', () => {
  const code = currentUser.friend_code;
  if (code && navigator.clipboard) {
    navigator.clipboard.writeText(code);
    // Короткое всплывающее сообщение (можно заменить на что-то другое)
    alert('Copied!');
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
    alert('Friend added');
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

// Инициализация
addBackButtonToChat();
setupScrollListener();
renderScreen();

// Обработка изменения размера окна
window.addEventListener('resize', () => {
  if (!isMobile()) {
    // На десктопе показываем всё
    const sidebar = $('sidebar');
    const chatArea = $('chat-area');
    sidebar.classList.remove('mobile-hidden');
    chatArea.classList.remove('mobile-hidden');
    chatArea.classList.remove('mobile-visible');
  } else {
    // На мобильных возвращаемся к списку чатов если нет выбранного
    if (!currentConversationId) {
      showSidebar();
    }
  }
});