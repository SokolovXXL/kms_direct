const API = window.location.origin;

let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let dmListCache = [];
let isAtBottom = true;

const $ = (id) => document.getElementById(id);

// Определяем мобильное устройство
const isMobile = () => window.innerWidth <= 768;

function show(el) {
  if (el) el.classList.remove('hidden');
}
function hide(el) {
  if (el) el.classList.add('hidden');
}

function showAuthError(msg) {
  const el = $('auth-error');
  if (el) el.textContent = msg || '';
}

// API функция с автоматической отправкой cookies
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'include', // Критически важно для отправки cookies
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Попытка автоматического входа при загрузке
async function tryAutoLogin() {
  // Если есть сохраненный пользователь, показываем интерфейс сразу
  if (currentUser) {
    renderScreen();
  }

  try {
    // Пытаемся получить актуальные данные пользователя через cookie
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('user', JSON.stringify(me));
    renderScreen();
  } catch (err) {
    // Не авторизован - очищаем сохраненные данные
    currentUser = null;
    localStorage.removeItem('user');
    renderScreen();
  }
}

function renderScreen() {
  console.log('renderScreen called', { currentUser });
  
  if (currentUser) {
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
  const layout = document.querySelector('.layout');
  if (!layout) return;
  
  layout.classList.remove('chat-open');
  
  // Сбрасываем активный чат на мобильных
  if (isMobile()) {
    currentConversationId = null;
  }
}

function showChat() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  
  layout.classList.add('chat-open');
}

