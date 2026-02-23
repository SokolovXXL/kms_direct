const API = window.location.origin;

let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let conversationListCache = [];
let isAtBottom = true;
let currentConversationIsGroup = false;

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
    credentials: 'include',
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
  if (currentUser) {
    renderScreen();
  }

  try {
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('user', JSON.stringify(me));
    renderScreen();
  } catch (err) {
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
    loadConversationList();
    loadNotificationCount();
    
    if (isMobile()) {
      showSidebar();
    }
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
  }
}

function showSidebar() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  
  layout.classList.remove('chat-open');
  
  if (isMobile()) {
    currentConversationId = null;
  }
}

function showChat() {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  
  layout.classList.add('chat-open');
}

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

const notificationAudio = new Audio('/notification.mp3');

function playNotificationSound(conversationId) {
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
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  
  if (!currentUser) return;
  
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
      } else if (data.type === 'new_group') {
        // Обновляем список разговоров при создании новой группы
        loadConversationList();
      } else if (data.type === 'added_to_group') {
        // Обновляем список при добавлении в группу
        loadConversationList();
      }
    } catch (_) {}
  };
  
  eventSource.onerror = () => {
    // Auto-reconnect
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

// Исправленная функция добавления сообщения с поддержкой групп
function appendMessageToChat(message) {
  const list = $('messages-list');
  if (!list) return;

  const container = $('chat-messages-wrapper');
  
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 20;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ' + (message.sender_id === currentUser.id ? 'mine' : 'theirs');
  
  // Для групп показываем имя отправителя (кроме своих сообщений)
  if (currentConversationIsGroup && message.sender_id !== currentUser.id) {
    const nameSpan = document.createElement('div');
    nameSpan.className = 'message-sender';
    nameSpan.textContent = message.sender_username || 'Unknown';
    messageDiv.appendChild(nameSpan);
  }
  
  const bodyDiv = document.createElement('div');
  bodyDiv.textContent = message.body;
  messageDiv.appendChild(bodyDiv);
  
  const metaDiv = document.createElement('div');
  metaDiv.className = 'message-meta';
  metaDiv.textContent = new Date(message.created_at).toLocaleString();
  messageDiv.appendChild(metaDiv);
  
  list.appendChild(messageDiv);

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

// ---- Conversations List ----
async function loadConversationList() {
  const list = $('dm-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  try {
    const [conversations, notifByConvoResp] = await Promise.all([
      api('/api/conversations'),
      api('/api/notifications')
    ]);
    
    unreadByConvo = notifByConvoResp;
    conversationListCache = conversations;
    
    if (conversations.length === 0) {
      list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">No conversations yet. Start a new message!</p>';
      return;
    }
    
    for (const conv of conversations) {
      const unread = notifByConvoResp[conv.id] || 0;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dm-item' + (conv.id === currentConversationId ? ' active' : '');
      item.dataset.id = conv.id;
      
      let nameHtml = '';
      let previewText = conv.lastMessage || 'No messages yet';
      
      if (conv.isGroup) {
        // Для групп показываем иконку и название
        nameHtml = `<span class="dm-name">👥 ${escapeHtml(conv.title || 'Group')}</span>`;
      } else {
        // Для личных чатов показываем имя собеседника
        const otherUserName = conv.otherUser?.username || 'Unknown';
        nameHtml = `<span class="dm-name">${escapeHtml(otherUserName)}</span>`;
      }
      
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          ${nameHtml}
          <span class="dm-preview">${escapeHtml(previewText)}</span>
        </div>
        ${unread > 0 ? `<span class="dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      `;
      
      item.addEventListener('click', () => {
        selectConversation(conv.id);
        if (conv.isGroup) {
          showGroupInfoButton(conv.id, conv.title);
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
}

// Сохраняем для обратной совместимости
const loadDmList = loadConversationList;

async function selectConversation(convId) {
  convId = parseInt(convId, 10);
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
  
  let conversation = conversationListCache.find(c => c.id === convId);
  if (!conversation) {
    await loadConversationList();
    conversation = conversationListCache.find(c => c.id === convId);
  }
  
  // Определяем, группа ли это
  currentConversationIsGroup = conversation ? conversation.isGroup : false;
  
  const chatPlaceholder = $('chat-placeholder');
  const chatActive = $('chat-active');
  const chatWithName = $('chat-with-name');
  
  if (chatPlaceholder) hide(chatPlaceholder);
  if (chatActive) show(chatActive);
  
  let displayName = '';
  if (conversation) {
    if (conversation.isGroup) {
      displayName = conversation.title || 'Group';
    } else {
      displayName = conversation.otherUser?.username || '…';
    }
  }
  if (chatWithName) chatWithName.textContent = displayName;
  
  document.querySelectorAll('.dm-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id, 10) === convId);
  });
  
  loadMessages(convId);
  
  setTimeout(() => {
    isAtBottom = true;
    scrollMessagesToBottom();
  }, 200);
}

// Исправленная функция загрузки сообщений
async function loadMessages(convId) {
  const list = $('messages-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  try {
    const messages = await api(`/api/conversations/${convId}/messages`);
    
    for (const msg of messages) {
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + (msg.sender_id === currentUser.id ? 'mine' : 'theirs');
      
      // Для групп показываем имя отправителя (кроме своих сообщений)
      if (currentConversationIsGroup && msg.sender_id !== currentUser.id) {
        const nameSpan = document.createElement('div');
        nameSpan.className = 'message-sender';
        nameSpan.textContent = msg.sender_username || 'Unknown';
        messageDiv.appendChild(nameSpan);
      }
      
      const bodyDiv = document.createElement('div');
      bodyDiv.textContent = msg.body;
      messageDiv.appendChild(bodyDiv);
      
      const metaDiv = document.createElement('div');
      metaDiv.className = 'message-meta';
      metaDiv.textContent = new Date(msg.created_at).toLocaleString();
      messageDiv.appendChild(metaDiv);
      
      list.appendChild(messageDiv);
    }
    
    requestAnimationFrame(() => {
      scrollMessagesToBottom();
    });
  } catch (err) {
    console.error('Failed to load messages:', err);
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
      const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });

      appendMessageToChat(msg);

      input.value = '';
      input.focus();

      requestAnimationFrame(() => {
        scrollMessagesToBottom();
      });

      updateSidebarRow(currentConversationId, body);
      
      const conversation = conversationListCache.find(c => c.id === currentConversationId);
      if (conversation) conversation.lastMessage = body;
      
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
            hideGroupInfoButton(); // Личные чаты не имеют кнопки информации
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

// ---- GROUPS ----
const btnGroups = $('btn-groups');
const btnCreateGroupBtn = $('btn-create-group-btn');
const modalCreateGroup = $('modal-create-group');
const modalGroupInfo = $('modal-group-info');
const modalAddMember = $('modal-add-member');

// Функция для загрузки списка групп (для модального окна списка групп)
async function loadGroupsList() {
  const list = $('groups-list');
  if (!list) return;
  
  list.innerHTML = '<li style="color:var(--text-muted);">Loading...</li>';
  
  try {
    const conversations = await api('/api/conversations');
    const groups = conversations.filter(c => c.isGroup);
    
    list.innerHTML = '';
    
    if (groups.length === 0) {
      list.innerHTML = '<li style="color:var(--text-muted);">No groups yet. Create one!</li>';
      return;
    }
    
    groups.forEach(group => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.justifyContent = 'space-between';
      li.style.alignItems = 'center';
      li.style.padding = '0.5rem 1rem';
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = group.title || 'Unnamed Group';
      
      const viewBtn = document.createElement('button');
      viewBtn.textContent = 'View';
      viewBtn.style.padding = '0.25rem 0.5rem';
      viewBtn.addEventListener('click', () => {
        hide($('modal-groups-list'));
        selectConversation(group.id);
        showGroupInfoButton(group.id, group.title);
        if (isMobile()) showChat();
      });
      
      li.appendChild(nameSpan);
      li.appendChild(viewBtn);
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = '<li style="color:var(--danger);">Failed to load groups</li>';
  }
}

if (btnGroups) {
  btnGroups.addEventListener('click', async () => {
    show($('modal-groups-list'));
    await loadGroupsList();
  });
}

if (btnCreateGroupBtn) {
  btnCreateGroupBtn.addEventListener('click', async () => {
    show(modalCreateGroup);
    await loadFriendsForGroup();
  });
}

const btnCloseGroup = $('btn-close-group');
if (btnCloseGroup) {
  btnCloseGroup.addEventListener('click', () => hide(modalCreateGroup));
}

if (modalCreateGroup) {
  modalCreateGroup.addEventListener('click', (e) => {
    if (e.target.id === 'modal-create-group') hide(modalCreateGroup);
  });
}

const btnCloseGroupsList = $('btn-close-groups-list');
if (btnCloseGroupsList) {
  btnCloseGroupsList.addEventListener('click', () => hide($('modal-groups-list')));
}

const modalGroupsList = $('modal-groups-list');
if (modalGroupsList) {
  modalGroupsList.addEventListener('click', (e) => {
    if (e.target.id === 'modal-groups-list') hide(modalGroupsList);
  });
}

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
      await loadConversationList();
      
      selectConversation(data.conversationId);
      showGroupInfoButton(data.conversationId, title);
      if (isMobile()) showChat();
      
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

function showGroupInfoButton(groupId, groupTitle) {
  const header = $('chat-header');
  if (!header) return;
  
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
  btn.style.minWidth = '44px';
  btn.style.minHeight = '44px';
  btn.title = 'Group info';
  
  btn.addEventListener('click', () => showGroupInfo(groupId, groupTitle));
  
  header.appendChild(btn);
}

function hideGroupInfoButton() {
  const btn = document.getElementById('group-info-btn');
  if (btn) btn.remove();
}

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
      li.style.padding = '0.25rem 0';
      listEl.appendChild(li);
    });
    
    const addBtn = $('btn-add-member');
    if (addBtn) {
      addBtn.dataset.groupId = groupId;
      addBtn.dataset.groupTitle = groupTitle;
    }
    
  } catch (err) {
    listEl.innerHTML = `<li style="color:var(--danger);">Failed to load members</li>`;
  }
}

const btnCloseGroupInfo = $('btn-close-group-info');
if (btnCloseGroupInfo) {
  btnCloseGroupInfo.addEventListener('click', () => hide(modalGroupInfo));
}

if (modalGroupInfo) {
  modalGroupInfo.addEventListener('click', (e) => {
    if (e.target.id === 'modal-group-info') hide(modalGroupInfo);
  });
}

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
      btn.style.padding = '0.5rem 1rem';
      
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/groups/${groupId}/members`, {
            method: 'POST',
            body: JSON.stringify({ userId: friend.id })
          });
          
          hide(modalAddMember);
          showGroupInfo(groupId, groupTitle);
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

const btnCloseAddMember = $('btn-close-add-member');
if (btnCloseAddMember) {
  btnCloseAddMember.addEventListener('click', () => hide(modalAddMember));
}

if (modalAddMember) {
  modalAddMember.addEventListener('click', (e) => {
    if (e.target.id === 'modal-add-member') hide(modalAddMember);
  });
}

// ---- Window resize handling ----
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

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing app');
  
  scrollDownBtn = createScrollDownButton();
  setupScrollListener();
  
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
  
  tryAutoLogin();
});
// ========== ЗВОНКИ ==========
let callWS = null;
let currentCallId = null;
let callParticipants = [];
let localStream = null;
let peerConnections = new Map();
let callActive = false;
let selfMuted = false;
let mutedUsers = new Set();
let speakingUsers = new Set();

// DOM элементы для звонков (добавить в разметку)
const callPanel = document.getElementById('call-panel');
const callParticipantsList = document.getElementById('call-participants');
const startCallBtn = document.getElementById('btn-start-call');
const endCallBtn = document.getElementById('btn-end-call');
const muteCallBtn = document.getElementById('btn-mute-call');
const callStatus = document.getElementById('call-status');

// Подключение к WebSocket для звонков
function connectCallWS() {
  const token = document.cookie.split('; ').find(row => row.startsWith('token='))?.split('=')[1];
  if (!token) return;
  
  const wsUrl = API.replace('http', 'ws') + '/ws';
  callWS = new WebSocket(wsUrl);
  
  callWS.onopen = () => {
    callWS.send(JSON.stringify({ type: 'auth', token: token }));
  };
  
  callWS.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleCallMessage(data);
  };
  
  callWS.onclose = () => {
    if (callActive) endCall();
  };
}

function handleCallMessage(data) {
  switch(data.type) {
    case 'auth_success':
      console.log('Call WebSocket authenticated');
      break;
      
    case 'call_joined':
      callParticipants = data.participants || [];
      updateCallParticipantsList();
      break;
      
    case 'user_joined':
      callParticipants.push(data.userId);
      addSystemMessage(`🎤 ${data.username} присоединился к звонку`);
      updateCallParticipantsList();
      
      if (callActive && localStream) {
        createOffer(data.userId);
      }
      break;
      
    case 'user_left':
      callParticipants = callParticipants.filter(id => id !== data.userId);
      addSystemMessage(`👋 Участник покинул звонок`);
      updateCallParticipantsList();
      
      closePeerConnection(data.userId);
      mutedUsers.delete(data.userId);
      speakingUsers.delete(data.userId);
      break;
      
    case 'offer':
      handleOffer(data);
      break;
      
    case 'answer':
      handleAnswer(data);
      break;
      
    case 'candidate':
      handleCandidate(data);
      break;
      
    case 'user_muted':
      if (data.muted) {
        mutedUsers.add(data.userId);
      } else {
        mutedUsers.delete(data.userId);
      }
      updateCallParticipantsList();
      break;
      
    case 'error':
      alert(data.message);
      if (data.message.includes('full')) {
        endCall();
      }
      break;
  }
}

// Начать звонок в группе
async function startCall() {
  if (!currentConversationId) return;
  
  // Находим группу
  const conversation = conversationListCache.find(c => c.id === currentConversationId);
  if (!conversation || !conversation.isGroup) {
    alert('Звонки доступны только в группах');
    return;
  }
  
  try {
    callStatus.textContent = '⏳ Запрос микрофона...';
    show(callPanel);
    
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    
    callActive = true;
    selfMuted = false;
    
    // Генерируем ID звонка на основе ID группы
    currentCallId = `call_${currentConversationId}`;
    
    callWS.send(JSON.stringify({
      type: 'join_call',
      callId: currentCallId,
      groupId: currentConversationId
    }));
    
    // Обновляем UI
    if (startCallBtn) startCallBtn.disabled = true;
    if (endCallBtn) endCallBtn.disabled = false;
    if (muteCallBtn) muteCallBtn.textContent = '🔇 Заглушить';
    callStatus.textContent = '🎤 В звонке';
    callStatus.className = 'call-status active';
    
    addSystemMessage('🎤 Звонок начат');
    
  } catch (err) {
    alert('Не удалось получить доступ к микрофону');
    hide(callPanel);
  }
}

function endCall() {
  if (callWS && currentCallId) {
    callWS.send(JSON.stringify({
      type: 'leave_call'
    }));
  }
  
  // Закрываем все peer connection
  peerConnections.forEach((pc, id) => {
    try { pc.close(); } catch (e) {}
    const audio = document.getElementById(`call-audio-${id}`);
    if (audio) audio.remove();
  });
  peerConnections.clear();
  
  if (localStream) {
    localStream.getAudioTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  callActive = false;
  selfMuted = false;
  mutedUsers.clear();
  speakingUsers.clear();
  currentCallId = null;
  callParticipants = [];
  
  // Обновляем UI
  if (startCallBtn) startCallBtn.disabled = false;
  if (endCallBtn) endCallBtn.disabled = true;
  hide(callPanel);
  
  addSystemMessage('🔇 Звонок завершен');
}

function toggleMute() {
  if (!localStream) return;
  
  selfMuted = !selfMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !selfMuted;
  });
  
  if (muteCallBtn) {
    muteCallBtn.textContent = selfMuted ? '🎤 Включить' : '🔇 Заглушить';
  }
  
  if (callWS && currentCallId) {
    callWS.send(JSON.stringify({
      type: 'mute_toggle',
      muted: selfMuted
    }));
  }
}

// WebRTC функции
async function createPeerConnection(targetUserId) {
  if (peerConnections.has(targetUserId)) {
    return peerConnections.get(targetUserId);
  }
  
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  };
  
  const pc = new RTCPeerConnection(configuration);
  
  if (localStream) {
    localStream.getAudioTracks().forEach(track => pc.addTrack(track, localStream));
  }
  
  pc.onicecandidate = (event) => {
    if (event.candidate && callWS) {
      callWS.send(JSON.stringify({
        type: 'candidate',
        targetUserId: targetUserId,
        candidate: event.candidate
      }));
    }
  };
  
  pc.ontrack = (event) => {
    let audio = document.getElementById(`call-audio-${targetUserId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `call-audio-${targetUserId}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    
    if (mutedUsers.has(targetUserId)) {
      audio.volume = 0;
    }
  };
  
  peerConnections.set(targetUserId, pc);
  return pc;
}

function closePeerConnection(userId) {
  if (peerConnections.has(userId)) {
    try { peerConnections.get(userId).close(); } catch (e) {}
    peerConnections.delete(userId);
  }
  
  const audio = document.getElementById(`call-audio-${userId}`);
  if (audio) audio.remove();
}

async function createOffer(targetUserId) {
  try {
    const pc = await createPeerConnection(targetUserId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    
    callWS.send(JSON.stringify({
      type: 'offer',
      targetUserId: targetUserId,
      offer: offer
    }));
  } catch (err) {
    console.error('Create offer error:', err);
  }
}

async function handleOffer(data) {
  try {
    const pc = await createPeerConnection(data.senderId);
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    callWS.send(JSON.stringify({
      type: 'answer',
      targetUserId: data.senderId,
      answer: answer
    }));
  } catch (err) {
    console.error('Handle offer error:', err);
  }
}

async function handleAnswer(data) {
  try {
    const pc = peerConnections.get(data.senderId);
    if (pc && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  } catch (err) {
    console.error('Handle answer error:', err);
  }
}

async function handleCandidate(data) {
  try {
    const pc = peerConnections.get(data.senderId);
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error('Handle candidate error:', err);
  }
}

function updateCallParticipantsList() {
  if (!callParticipantsList) return;
  
  const otherParticipants = callParticipants.filter(id => id !== currentUser?.id);
  
  callParticipantsList.innerHTML = otherParticipants.map(userId => {
    const user = conversationListCache
      .flatMap(c => c.participants || [])
      .find(p => p.id === userId);
    
    const username = user?.username || 'Участник';
    const isSpeaking = speakingUsers.has(userId) && !mutedUsers.has(userId);
    const isMuted = mutedUsers.has(userId);
    
    return `
      <div class="call-participant ${isSpeaking ? 'speaking' : ''}">
        <span class="participant-name">${username}</span>
        <span class="participant-status">${isMuted ? '🔇' : (isSpeaking ? '🎤' : '')}</span>
      </div>
    `;
  }).join('');
}

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
  // ... ваш существующий код ...
  
  // Добавляем кнопку звонка в заголовок группы
  const chatHeader = document.getElementById('chat-header');
  if (chatHeader) {
    const callBtn = document.createElement('button');
    callBtn.id = 'btn-start-call';
    callBtn.innerHTML = '🎤';
    callBtn.className = 'call-header-btn';
    callBtn.style.marginLeft = 'auto';
    callBtn.style.background = 'none';
    callBtn.style.border = 'none';
    callBtn.style.color = 'var(--text-muted)';
    callBtn.style.fontSize = '1.2rem';
    callBtn.style.cursor = 'pointer';
    callBtn.style.padding = '0 10px';
    callBtn.style.minWidth = '44px';
    callBtn.style.minHeight = '44px';
    callBtn.title = 'Начать звонок';
    callBtn.onclick = startCall;
    
    chatHeader.appendChild(callBtn);
  }
  
  // Подключаем WebSocket для звонков
  connectCallWS();
});