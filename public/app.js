const API = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let dmListCache = [];
let isAtBottom = true;
let scrollThreshold = 300; // Увеличиваем порог для определения "внизу"

const $ = (id) => document.getElementById(id);

// Определяем мобильное устройство
const isMobile = () => window.innerWidth <= 768;

function show(el) {
  if (el) el.classList.remove('hidden');
}
function hide(el) {
  if (el) el.classList.add('hidden');
}

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

function showAuthError(msg) {
  const el = $('auth-error');
  if (el) el.textContent = msg || '';
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
  console.log('renderScreen called', { token, currentUser });
  if (token && currentUser) {
    hide($('auth-screen'));
    show($('main-screen'));
    const headerUsername = $('header-username');
    if (headerUsername) headerUsername.textContent = currentUser.username;
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
  if (!sidebar || !chatArea) return;
  
  if (isMobile()) {
    sidebar.classList.remove('mobile-hidden');
    chatArea.classList.remove('mobile-visible');
    chatArea.classList.add('mobile-hidden');
  }
}

function showChat() {
  const sidebar = $('sidebar');
  const chatArea = $('chat-area');
  if (!sidebar || !chatArea) return;
  
  if (isMobile()) {
    sidebar.classList.add('mobile-hidden');
    chatArea.classList.remove('mobile-hidden');
    chatArea.classList.add('mobile-visible');
  }
}

// Добавляем кнопку "Назад" в шапку чата
function addBackButtonToChat() {
  const chatHeader = $('chat-header');
  if (!chatHeader) return;
  
  // Проверяем, не добавлена ли уже кнопка
  if (chatHeader.querySelector('.btn-back')) return;
  
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
  // Проверяем, не создана ли уже кнопка
  if (document.querySelector('.btn-scroll-down')) return document.querySelector('.btn-scroll-down');
  
  const chatArea = $('chat-area');
  if (!chatArea) {
    console.log('Chat area not found yet, will create button later');
    return null;
  }
  
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

// Инициализируем кнопку после загрузки DOM
let scrollDownBtn = null;

// Отслеживаем скролл
function setupScrollListener() {
  const container = $('chat-messages-wrapper');
  if (!container) return;
  
  container.addEventListener('scroll', () => {
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < scrollThreshold;
    isAtBottom = bottom;
    
    if (bottom) {
      if (scrollDownBtn) scrollDownBtn.classList.add('hidden');
    } else {
      if (scrollDownBtn && $('messages-list').children.length > 0) {
        scrollDownBtn.classList.remove('hidden');
      }
    }
  });
}

async function fetchMe() {
  try {
    const me = await api('/api/me');
    if (currentUser) {
      currentUser.friend_code = me.friend_code;
      localStorage.setItem('user', JSON.stringify(currentUser));
    }
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
const loginForm = $('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
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
}

const registerForm = $('register-form');
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
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
}

const logoutBtn = $('btn-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    currentConversationId = null;
    renderScreen();
  });
}

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
        playNotificationSound();
        const convId = data.conversationId;
        const message = data.message;
        unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
        
        if (currentConversationId === convId && message) {
          appendMessageToChat(message);
          
          // Проверяем, находится ли пользователь внизу чата
          const container = $('chat-messages-wrapper');
          if (container) {
            // Увеличиваем порог до 300px для более агрессивной прокрутки
            const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < scrollThreshold;
            
            if (bottom) {
              // Если пользователь близко к низу, прокручиваем вниз
              setTimeout(() => {
                scrollMessagesToBottom();
              }, 50); // Небольшая задержка для гарантии
            } else {
              // Если не внизу, показываем кнопку прокрутки
              if (scrollDownBtn) scrollDownBtn.classList.remove('hidden');
            }
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

function updateBadgeFromCache() {
  const total = Object.values(unreadByConvo).reduce((a, b) => a + b, 0);
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
  if (!list) return;
  
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
    if (scrollDownBtn) scrollDownBtn.classList.add('hidden');
  }
}

function forceScrollToBottom() {
  const container = $('chat-messages-wrapper');
  if (container) {
    container.scrollTop = container.scrollHeight;
    isAtBottom = true;
    if (scrollDownBtn) scrollDownBtn.classList.add('hidden');
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
  if (!list) return;
  
  list.innerHTML = '';
  try {
    const [dms, notifByConvoResp] = await Promise.all([api('/api/dms'), api('/api/notifications')]);
    unreadByConvo = notifByConvoResp;
    dmListCache = dms;
    
    if (dms.length === 0) {
      list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">No conversations yet. Start a new message!</p>';
      return;
    }
    
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
  } catch (err) {
    console.error('Failed to load DMs:', err);
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
  
  const chatPlaceholder = $('chat-placeholder');
  const chatActive = $('chat-active');
  const chatWithName = $('chat-with-name');
  
  if (chatPlaceholder) hide(chatPlaceholder);
  if (chatActive) show(chatActive);
  if (chatWithName) chatWithName.textContent = dm ? dm.otherUser.username : '…';
  
  document.querySelectorAll('.dm-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id, 10) === convId);
  });
  loadMessages(convId);
  
  if (isMobile()) {
    showChat();
  }
  
  // Принудительная прокрутка вниз при выборе чата
  setTimeout(() => {
    isAtBottom = true;
    forceScrollToBottom();
  }, 200);
}

async function loadMessages(convId) {
  const list = $('messages-list');
  if (!list) return;
  
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
    // Принудительная прокрутка вниз после загрузки сообщений
    setTimeout(() => {
      forceScrollToBottom();
    }, 100);
  } catch (_) {
    list.innerHTML = '<p style="color:var(--text-muted)">Could not load messages</p>';
  }
}

const sendForm = $('send-form');
if (sendForm) {
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentConversationId) return;
    const input = $('message-input');
    if (!input) return;
    
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try {
      const msg = await api(`/api/dms/${currentConversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      appendMessageToChat(msg);
      // Принудительная прокрутка вниз после отправки
      setTimeout(() => {
        forceScrollToBottom();
      }, 50);
      updateSidebarRow(currentConversationId, body);
      const dm = dmListCache.find(d => d.id === currentConversationId);
      if (dm) dm.lastMessage = body;
    } catch (err) {
      input.value = body;
      alert('Failed to send message: ' + err.message);
    }
  });
}

// ---- New DM modal (friends only) ----
const btnNewDm = $('btn-new-dm');
if (btnNewDm) {
  btnNewDm.addEventListener('click', async () => {
    show($('modal-new-dm'));
    const ul = $('user-list');
    if (!ul) return;
    
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
            alert('Failed to create conversation: ' + err.message);
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
}

const btnCloseModal = $('btn-close-modal');
if (btnCloseModal) {
  btnCloseModal.addEventListener('click', () => hide($('modal-new-dm')));
}

const modalNewDm = $('modal-new-dm');
if (modalNewDm) {
  modalNewDm.addEventListener('click', (e) => {
    if (e.target.id === 'modal-new-dm') hide($('modal-new-dm'));
  });
}

// ---- Friends modal ----
const btnFriends = $('btn-friends');
if (btnFriends) {
  btnFriends.addEventListener('click', async () => {
    show($('modal-friends'));
    
    const friendsError = $('friends-error');
    const myFriendCode = $('my-friend-code');
    const friendCodeInput = $('friend-code-input');
    const friendsList = $('friends-list');
    
    if (friendsError) friendsError.textContent = '';
    if (myFriendCode) myFriendCode.textContent = currentUser?.friend_code || '…';
    if (friendCodeInput) friendCodeInput.value = '';
    if (!friendsList) return;
    
    friendsList.innerHTML = '';
    try {
      const friends = await api('/api/friends');
      for (const u of friends) {
        const li = document.createElement('li');
        li.textContent = u.username;
        friendsList.appendChild(li);
      }
      if (friends.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No friends yet. Share your code or add someone else\'s.';
        li.style.color = 'var(--text-muted)';
        li.style.fontStyle = 'italic';
        friendsList.appendChild(li);
      }
    } catch (_) {
      const li = document.createElement('li');
      li.textContent = 'Could not load friends';
      li.style.color = 'var(--text-muted)';
      li.style.fontStyle = 'italic';
      friendsList.appendChild(li);
    }
  });
}

const btnCopyCode = $('btn-copy-code');
if (btnCopyCode) {
  btnCopyCode.addEventListener('click', () => {
    const code = currentUser?.friend_code;
    if (code && navigator.clipboard) {
      navigator.clipboard.writeText(code);
      alert('Copied!');
    }
  });
}

const btnAddFriend = $('btn-add-friend');
if (btnAddFriend) {
  btnAddFriend.addEventListener('click', async () => {
    const code = $('friend-code-input')?.value.trim();
    const errEl = $('friends-error');
    if (!errEl) return;
    
    errEl.textContent = '';
    if (!code) {
      errEl.textContent = 'Enter a friend code';
      return;
    }
    try {
      await api('/api/friends', { method: 'POST', body: JSON.stringify({ friendCode: code }) });
      if ($('friend-code-input')) $('friend-code-input').value = '';
      errEl.textContent = '';
      alert('Friend added');
      const friends = await api('/api/friends');
      const ul = $('friends-list');
      if (ul) {
        ul.innerHTML = '';
        for (const u of friends) {
          const li = document.createElement('li');
          li.textContent = u.username;
          ul.appendChild(li);
        }
      }
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  });
}

const btnCloseFriends = $('btn-close-friends');
if (btnCloseFriends) {
  btnCloseFriends.addEventListener('click', () => hide($('modal-friends')));
}

const modalFriends = $('modal-friends');
if (modalFriends) {
  modalFriends.addEventListener('click', (e) => {
    if (e.target.id === 'modal-friends') hide($('modal-friends'));
  });
}

// ---- Delete account ----
const btnDeleteAccount = $('btn-delete-account');
if (btnDeleteAccount) {
  btnDeleteAccount.addEventListener('click', () => {
    hide($('modal-friends'));
    show($('modal-delete-confirm'));
    const deletePassword = $('delete-password');
    const deleteError = $('delete-error');
    if (deletePassword) deletePassword.value = '';
    if (deleteError) deleteError.textContent = '';
  });
}

const btnCancelDelete = $('btn-cancel-delete');
if (btnCancelDelete) {
  btnCancelDelete.addEventListener('click', () => hide($('modal-delete-confirm')));
}

const modalDeleteConfirm = $('modal-delete-confirm');
if (modalDeleteConfirm) {
  modalDeleteConfirm.addEventListener('click', (e) => {
    if (e.target.id === 'modal-delete-confirm') hide($('modal-delete-confirm'));
  });
}

const btnConfirmDelete = $('btn-confirm-delete');
if (btnConfirmDelete) {
  btnConfirmDelete.addEventListener('click', async () => {
    const password = $('delete-password')?.value;
    const errEl = $('delete-error');
    if (!errEl) return;
    
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
}

// Инициализация после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing app');
  
  // Создаём кнопку прокрутки
  scrollDownBtn = createScrollDownButton();
  
  // Добавляем кнопку назад
  addBackButtonToChat();
  
  // Настраиваем слушатель скролла
  setupScrollListener();
  
  // Рендерим экран
  renderScreen();
});

// Обработка изменения размера окна
window.addEventListener('resize', () => {
  if (!isMobile()) {
    const sidebar = $('sidebar');
    const chatArea = $('chat-area');
    if (sidebar && chatArea) {
      sidebar.classList.remove('mobile-hidden');
      chatArea.classList.remove('mobile-hidden');
      chatArea.classList.remove('mobile-visible');
    }
  } else {
    if (!currentConversationId) {
      showSidebar();
    }
  }
});