// Создаём кнопку "Прокрутить вниз"
function createScrollDownButton() {
  if (document.querySelector('.btn-scroll-down')) return document.querySelector('.btn-scroll-down');
  
  const chatArea = $('chat-area');
  if (!chatArea) return null;
  
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

let scrollDownBtn = null;

// Отслеживаем скролл
function setupScrollListener() {
  const container = $('chat-messages-wrapper');
  if (!container) return;
  
  container.addEventListener('scroll', () => {
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 5;
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
const notificationAudio = new Audio('/notification.mp3');

function playNotificationSound(conversationId) {
  // Не играем звук, если чат с этим собеседником открыт
  if (conversationId && conversationId === currentConversationId) return;
  
  try {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(() => {});
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
      
      currentUser = data.user;
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
      
      currentUser = data.user;
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
  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (_) {}
    
    currentUser = null;
    localStorage.removeItem('user');
    currentConversationId = null;
    renderScreen();
  });
}

// ---- Notifications (SSE) ----
function startNotificationStream() {
  stopNotificationStream();
  if (!currentUser) return;
  
  // SSE не поддерживает credentials автоматически, поэтому используем токен в URL
  // Но можно также положить токен в cookie - он отправится автоматически
  const url = `${API}/api/notifications/stream`;
  eventSource = new EventSource(url, { withCredentials: true });
  
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'new_message') {
        const convId = data.conversationId;
        const message = data.message;
        unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
        
        playNotificationSound(convId);
        
        if (currentConversationId === convId && message) {
          appendMessageToChat(message);
        } else {
          updateSidebarRow(convId, message ? message.body : null);
        }
      }
    } catch (_) {}
  };
  
  eventSource.onerror = () => {
    // Автоматически переподключается
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
  document.title = total > 0 ? `(${total}) Messenger` : 'Messenger';
}

async function loadNotificationCount() {
  if (!currentUser) return;
  
  try {
    await api('/api/notifications/count');
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

  const container = $('chat-messages-wrapper');
  
  // Проверяем, был ли пользователь внизу до добавления сообщения
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 20;

  const div = document.createElement('div');
  div.className = 'message ' + (message.sender_id === currentUser.id ? 'mine' : 'theirs');
  div.innerHTML = `
    <div>${escapeHtml(message.body)}</div>
    <div class="message-meta">${new Date(message.created_at).toLocaleString()}</div>
  `;
  list.appendChild(div);

  // Прокручиваем вниз ТОЛЬКО если пользователь был внизу
  requestAnimationFrame(() => {
    if (wasAtBottom) {
      container.scrollTop = container.scrollHeight;
      if (scrollDownBtn) scrollDownBtn.classList.add('hidden');
    } else {
      if (scrollDownBtn) scrollDownBtn.classList.remove('hidden');
    }
  });
}

function scrollMessagesToBottom() {
  const container = $('chat-messages-wrapper');
  if (!container) return;

  container.scrollTop = container.scrollHeight;
  isAtBottom = true;

  if (scrollDownBtn) scrollDownBtn.classList.add('hidden');
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
    const [dms, notifByConvoResp] = await Promise.all([
      api('/api/dms'), 
      api('/api/notifications')
    ]);
    
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
      
      item.addEventListener('click', () => {
        selectConversation(dm.id);
        if (isMobile()) {
          setTimeout(() => showChat(), 10);
        }
      });
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
    await api('/api/notifications/read', { 
      method: 'POST', 
      body: JSON.stringify({ conversationId: convId }) 
    });
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
  
  setTimeout(() => {
    isAtBottom = true;
    scrollMessagesToBottom();
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
    
    requestAnimationFrame(() => {
      scrollMessagesToBottom();
    });
  } catch (_) {
    list.innerHTML = '<p style="color:var(--text-muted)">Could not load messages</p>';
  }
}

// Отправка сообщений
const sendForm = $('send-form');
if (sendForm) {
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentConversationId) return;

    const input = $('message-input');
    if (!input) return;

    const body = input.value.trim();
    if (!body) return;

    try {
      const msg = await api(`/api/dms/${currentConversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });

      appendMessageToChat(msg);

      // Очищаем input и возвращаем фокус
      input.value = '';
      input.focus();

      requestAnimationFrame(() => {
        scrollMessagesToBottom();
      });

      updateSidebarRow(currentConversationId, body);
      
      const dm = dmListCache.find(d => d.id === currentConversationId);
      if (dm) dm.lastMessage = body;
      
    } catch (err) {
      input.value = body;
      alert('Failed to send message: ' + err.message);
    }
  });
}

// ---- New DM modal ----
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
            const data = await api('/api/dms', { 
              method: 'POST', 
              body: JSON.stringify({ otherUserId: u.id }) 
            });
            hide($('modal-new-dm'));
            selectConversation(data.conversationId);
            if (isMobile()) {
              setTimeout(() => showChat(), 10);
            }
          } catch (err) {
            alert('Failed to create conversation: ' + err.message);
          }
        });
        li.appendChild(btn);
        ul.appendChild(li);
      }
      
      if (friends.length === 0) {
        ul.innerHTML = '<li style="color:var(--text-muted)">Add friends first (Friends → paste their code)</li>';
      }
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
      await api('/api/friends', { 
        method: 'POST', 
        body: JSON.stringify({ friendCode: code }) 
      });
      
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
      
      currentUser = null;
      localStorage.removeItem('user');
      currentConversationId = null;
      renderScreen();
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  });
}

// Обработка изменения размера окна
window.addEventListener('resize', () => {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  
  if (!isMobile()) {
    layout.classList.remove('chat-open');
  } else {
    if (!currentConversationId) {
      showSidebar();
    } else {
      showChat();
    }
  }
});

// Инициализация после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing app');
  
  scrollDownBtn = createScrollDownButton();
  setupScrollListener();
  
  // Добавляем кнопку "Назад" на мобильных
  const header = $('chat-header');
  if (header && isMobile() && !$('mobile-back-btn')) {
    const btn = document.createElement('button');
    btn.innerHTML = '←';
    btn.id = 'mobile-back-btn';
    btn.setAttribute('aria-label', 'Back');
    
    btn.style.fontSize = '26px';
    btn.style.marginRight = '12px';
    btn.style.cursor = 'pointer';
    btn.style.background = 'none';
    btn.style.border = 'none';
    btn.style.color = 'var(--text)';
    btn.style.zIndex = '999';
    btn.style.padding = '0 5px';
    btn.style.minWidth = '44px';
    btn.style.minHeight = '44px';
    
    btn.onclick = () => {
      showSidebar();
    };
    
    header.insertBefore(btn, header.firstChild);
  }
  
  // Пытаемся автоматически войти
  tryAutoLogin();
});
// ---- GROUPS ----
const btnGroups = $('btn-groups');
const btnCreateGroupBtn = $('btn-create-group-btn');
const modalCreateGroup = $('modal-create-group');
const modalGroupInfo = $('modal-group-info');
const modalAddMember = $('modal-add-member');

// Open groups list modal
if (btnGroups) {
  btnGroups.addEventListener('click', async () => {
    show($('modal-groups-list'));
    await loadGroupsList();
  });
}

// Create group button in sidebar
if (btnCreateGroupBtn) {
  btnCreateGroupBtn.addEventListener('click', async () => {
    show(modalCreateGroup);
    await loadFriendsForGroup();
  });
}

// Close group modal
const btnCloseGroup = $('btn-close-group');
if (btnCloseGroup) {
  btnCloseGroup.addEventListener('click', () => hide(modalCreateGroup));
}

if (modalCreateGroup) {
  modalCreateGroup.addEventListener('click', (e) => {
    if (e.target.id === 'modal-create-group') hide(modalCreateGroup);
  });
}

// Load friends for group creation
async function loadFriendsForGroup() {
  const list = $('group-friends-list');
  if (!list) return;
  
  list.innerHTML = '';
  $('group-error').textContent = '';
  $('group-title').value = '';
  
  try {
    const friends = await api('/api/friends');
    
    if (friends.length === 0) {
      list.innerHTML = '<li style="color:var(--text-muted); padding:1rem;">Add friends first</li>';
      return;
    }
    
    friends.forEach(friend => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.padding = '0.5rem 1rem';
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = friend.id;
      checkbox.id = `friend-${friend.id}`;
      checkbox.style.marginRight = '0.75rem';
      checkbox.style.width = '18px';
      checkbox.style.height = '18px';
      
      const label = document.createElement('label');
      label.htmlFor = `friend-${friend.id}`;
      label.textContent = friend.username;
      label.style.flex = '1';
      label.style.cursor = 'pointer';
      
      li.appendChild(checkbox);
      li.appendChild(label);
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = '<li style="color:var(--danger);">Failed to load friends</li>';
  }
}

// Create group
const btnCreateGroup = $('btn-create-group');
if (btnCreateGroup) {
  btnCreateGroup.addEventListener('click', async () => {
    const title = $('group-title').value.trim();
    const checkboxes = document.querySelectorAll('#group-friends-list input[type="checkbox"]:checked');
    const userIds = Array.from(checkboxes).map(cb => parseInt(cb.value, 10));
    const errorEl = $('group-error');
    
    if (!title) {
      errorEl.textContent = 'Group name required';
      return;
    }
    
    if (userIds.length === 0) {
      errorEl.textContent = 'Select at least one friend';
      return;
    }
    
    try {
      const data = await api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ title, userIds })
      });
      
      hide(modalCreateGroup);
      await loadDmList(); // Reload conversations
      
      // Open the new group
      selectConversation(data.conversationId);
      if (isMobile()) showChat();
      
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

// Update conversation list to show groups
// Modify the render function in loadDmList
// Find where you create dm-item and replace with:

// In loadDmList function, replace the item creation part with:
/*
for (const dm of dms) {
  const unread = notifByConvoResp[dm.id] || 0;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'dm-item' + (dm.id === currentConversationId ? ' active' : '');
  item.dataset.id = dm.id;
  
  let nameHtml = '';
  if (dm.isGroup) {
    nameHtml = `<span class="dm-name">👥 ${escapeHtml(dm.title)}</span>`;
  } else {
    nameHtml = `<span class="dm-name">${escapeHtml(dm.otherUser?.username || 'Unknown')}</span>`;
  }
  
  item.innerHTML = `
    <div style="flex:1;min-width:0;">
      ${nameHtml}
      <span class="dm-preview">${escapeHtml(dm.lastMessage || 'No messages yet')}</span>
    </div>
    ${unread > 0 ? `<span class="dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
  `;
  
  item.addEventListener('click', () => {
    selectConversation(dm.id);
    if (dm.isGroup) {
      // Show group info button in header
      showGroupInfoButton(dm.id, dm.title);
    } else {
      hideGroupInfoButton();
    }
    if (isMobile()) setTimeout(() => showChat(), 10);
  });
  list.appendChild(item);
}
*/

// But since we can't replace the whole function, let's add a patch
// Add this after loadDmList function definition:

// Patch the existing loadDmList function
const originalLoadDmList = loadDmList;
loadDmList = async function() {
  const list = $('dm-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  try {
    const [dms, notifByConvoResp] = await Promise.all([
      api('/api/conversations'), // Use new endpoint that includes groups
      api('/api/notifications')
    ]);
    
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
      
      let nameHtml = '';
      if (dm.isGroup) {
        nameHtml = `<span class="dm-name">👥 ${escapeHtml(dm.title)}</span>`;
      } else {
        nameHtml = `<span class="dm-name">${escapeHtml(dm.otherUser?.username || 'Unknown')}</span>`;
      }
      
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          ${nameHtml}
          <span class="dm-preview">${escapeHtml(dm.lastMessage || 'No messages yet')}</span>
        </div>
        ${unread > 0 ? `<span class="dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      `;
      
      item.addEventListener('click', () => {
        selectConversation(dm.id);
        if (dm.isGroup) {
          showGroupInfoButton(dm.id, dm.title);
        } else {
          hideGroupInfoButton();
        }
        if (isMobile()) setTimeout(() => showChat(), 10);
      });
      list.appendChild(item);
    }
    updateBadgeFromCache();
  } catch (err) {
    console.error('Failed to load conversations:', err);
    list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Could not load conversations</p>';
  }
};

// Group info button in chat header
function showGroupInfoButton(groupId, groupTitle) {
  const header = $('chat-header');
  if (!header) return;
  
  // Remove existing info button if any
  const oldBtn = document.getElementById('group-info-btn');
  if (oldBtn) oldBtn.remove();
  
  const btn = document.createElement('button');
  btn.id = 'group-info-btn';
  btn.innerHTML = 'ℹ️';
  btn.style.marginLeft = 'auto';
  btn.style.background = 'none';
  btn.style.border = 'none';
  btn.style.color = 'var(--text-muted)';
  btn.style.fontSize = '1.2rem';
  btn.style.cursor = 'pointer';
  btn.style.padding = '0 10px';
  btn.title = 'Group info';
  
  btn.addEventListener('click', () => showGroupInfo(groupId, groupTitle));
  
  header.appendChild(btn);
}

function hideGroupInfoButton() {
  const btn = document.getElementById('group-info-btn');
  if (btn) btn.remove();
}

// Show group info modal
async function showGroupInfo(groupId, groupTitle) {
  const modal = $('modal-group-info');
  const titleEl = $('group-info-title');
  const listEl = $('group-members-list');
  
  if (!modal || !titleEl || !listEl) return;
  
  titleEl.textContent = groupTitle || 'Group';
  listEl.innerHTML = '<li style="color:var(--text-muted);">Loading...</li>';
  
  show(modal);
  
  try {
    const group = await api(`/api/groups/${groupId}`);
    
    listEl.innerHTML = '';
    group.participants.forEach(member => {
      const li = document.createElement('li');
      li.textContent = member.username + (member.id === currentUser.id ? ' (you)' : '');
      listEl.appendChild(li);
    });
    
    // Store groupId for add member button
    const addBtn = $('btn-add-member');
    if (addBtn) {
      addBtn.dataset.groupId = groupId;
      addBtn.dataset.groupTitle = groupTitle;
    }
    
  } catch (err) {
    listEl.innerHTML = `<li style="color:var(--danger);">Failed to load members</li>`;
  }
}

// Close group info modal
const btnCloseGroupInfo = $('btn-close-group-info');
if (btnCloseGroupInfo) {
  btnCloseGroupInfo.addEventListener('click', () => hide(modalGroupInfo));
}

if (modalGroupInfo) {
  modalGroupInfo.addEventListener('click', (e) => {
    if (e.target.id === 'modal-group-info') hide(modalGroupInfo);
  });
}

// Add member button
const btnAddMember = $('btn-add-member');
if (btnAddMember) {
  btnAddMember.addEventListener('click', async () => {
    const groupId = btnAddMember.dataset.groupId;
    const groupTitle = btnAddMember.dataset.groupTitle;
    
    if (!groupId) return;
    
    hide(modalGroupInfo);
    await loadFriendsToAdd(groupId, groupTitle);
    show(modalAddMember);
  });
}

// Load friends that are not in group
async function loadFriendsToAdd(groupId, groupTitle) {
  const list = $('add-member-list');
  if (!list) return;
  
  list.innerHTML = '<li style="color:var(--text-muted);">Loading...</li>';
  $('add-member-error').textContent = '';
  
  try {
    const [friends, group] = await Promise.all([
      api('/api/friends'),
      api(`/api/groups/${groupId}`)
    ]);
    
    const memberIds = group.participants.map(p => p.id);
    const availableFriends = friends.filter(f => !memberIds.includes(f.id));
    
    if (availableFriends.length === 0) {
      list.innerHTML = '<li style="color:var(--text-muted);">All friends are already in group</li>';
      return;
    }
    
    list.innerHTML = '';
    availableFriends.forEach(friend => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = friend.username;
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/groups/${groupId}/members`, {
            method: 'POST',
            body: JSON.stringify({ userId: friend.id })
          });
          
          hide(modalAddMember);
          showGroupInfo(groupId, groupTitle); // Refresh info
        } catch (err) {
          $('add-member-error').textContent = err.message;
        }
      });
      
      li.appendChild(btn);
      list.appendChild(li);
    });
    
  } catch (err) {
    list.innerHTML = `<li style="color:var(--danger);">Failed to load friends</li>`;
  }
}

// Close add member modal
const btnCloseAddMember = $('btn-close-add-member');
if (btnCloseAddMember) {
  btnCloseAddMember.addEventListener('click', () => hide(modalAddMember));
}

if (modalAddMember) {
  modalAddMember.addEventListener('click', (e) => {
    if (e.target.id === 'modal-add-member') hide(modalAddMember);
  });
}