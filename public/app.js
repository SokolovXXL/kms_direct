const API = window.location.origin;

let pendingFiles = [];
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let conversationListCache = [];
let isAtBottom = true;
let currentConversationIsGroup = false;
let callActive = false;
let localStream = null;
let peerConnections = new Map(); // userId -> RTCPeerConnection
let remoteStreams = new Map();   // userId -> MediaStream
let signalingChannel = null;
let currentCallId = null;
let currentCallConversationId = null; // ID чата, в котором идёт звонок
let remoteAudioElements = new Map();   // userId -> HTMLAudioElement
let currentConversationIsChannel = false;
let creatingChannel = false; // флаг для модалки создания канала

const $ = (id) => document.getElementById(id);

function formatLastSeen(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffSeconds = Math.floor((now - date) / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'только что';
  if (diffMinutes < 60) return `${diffMinutes} ${pluralize(diffMinutes, 'минуту', 'минуты', 'минут')} назад`;
  if (diffHours < 24) return `${diffHours} ${pluralize(diffHours, 'час', 'часа', 'часов')} назад`;
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return `${diffDays} ${pluralize(diffDays, 'день', 'дня', 'дней')} назад`;

  // Иначе показываем дату
  const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return date.toLocaleString('ru-RU', options);
}

function pluralize(n, one, few, many) {
  n = Math.abs(n) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

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
  try {
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('user', JSON.stringify(me));
  } catch (err) {
    currentUser = null;
    localStorage.removeItem('user');
  }
  renderScreen();
}

function renderScreen() {
  console.log('renderScreen called', { currentUser });
  
  if (currentUser) {
    hide($('auth-screen'));
    show($('main-screen'));
    
    const headerUsername = $('header-username');
    if (headerUsername) headerUsername.textContent = currentUser.display_name || currentUser.username;
    
    if (!currentUser.friend_code) fetchMe();
    
    startNotificationStream();
    loadConversationList();
    loadNotificationCount();
    
    initSignalingChannel();
    
    if (isMobile()) {
      showSidebar();
    }
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
    localStorage.removeItem('lastConversationId');
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
      currentUser.display_name = me.display_name;
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
    if (callActive) await endCall();
    if (signalingChannel) {
      signalingChannel.close();
      signalingChannel = null;
    }
    
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (_) {}
    
    currentUser = null;
    localStorage.removeItem('user');
    localStorage.removeItem('lastConversationId');
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
        
        if (convId !== currentConversationId) {
          unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
          playNotificationSound(convId);
        }
        
        if (currentConversationId === convId && message) {
          appendMessageToChat(message);
          updateSidebarRow(convId, message.body);
        } else {
          updateSidebarRow(convId, message ? message.body : null);
        }
      }else if (data.type === 'typing') {
        handleTypingEvent(data);
      }else if (data.type === 'reaction') {
        handleReactionEvent(data);
      }else if (data.type === 'user_status') {
        handleUserStatusChange(data);
      }else if (data.type === 'new_group') {
        loadConversationList();
      } else if (data.type === 'added_to_group') {
        loadConversationList();
      } else if (data.type === 'message_deleted') {
        if (currentConversationId === data.conversationId) {
          const msgElement = document.querySelector(`.message[data-message-id="${data.messageId}"]`);
          if (msgElement) {
            msgElement.remove();
            updateSidebarPreviewAfterDeletion(data.conversationId);
          }
        }
      } else if (data.type === 'kicked_from_group') {
        conversationListCache = conversationListCache.filter(c => c.id !== data.conversationId);
        if (currentConversationId === data.conversationId) {
          currentConversationId = null;
          currentConversationIsGroup = false;
          const chatPlaceholder = $('chat-placeholder');
          const chatActive = $('chat-active');
          if (chatPlaceholder) show(chatPlaceholder);
          if (chatActive) hide(chatActive);
          document.querySelectorAll('.dm-item').forEach(el => {
            el.classList.remove('active');
          });
          hideGroupInfoButton();
          if (isMobile()) {
            showSidebar();
          }
        }
        loadConversationList();
        showToast('Вас удалили из группы', 'info');
      } else if (data.type === 'member_removed') {
        loadConversationList();
      } else if (data.type === 'group_deleted') {
        conversationListCache = conversationListCache.filter(c => c.id !== data.conversationId);
        if (currentConversationId === data.conversationId) {
          currentConversationId = null;
          currentConversationIsGroup = false;
          const chatPlaceholder = $('chat-placeholder');
          const chatActive = $('chat-active');
          if (chatPlaceholder) show(chatPlaceholder);
          if (chatActive) hide(chatActive);
          document.querySelectorAll('.dm-item').forEach(el => {
            el.classList.remove('active');
          });
          hideGroupInfoButton();
          if (isMobile()) {
            showSidebar();
          }
        }
        loadConversationList();
        showToast('Группа удалена', 'info');
      }
    } catch (_) {}
  };
  
  eventSource.onerror = () => {
    // Auto-reconnect
  };
}

function updateSidebarPreviewAfterDeletion(convId) {
  if (convId === currentConversationId) {
    const messages = document.querySelectorAll('#messages-list .message');
    let previewText = 'No messages yet';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const fileContent = lastMsg.querySelector('.message-file-content');
      if (fileContent) {
        const fileNameEl = fileContent.querySelector('.file-name');
        const fileName = fileNameEl ? fileNameEl.textContent : 'File';
        previewText = `📎 ${fileName}`;
      } else {
        const bodyEl = lastMsg.querySelector('.message-body');
        previewText = bodyEl ? bodyEl.textContent.substring(0, 50) : 'No messages yet';
      }
    }
    updateSidebarRow(convId, previewText);
  } else {
    loadConversationList();
  }
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

// ---- Создание элемента сообщения ----
function createMessageElement(message, isGroup, currentUserId) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ' + (message.sender_id === currentUserId ? 'mine' : 'theirs');
  messageDiv.dataset.messageId = message.id;

  if (isGroup && message.sender_id !== currentUserId) {
    const nameSpan = document.createElement('div');
    nameSpan.className = 'message-sender';
    nameSpan.textContent = message.sender_username || 'Unknown';
    messageDiv.appendChild(nameSpan);
  }

  let isFile = false;
  let fileData = null;
  if (typeof message.body === 'string' && message.body.startsWith('{')) {
    try {
      fileData = JSON.parse(message.body);
      if (fileData.type === 'file') {
        isFile = true;
      }
    } catch (e) {}
  }

  if (isFile && fileData) {
    renderFileMessage(messageDiv, fileData);
  } else {
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    bodyDiv.textContent = message.body;
    messageDiv.appendChild(bodyDiv);
  }
  if (message.reactions && message.reactions.length > 0) {
    const reactionsBar = document.createElement('div');
    reactionsBar.className = 'message-reactions';
    message.reactions.forEach(r => {
      const span = document.createElement('span');
      span.className = 'reaction' + (r.me ? ' me' : '');
      span.dataset.emoji = r.emoji;
      span.innerHTML = `<img src="/images/emojis/${r.emoji}.png" alt="${r.emoji}" class="reaction-emoji"> <span class="reaction-count">${r.count}</span>`;
      reactionsBar.appendChild(span);
    });
    messageDiv.appendChild(reactionsBar);
  }
  const metaDiv = document.createElement('div');
  metaDiv.className = 'message-meta';
  metaDiv.textContent = new Date(message.created_at).toLocaleString();
  messageDiv.appendChild(metaDiv);

  return messageDiv;
}

function appendMessageToChat(message) {
  const list = $('messages-list');
  if (!list) return;

  if (document.querySelector(`.message[data-message-id="${message.id}"]`)) return;

  const container = $('chat-messages-wrapper');
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 20;

  const messageDiv = createMessageElement(message, currentConversationIsGroup, currentUser.id);
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

function truncate(str, maxLen = 50) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '…';
}

function updateSidebarRow(convId, lastMessageText) {
  const btn = document.querySelector(`.dm-item[data-id="${convId}"]`);
  if (!btn) return;
  
  const preview = btn.querySelector('.dm-preview');
  if (preview) {
    let displayText = lastMessageText;
    if (typeof displayText !== 'string') displayText = '';
    
    if (displayText.startsWith('{')) {
      try {
        const fileData = JSON.parse(displayText);
        if (fileData.type === 'file') {
          displayText = `📎 ${fileData.name || 'File'}`;
        }
      } catch {}
    }
    preview.textContent = truncate(displayText) || 'No messages yet';
  }
  
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
// ---- istyping ----
let typingTimeouts = {}; // userId -> setTimeout

function handleTypingEvent(data) {
  const { conversationId, userId, action } = data;
  const conversation = conversationListCache.find(c => c.id === conversationId);
  if (!conversation) return;

  // Обновляем кэш
  if (action === 'start') {
    conversation.typingUserId = userId;
  } else {
    conversation.typingUserId = null;
  }

  // Определяем отображаемое имя
  let displayName = 'Кто-то';
  if (!conversation.isGroup && conversation.otherUser?.id === userId) {
    displayName = conversation.otherUser.name || conversation.otherUser.username;
  } else if (conversation.isGroup) {
    displayName = `Пользователь ${userId}`;
  }

  const isCurrent = (conversationId === currentConversationId);

  if (action === 'start') {
    // Сбрасываем старый таймер
    if (typingTimeouts[userId]) clearTimeout(typingTimeouts[userId]);

    if (isCurrent) {
      showTypingIndicator(displayName, conversation);
    } else {
      updateTypingStatusInSidebar(conversationId, displayName, true);
    }

    // Автоматически снимаем через 5 секунд (на случай, если stop не пришёл)
    typingTimeouts[userId] = setTimeout(() => {
      handleTypingEvent({ ...data, action: 'stop' });
    }, 5000);
  } else { // stop
    if (typingTimeouts[userId]) {
      clearTimeout(typingTimeouts[userId]);
      delete typingTimeouts[userId];
    }
    if (isCurrent) {
      hideTypingIndicator(conversation);
    } else {
      updateTypingStatusInSidebar(conversationId, displayName, false);
    }
  }
}

function showTypingIndicator(displayName, conversation) {
  const statusEl = $('#chat-status');
  if (!statusEl) return;
  if (!conversation.isGroup) {
    statusEl.textContent = 'печатает...';
    statusEl.style.color = 'var(--accent)';
  } else {
    statusEl.textContent = `${displayName} печатает...`;
    statusEl.style.color = 'var(--accent)';
  }
}

function hideTypingIndicator(conversation) {
  const statusEl = $('#chat-status');
  if (!statusEl) return;
  // Восстанавливаем обычный статус онлайн/был
  updateChatHeaderStatus(conversation);
}

function updateTypingStatusInSidebar(conversationId, displayName, isTyping) {
  const row = document.querySelector(`.dm-item[data-id="${conversationId}"] .dm-status`);
  if (!row) return;
  if (isTyping) {
    row.innerHTML = 'печатает...';
    row.classList.add('typing');
  } else {
    // Вернуть обычный статус, перезагрузив из кэша
    const conversation = conversationListCache.find(c => c.id === conversationId);
    if (conversation && !conversation.isGroup && conversation.otherUser) {
      if (conversation.otherUser.online) {
        row.innerHTML = '● онлайн';
        row.className = 'dm-status online';
      } else if (conversation.otherUser.last_seen) {
        row.innerHTML = `был ${formatLastSeen(conversation.otherUser.last_seen)}`;
        row.className = 'dm-status';
      }
    }
    row.classList.remove('typing');
  }
}

function updateChatHeaderStatus(conversation) {
  const statusEl = $('#chat-status');
  if (!statusEl) return;
  if (!conversation) return;
  if (conversation.isGroup) {
    statusEl.textContent = ''; // Для группы можно показать количество участников или ничего
  } else if (conversation.otherUser) {
    if (conversation.otherUser.online) {
      statusEl.textContent = 'онлайн';
      statusEl.style.color = 'var(--success)';
    } else if (conversation.otherUser.last_seen) {
      statusEl.textContent = `был ${formatLastSeen(conversation.otherUser.last_seen)}`;
      statusEl.style.color = 'var(--text-muted)';
    } else {
      statusEl.textContent = '';
    }
  }
}

function handleUserStatusChange(data) {
  const { userId, online, last_seen } = data;

  for (const conv of conversationListCache) {
    if (!conv.isGroup && conv.otherUser?.id === userId) {
      conv.otherUser.online = online;
      if (!online && last_seen) {
        conv.otherUser.last_seen = last_seen;
      }
      // Если пользователь вышел из сети, он не может печатать
      if (!online && conv.typingUserId === userId) {
        conv.typingUserId = null;
      }
      // Обновляем строку в списке
      updateSidebarRowStatus(conv.id, online, last_seen);
      // Если это текущий открытый чат – обновляем шапку
      if (currentConversationId === conv.id) {
        updateChatHeaderStatus(conv);
      }
      break;
    }
  }
}

function updateSidebarRowStatus(convId, online, last_seen) {
  const row = document.querySelector(`.dm-item[data-id="${convId}"] .dm-status`);
  if (!row) return;
  if (online) {
    row.innerHTML = '● онлайн';
    row.className = 'dm-status online';
  } else {
    row.innerHTML = `был ${formatLastSeen(last_seen)}`;
    row.className = 'dm-status';
  }
}
let typingTimeout = null;
let lastTypingSent = 0;
const TYPING_INTERVAL = 3000; // мс

function sendTyping(action) {
  if (!currentConversationId) return;
  fetch(API + '/api/typing', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: currentConversationId, action })
  }).catch(e => console.error('Failed to send typing:', e));
}

const messageInput = $('#message-input');
if (messageInput) {
  messageInput.addEventListener('input', () => {
    const now = Date.now();
    const hasText = messageInput.value.trim().length > 0;

    if (hasText) {
      // Отправляем start при начале печати, если не отправляли недавно
      if (now - lastTypingSent > TYPING_INTERVAL) {
        sendTyping('start');
        lastTypingSent = now;
      }
      // Сбрасываем таймер на отправку stop
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        if (messageInput.value.trim().length === 0) {
          sendTyping('stop');
          lastTypingSent = 0;
        } else {
          // Если через 3 секунды всё ещё есть текст, отправим ещё start (поддержание)
          sendTyping('start');
          lastTypingSent = Date.now();
          typingTimeout = setTimeout(() => {
            if (messageInput.value.trim().length === 0) {
              sendTyping('stop');
              lastTypingSent = 0;
            }
          }, TYPING_INTERVAL);
        }
      }, 2000); // ждём 2 секунды после последнего ввода перед stop
    } else {
      // Поле пусто – отправляем stop
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = null;
      sendTyping('stop');
      lastTypingSent = 0;
    }
  });

  // При отправке формы – stop
  const sendForm = $('#send-form');
  if (sendForm) {
    sendForm.addEventListener('submit', () => {
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = null;
      sendTyping('stop');
      lastTypingSent = 0;
    });
  }
}

// ---- Контекстное меню сообщений ----
let contextMenu = null;
let currentContextMessage = null;

function initContextMenu() {
  contextMenu = document.getElementById('message-context-menu');
  if (!contextMenu) return;

  // Закрытие по клику вне меню
  document.addEventListener('click', (e) => {
    if (!contextMenu.classList.contains('hidden') && 
        !contextMenu.contains(e.target) && 
        !e.target.closest('.message')) {
      hideContextMenu();
    }
  });

  // Закрытие по прокрутке
  const messagesWrapper = document.getElementById('chat-messages-wrapper');
  if (messagesWrapper) {
    messagesWrapper.addEventListener('scroll', () => {
      hideContextMenu();
    });
  }

  // Закрытие по Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  });

  // Обработка кликов по пунктам меню
  contextMenu.addEventListener('click', (e) => {
    const actionItem = e.target.closest('.context-menu-item');
    if (!actionItem || !currentContextMessage) return;

    const action = actionItem.dataset.action;
    if (action === 'copy') {
      copyMessageContent(currentContextMessage);
    } else if (action === 'delete') {
      deleteMessage(currentContextMessage);
    }else if (action === 'react') {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      // Show emoji picker near the message
      const rect = currentContextMessage.getBoundingClientRect();
      showEmojiPicker(currentContextMessage, rect.right, rect.top);
    }
    hideContextMenu();
  });
}

function showContextMenu(messageElement, clickX, clickY) {
  if (!contextMenu) return;

  currentContextMessage = messageElement;

  // Показываем или скрываем пункт "Удалить" в зависимости от того, своё ли сообщение
  const deleteItem = contextMenu.querySelector('[data-action="delete"]');
  if (deleteItem) {
    if (messageElement.classList.contains('mine')) {
      deleteItem.style.display = 'block';
    } else {
      deleteItem.style.display = 'none';
    }
  }

  const menuWidth = contextMenu.offsetWidth || 180;
  const menuHeight = contextMenu.offsetHeight || 100;
  
  let left = clickX;
  let top = clickY;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  if (left + menuWidth > viewportWidth - 10) {
    left = viewportWidth - menuWidth - 10;
  }
  if (top + menuHeight > viewportHeight - 10) {
    top = viewportHeight - menuHeight - 10;
  }

  contextMenu.style.left = left + 'px';
  contextMenu.style.top = top + 'px';

  const arrow = contextMenu.querySelector('.context-menu-arrow');
  if (arrow) {
    const arrowLeft = clickX - left;
    arrow.style.left = Math.min(Math.max(arrowLeft - 6, 10), menuWidth - 20) + 'px';
  }

  contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.add('hidden');
    currentContextMessage = null;
  }
}

function copyMessageContent(messageElement) {
  // Пытаемся найти текст в .message-body, иначе имя файла
  const bodyEl = messageElement.querySelector('.message-body');
  if (bodyEl) {
    navigator.clipboard.writeText(bodyEl.textContent).catch(() => {
      showToast('Не удалось скопировать', 'error');
    });
    return;
  }

  // Если это файл, копируем имя файла
  const fileNameEl = messageElement.querySelector('.file-name');
  if (fileNameEl) {
    navigator.clipboard.writeText(fileNameEl.textContent).catch(() => {
      showToast('Не удалось скопировать', 'error');
    });
  }
}

async function deleteMessage(messageElement) {
  if (!confirm('Удалить это сообщение?')) return;

  const messageId = messageElement.dataset.messageId;
  if (!messageId) return;

  try {
    await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    messageElement.style.opacity = '0';
    messageElement.style.transform = 'translateX(-10px)';
    messageElement.style.transition = 'all 0.3s';

    setTimeout(() => {
      if (messageElement.parentNode) {
        messageElement.remove();
        updateSidebarPreviewAfterDeletion(currentConversationId);
      }
    }, 300);
  } catch (err) {
    alert('Ошибка удаления: ' + err.message);
  }
}

// Обработчик клика на сообщения (через делегирование)
const messagesList = document.getElementById('messages-list');
if (messagesList) {
  messagesList.addEventListener('click', (e) => {
    const message = e.target.closest('.message');
    if (!message) return;

    const interactive = e.target.closest('button, a, .audio-play-btn, .audio-download-btn, .delete-message-btn, input, label, video, audio');
    if (interactive) return;

    showContextMenu(message, e.clientX, e.clientY);
    e.stopPropagation();
  });
}
// Инициализируем при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
  initContextMenu();
  // ... остальной код инициализации
});

// ---- Conversations List ----
async function loadConversationList(retryCount = 3) {
  const list = $('dm-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const [conversations, notifByConvoResp] = await Promise.all([
        api('/api/conversations'),
        api('/api/notifications')
      ]);
      
      unreadByConvo = notifByConvoResp;
      conversationListCache = conversations.map(c => ({ 
        ...c, 
        typingUserId: null,
        isChannel: c.isChannel || false
      }));

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
        if (conv.isChannel) {
          nameHtml = `<span class="dm-name"><img src="/images/channel.png" alt="Channel" style="width:18px;height:18px;vertical-align:middle;"> ${escapeHtml(conv.title || 'Channel')}</span>`;
        } else if (conv.isGroup) {
          nameHtml = `<span class="dm-name"><img src="/images/group.png" alt="Group" style="width:18px;height:18px;vertical-align:middle;"> ${escapeHtml(conv.title || 'Group')}</span>`;
        } else {
          const otherUserName = conv.otherUser?.name || conv.otherUser?.username || 'Unknown';
          nameHtml = `<span class="dm-name">${escapeHtml(otherUserName)}</span>`;
        }
        let previewText = conv.lastMessage || 'No messages yet';
        let statusHtml = '';
        
        if (!conv.isGroup && conv.otherUser) {
          if (conv.typingUserId) {
            statusHtml = '<span class="dm-status typing">печатает...</span>';
          } else if (conv.otherUser.online) {
            statusHtml = '<span class="dm-status online">● онлайн</span>';
          } else if (conv.otherUser.last_seen) {
            statusHtml = `<span class="dm-status">был ${formatLastSeen(conv.otherUser.last_seen)}</span>`;
          }
        }

        if (previewText.startsWith('{')) {
          try {
            const fileData = JSON.parse(previewText);
            if (fileData.type === 'file') {
              previewText = `📎 ${fileData.name || 'File'}`;
            }
          } catch (e) {}
        }
        previewText = truncate(previewText);
        
        
        item.innerHTML = `
          <div style="flex:1;min-width:0;">
            ${nameHtml}
            <span class="dm-preview">${escapeHtml(previewText)}</span>
            ${statusHtml}
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
      restoreLastConversation();
      return; // успех – выходим из функции
      
    } catch (err) {
      console.error(`Failed to load conversations (attempt ${attempt}/${retryCount}):`, err);
      if (attempt === retryCount) {
        list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Could not load conversations</p>';
      } else {
        // ждём перед следующей попыткой (экспоненциальная задержка)
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

const loadDmList = loadConversationList;

async function restoreLastConversation() {
  const lastConvId = localStorage.getItem('lastConversationId');
  if (lastConvId && !currentConversationId) {
    const exists = conversationListCache.some(c => c.id == lastConvId);
    if (exists) {
      selectConversation(parseInt(lastConvId, 10));
    } else {
      localStorage.removeItem('lastConversationId');
    }
  }
}

async function selectConversation(convId) {
  convId = parseInt(convId, 10);
  
  currentConversationId = convId;
  localStorage.setItem('lastConversationId', convId);
  
  // Помечаем уведомления как прочитанные
  try {
    await api('/api/notifications/read', { 
      method: 'POST', 
      body: JSON.stringify({ conversationId: convId }) 
    });
  } catch (_) {}
  
  unreadByConvo[convId] = 0;
  updateBadgeFromCache();
  updateSidebarRow(convId, null);
  
  // Получаем информацию о диалоге из кэша
  let conversation = conversationListCache.find(c => c.id === convId);
  if (!conversation) {
    await loadConversationList();
    conversation = conversationListCache.find(c => c.id === convId);
  }
  
  // Определяем роль текущего пользователя (нужно для каналов)
  let userRole = 'member';
  if (conversation && conversation.participants) {
    const me = conversation.participants.find(p => p.id === currentUser.id);
    if (me) userRole = me.role;
  }
  window.currentUserRole = userRole; // если нужно в других местах
  
  currentConversationIsGroup = conversation ? conversation.isGroup : false;
  currentConversationIsChannel = conversation ? conversation.isChannel : false;
  
  // Управление видимостью поля ввода и кнопки звонка
  const sendForm = $('send-form');
  const btnCall = $('btn-call');
  
  if (conversation && conversation.isChannel) {
    // Канал: писать могут только админы, звонков нет
    if (userRole === 'owner' || userRole === 'admin') {
      show(sendForm);
    } else {
      hide(sendForm);
    }
    hide(btnCall);
  } else {
    // Группа или личный чат: поле ввода всегда видно
    show(sendForm);
    if (btnCall) {
      if (callActive) {
        btnCall.style.display = 'none';
      } else if (conversation) {
        btnCall.style.display = 'block';
      } else {
        btnCall.style.display = 'none';
      }
    }
  }
  
  // Обновление шапки чата
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
      displayName = conversation.otherUser?.name || conversation.otherUser?.username || '…';
    }
  }
  if (chatWithName) chatWithName.textContent = displayName;
  updateChatHeaderStatus(conversation);
  
  // Подсветка активного элемента в списке
  document.querySelectorAll('.dm-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.id, 10) === convId);
  });
  
  // Загружаем сообщения
  loadMessages(convId);
  
  // Скролл вниз
  setTimeout(() => {
    isAtBottom = true;
    scrollMessagesToBottom();
  }, 200);
}
// ---- emojis ----

const EMOJIS = [
  { code: 'like', img: 'like.png', display: '👍' },
  { code: 'love', img: 'heart.png', display: '❤️' },
  { code: 'laugh', img: 'laugh.png', display: '😂' },
  { code: 'wow', img: 'wow.png', display: '😮' },
  { code: 'sad', img: 'sad.png', display: '😢' },
  { code: 'angry', img: 'angry.png', display: '😠' }
];

let currentReactionMessage = null;

function showEmojiPicker(messageEl, x, y) {
  const picker = document.getElementById('emoji-picker');
  if (!picker) return;

  currentReactionMessage = messageEl;

  // Fill picker with emoji buttons
  const content = picker.querySelector('.emoji-picker-content');
  content.innerHTML = '';
  EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn';
    btn.dataset.emoji = e.code;
    btn.innerHTML = `<img src="/images/emojis/${e.img}" alt="${e.code}" class="emoji-img">`;
    btn.addEventListener('click', () => {
      const messageId = messageEl.dataset.messageId;
      toggleReaction(messageId, e.code);
      hideEmojiPicker();
    });
    content.appendChild(btn);
  });

  // Position picker near the click
  picker.style.left = x + 'px';
  picker.style.top = y + 'px';
  picker.classList.remove('hidden');

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', outsideClickHandler);
  }, 0);
}

function hideEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  if (picker) picker.classList.add('hidden');
  document.removeEventListener('click', outsideClickHandler);
  currentReactionMessage = null;
}

function outsideClickHandler(e) {
  const picker = document.getElementById('emoji-picker');
  if (picker && !picker.contains(e.target)) {
    hideEmojiPicker();
  }
}

async function toggleReaction(messageId, emoji) {
  try {
    await api(`/api/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji })
    });
    // Optimistic update is handled by SSE, but we can also update locally
  } catch (err) {
    console.error('Failed to toggle reaction:', err);
    showToast('Ошибка при добавлении реакции', 'error');
  }
}


function handleReactionEvent(data) {
  const { messageId, userId, emoji, action } = data;
  const messageEl = document.querySelector(`.message[data-message-id="${messageId}"]`);
  if (!messageEl) return;

  let reactionsBar = messageEl.querySelector('.message-reactions');
  if (!reactionsBar) {
    reactionsBar = document.createElement('div');
    reactionsBar.className = 'message-reactions';
    messageEl.appendChild(reactionsBar);
  }

  // Find or create reaction item for this emoji
  let reactionItem = Array.from(reactionsBar.children).find(
    item => item.dataset.emoji === emoji
  );

  if (action === 'add') {
    if (!reactionItem) {
      reactionItem = document.createElement('span');
      reactionItem.className = 'reaction';
      reactionItem.dataset.emoji = emoji;
      reactionItem.innerHTML = `<img src="/images/emojis/${emoji}.png" alt="${emoji}" class="reaction-emoji"> <span class="reaction-count">1</span>`;
      if (userId === currentUser.id) reactionItem.classList.add('me');
      reactionsBar.appendChild(reactionItem);
    } else {
      const countSpan = reactionItem.querySelector('.reaction-count');
      const count = parseInt(countSpan.textContent, 10) + 1;
      countSpan.textContent = count;
      if (userId === currentUser.id) reactionItem.classList.add('me');
    }
  } else if (action === 'remove') {
    if (reactionItem) {
      const countSpan = reactionItem.querySelector('.reaction-count');
      const count = parseInt(countSpan.textContent, 10) - 1;
      if (count <= 0) {
        reactionItem.remove();
      } else {
        countSpan.textContent = count;
        if (userId === currentUser.id) reactionItem.classList.remove('me');
      }
    }
  }

  if (reactionsBar.children.length === 0) reactionsBar.remove();
}

async function loadMessages(convId) {
  const list = $('messages-list');
  if (!list) return;
  
  list.innerHTML = '';
  
  try {
    const messages = await api(`/api/conversations/${convId}/messages`);
    
    for (const msg of messages) {
      const messageDiv = createMessageElement(msg, currentConversationIsGroup, currentUser.id);
      list.appendChild(messageDiv);
    }
    
    const container = $('chat-messages-wrapper');
    const shouldScroll = container.scrollHeight - container.scrollTop - container.clientHeight <= 20;
    if (shouldScroll) {
      requestAnimationFrame(() => {
        scrollMessagesToBottom();
      });
    }
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
    const files = pendingFiles.splice(0);
    
    if (!body && files.length === 0) return;

    try {
      if (body) {
        const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });

        appendMessageToChat(msg);
        input.value = '';
        input.focus();
        updateSidebarRow(currentConversationId, body);
        
        const conversation = conversationListCache.find(c => c.id === currentConversationId);
        if (conversation) conversation.lastMessage = body;
      }
      
      for (const file of files) {
        await sendFileWithProgress(file, currentConversationId);
      }

      requestAnimationFrame(() => {
        scrollMessagesToBottom();
      });
      
    } catch (err) {
      input.value = body;
      alert('Failed to send message: ' + err.message);
    }
  });
}

async function sendFileWithProgress(file, conversationId) {
  return new Promise((resolve, reject) => {
    const progressId = `upload-${Date.now()}-${Math.random()}`;
    showUploadProgress(file, progressId);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/api/upload', true);
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = (e.loaded / e.total) * 100;
        updateUploadProgress(progressId, percent, e.loaded, e.total);
      }
    });

    xhr.addEventListener('load', async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const fileData = JSON.parse(xhr.responseText);
          removeUploadProgress(progressId);

          const fileMessage = {
            type: 'file',
            url: fileData.url,
            name: fileData.name,
            mime: fileData.type,
            size: file.size
          };

          const msg = await api(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ body: JSON.stringify(fileMessage) }),
          });

          appendMessageToChat(msg);
          updateSidebarRow(conversationId, `📎 ${file.name}`);
          resolve();
        } catch (err) {
          removeUploadProgress(progressId);
          reject(err);
        }
      } else {
        removeUploadProgress(progressId);
        reject(new Error('Upload failed'));
      }
    });

    xhr.addEventListener('error', () => {
      removeUploadProgress(progressId);
      reject(new Error('Network error'));
    });

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
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
        btn.textContent = u.name || u.username;
        btn.addEventListener('click', async () => {
          try {
            const data = await api('/api/dms', { 
              method: 'POST', 
              body: JSON.stringify({ otherUserId: u.id }) 
            });
            hide($('modal-new-dm'));
            selectConversation(data.conversationId);
            hideGroupInfoButton();
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
        li.textContent = u.name || u.username;
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
    
    // Завершаем активный звонок и закрываем сигнальный канал перед удалением
    if (callActive) await endCall();
    if (signalingChannel) {
      signalingChannel.close();
      signalingChannel = null;
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

// ---- Profile menu ----
const btnMenu = $('btn-menu');
const modalProfile = $('modal-profile');
const btnCloseProfile = $('btn-close-profile');
const btnSaveDisplayName = $('btn-save-display-name');
const profileDisplayNameInput = $('profile-display-name');
const profileError = $('profile-error');

if (btnMenu) {
  btnMenu.addEventListener('click', () => {
    if (modalProfile && currentUser) {
      profileDisplayNameInput.value = currentUser.display_name || currentUser.username;
      profileError.textContent = '';
      show(modalProfile);
    }
  });
}

if (btnCloseProfile) {
  btnCloseProfile.addEventListener('click', () => hide(modalProfile));
}

if (modalProfile) {
  modalProfile.addEventListener('click', (e) => {
    if (e.target.id === 'modal-profile') hide(modalProfile);
  });
}

if (btnSaveDisplayName) {
  btnSaveDisplayName.addEventListener('click', async () => {
    const newName = profileDisplayNameInput.value.trim();
    if (!newName) {
      profileError.textContent = 'Display name cannot be empty';
      return;
    }
    if (newName.length < 2) {
      profileError.textContent = 'Display name must be at least 2 characters';
      return;
    }
    try {
      const result = await api('/api/display-name', {
        method: 'POST',
        body: JSON.stringify({ displayName: newName })
      });
      currentUser.display_name = result.displayName;
      localStorage.setItem('user', JSON.stringify(currentUser));
      const headerUsername = $('header-username');
      if (headerUsername) headerUsername.textContent = currentUser.display_name || currentUser.username;
      hide(modalProfile);
      loadConversationList();
    } catch (err) {
      profileError.textContent = err.message;
    }
  });
}

// ---- GROUPS ----
const btnGroups = $('btn-groups');
const btnCreateGroupBtn = $('btn-create-group-btn');
const modalGroupInfo = $('modal-group-info');
const modalAddMember = $('modal-add-member');

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
  btnCloseGroup.addEventListener('click', () => {
    hide($('modal-create-group'));
    creatingChannel = false;
    document.querySelector('#modal-create-group h2').textContent = 'Create group';
    $('btn-create-group').textContent = 'Create group';
  });
}

// Также в обработчике клика по модалке (если есть)
const modalCreateGroup = $('modal-create-group');
if (modalCreateGroup) {
  modalCreateGroup.addEventListener('click', (e) => {
    if (e.target.id === 'modal-create-group') {
      hide(modalCreateGroup);
      creatingChannel = false;
      document.querySelector('#modal-create-group h2').textContent = 'Create group';
      $('btn-create-group').textContent = 'Create group';
    }
  });
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
      label.textContent = friend.name || friend.username;
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
      let data;
      if (creatingChannel) {
        data = await api('/api/channels', {
          method: 'POST',
          body: JSON.stringify({ title, userIds })
        });
      } else {
        data = await api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({ title, userIds })
        });
      }
      
      hide($('modal-create-group'));
      // Сбрасываем флаг и восстанавливаем заголовки
      creatingChannel = false;
      document.querySelector('#modal-create-group h2').textContent = 'Create group';
      $('btn-create-group').textContent = 'Create group';
      
      await loadConversationList();
      selectConversation(data.conversationId);
      
      // Для канала не показываем кнопку информации (можно убрать), для группы показываем
      if (!creatingChannel) { // но creatingChannel уже false, нужно по data понять, канал ли это
        // Пока сервер не возвращает isChannel, можно ориентироваться на флаг, но флаг сброшен.
        // Лучше добавить в ответ сервера поле isChannel. Но для простоты пока сделаем так:
        if (data.conversationId) {
          // Перезагрузим диалоги и попробуем найти
          setTimeout(() => {
            const conv = conversationListCache.find(c => c.id === data.conversationId);
            if (conv && !conv.isChannel) {
              showGroupInfoButton(data.conversationId, title);
            } else {
              hideGroupInfoButton();
            }
          }, 500);
        }
      }
      
      if (isMobile()) showChat();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

const btnCreateChannel = $('btn-create-channel');
if (btnCreateChannel) {
  btnCreateChannel.addEventListener('click', async () => {
    // Используем ту же модалку, что и для группы
    show($('modal-create-group'));
    // Меняем заголовок
    document.querySelector('#modal-create-group h2').textContent = 'Create channel';
    // Меняем текст кнопки создания
    const createBtn = $('btn-create-group');
    createBtn.textContent = 'Create channel';
    // Устанавливаем флаг
    creatingChannel = true;
    // Загружаем список друзей
    await loadFriendsForGroup(); // эта функция уже существует
  });
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
    const isChannel = group.isChannel || false;
    
    const currentMember = group.participants.find(p => p.id === currentUser.id);
    const isOwner = currentMember?.role === 'owner';
    const isAdmin = currentMember?.role === 'admin' || isOwner;
    
    listEl.innerHTML = '';
    
    group.participants.forEach(member => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.padding = '0.5rem 0';
      
      const leftDiv = document.createElement('div');
      leftDiv.style.display = 'flex';
      leftDiv.style.alignItems = 'center';
      leftDiv.style.gap = '0.5rem';
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = (member.name || member.username) + (member.id === currentUser.id ? ' (you)' : '');
      leftDiv.appendChild(nameSpan);

      // Иконки ролей
      if (member.role === 'owner') {
        const ownerImg = document.createElement('img');
        ownerImg.src = '/images/owner.png';
        ownerImg.alt = 'Owner';
        ownerImg.style.width = '20px';
        ownerImg.style.height = '20px';
        leftDiv.appendChild(ownerImg);
      } else if (member.role === 'admin') {
        const adminImg = document.createElement('img');
        adminImg.src = '/images/admin.png';
        adminImg.alt = 'Admin';
        adminImg.style.width = '20px';
        adminImg.style.height = '20px';
        leftDiv.appendChild(adminImg);
      }
      
      if (member.muted_until && new Date(member.muted_until) > new Date()) {
        const mutedImg = document.createElement('img');
        mutedImg.src = '/images/mute.png';
        mutedImg.alt = 'Muted';
        mutedImg.style.width = '18px';
        mutedImg.style.height = '18px';
        mutedImg.title = `Muted until ${new Date(member.muted_until).toLocaleString()}`;
        leftDiv.appendChild(mutedImg);
      }
      
      li.appendChild(leftDiv);
      
      // Правая часть — кнопки действий (только для других участников)
      if (member.id !== currentUser.id) {
        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '0.5rem';
        actionsDiv.style.flexWrap = 'wrap';
        
        // Если это канал и текущий пользователь не админ — не показываем кнопки
        if (isChannel && !isAdmin) {
          // ничего
        } else {
          // Существующие кнопки (promote, demote, mute, kick)
          if (isOwner && member.role === 'member') {
            const promoteBtn = document.createElement('button');
            promoteBtn.textContent = '⭐';
            promoteBtn.title = 'Сделать админом';
            promoteBtn.className = 'admin-action-btn';
            promoteBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                await api(`/api/groups/${groupId}/promote`, {
                  method: 'POST',
                  body: JSON.stringify({ userId: member.id })
                });
                showGroupInfo(groupId, groupTitle);
              } catch (err) {
                alert(err.message);
              }
            });
            actionsDiv.appendChild(promoteBtn);
          }
          
          if (isOwner && member.role === 'admin') {
            const demoteBtn = document.createElement('button');
            demoteBtn.textContent = '⬇️';
            demoteBtn.title = 'Снять админа';
            demoteBtn.className = 'admin-action-btn';
            demoteBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                await api(`/api/groups/${groupId}/demote`, {
                  method: 'POST',
                  body: JSON.stringify({ userId: member.id })
                });
                showGroupInfo(groupId, groupTitle);
              } catch (err) {
                alert(err.message);
              }
            });
            actionsDiv.appendChild(demoteBtn);
          }
          
          if ((isOwner || isAdmin) && (member.role !== 'owner' || isOwner)) {
            const isMuted = member.muted_until && new Date(member.muted_until) > new Date();
            
            if (isMuted) {
              const unmuteBtn = document.createElement('button');
              unmuteBtn.innerHTML = '<img src="/images/unmute.png" alt="Unmute" style="width:16px;height:16px;">';
              unmuteBtn.title = 'Размутить';
              unmuteBtn.className = 'admin-action-btn';
              unmuteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  await api(`/api/groups/${groupId}/unmute`, {
                    method: 'POST',
                    body: JSON.stringify({ userId: member.id })
                  });
                  showGroupInfo(groupId, groupTitle);
                } catch (err) {
                  alert(err.message);
                }
              });
              actionsDiv.appendChild(unmuteBtn);
            } else {
              const muteContainer = document.createElement('div');
              muteContainer.style.display = 'flex';
              muteContainer.style.alignItems = 'center';
              muteContainer.style.gap = '4px';

              const muteIcon = document.createElement('img');
              muteIcon.src = '/images/mute.png';
              muteIcon.alt = 'Mute';
              muteIcon.style.width = '16px';
              muteIcon.style.height = '16px';
              muteContainer.appendChild(muteIcon);

              const muteSelect = document.createElement('select');
              muteSelect.className = 'admin-action-btn';
              muteSelect.style.padding = '4px 8px';

              const durations = [
                { value: 5, label: '5 мин' },
                { value: 10, label: '10 мин' },
                { value: 30, label: '30 мин' },
                { value: 60, label: '1 час' },
                { value: 1440, label: '24 часа' }
              ];

              durations.forEach(d => {
                const option = document.createElement('option');
                option.value = d.value;
                option.textContent = d.label;
                muteSelect.appendChild(option);
              });

              muteSelect.addEventListener('change', async (e) => {
                e.stopPropagation();
                const minutes = parseInt(muteSelect.value, 10);
                try {
                  await api(`/api/groups/${groupId}/mute`, {
                    method: 'POST',
                    body: JSON.stringify({ userId: member.id, minutes })
                  });
                  showGroupInfo(groupId, groupTitle);
                } catch (err) {
                  alert(err.message);
                }
              });

              muteContainer.appendChild(muteSelect);
              actionsDiv.appendChild(muteContainer);
            }
          }
          
          const canKick = (isOwner && member.role !== 'owner') || (isAdmin && member.role === 'member');
          if (canKick) {
            const kickBtn = document.createElement('button');
            kickBtn.title = 'Кикнуть';
            kickBtn.className = 'admin-action-btn';
            
            const kickImg = document.createElement('img');
            kickImg.src = '/images/kick.png';
            kickImg.alt = 'Kick';
            kickImg.style.width = '20px';
            kickImg.style.height = '20px';
            kickBtn.appendChild(kickImg);
            
            kickBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (!confirm(`Вы уверены, что хотите кикнуть ${member.username}?`)) return;
              try {
                await api(`/api/groups/${groupId}/kick/${member.id}`, {
                  method: 'DELETE'
                });
                showGroupInfo(groupId, groupTitle);
              } catch (err) {
                alert(err.message);
              }
            });
            actionsDiv.appendChild(kickBtn);
          }
        }
        
        if (actionsDiv.children.length > 0) {
          li.appendChild(actionsDiv);
        }
      }
      
      listEl.appendChild(li);
    });
    
    // Кнопка добавления участника
    const addBtn = $('btn-add-member');
    if (addBtn) {
      // В каналах показываем кнопку только админам
      if (isChannel && !isAdmin) {
        hide(addBtn);
      } else {
        show(addBtn);
        addBtn.dataset.groupId = groupId;
        addBtn.dataset.groupTitle = groupTitle;
      }
    }
    
    // Кнопка выхода из группы/канала (есть у всех)
    let leaveBtnContainer = document.getElementById('leave-group-container');
    if (!leaveBtnContainer) {
      leaveBtnContainer = document.createElement('div');
      leaveBtnContainer.id = 'leave-group-container';
      leaveBtnContainer.style.marginTop = '1.5rem';
      leaveBtnContainer.style.textAlign = 'center';
      listEl.parentNode.appendChild(leaveBtnContainer);
    }
    
    const oldLeaveBtn = document.getElementById('leave-group-btn');
    if (oldLeaveBtn) oldLeaveBtn.remove();
    
    const leaveBtn = document.createElement('button');
    leaveBtn.id = 'leave-group-btn';
    leaveBtn.innerHTML = '<img src="/images/leave.png" alt="Leave" style="width:20px; height:20px; vertical-align:middle;"> Покинуть ' + (isChannel ? 'канал' : 'группу');
    leaveBtn.style.width = '100%';
    leaveBtn.style.padding = '0.75rem';
    leaveBtn.style.backgroundColor = 'var(--danger)';
    leaveBtn.style.color = 'white';
    leaveBtn.style.border = 'none';
    leaveBtn.style.borderRadius = '6px';
    leaveBtn.style.cursor = 'pointer';
    leaveBtn.style.fontSize = '1rem';
    leaveBtn.style.fontWeight = '500';
    leaveBtn.style.transition = 'opacity 0.2s';
    
    leaveBtn.onmouseover = () => { leaveBtn.style.opacity = '0.9'; };
    leaveBtn.onmouseout = () => { leaveBtn.style.opacity = '1'; };
    
    leaveBtn.onclick = async () => {
      const type = isChannel ? 'канал' : 'группу';
      if (!confirm(`Вы уверены, что хотите покинуть ${type} "${groupTitle}"?`)) return;
      
      try {
        await api(`/api/groups/${groupId}/leave`, { method: 'POST' });
        
        hide(modal);
        
        if (currentConversationId === groupId) {
          currentConversationId = null;
          currentConversationIsGroup = false;
          currentConversationIsChannel = false;
          
          const chatPlaceholder = $('chat-placeholder');
          const chatActive = $('chat-active');
          if (chatPlaceholder) show(chatPlaceholder);
          if (chatActive) hide(chatActive);
          
          document.querySelectorAll('.dm-item').forEach(el => {
            el.classList.remove('active');
          });
          
          hideGroupInfoButton();
          
          if (isMobile()) {
            showSidebar();
          }
        }
        
        await loadConversationList();
        showToast(`Вы покинули ${type} "${groupTitle}"`, 'info');
        
      } catch (err) {
        alert('Ошибка при выходе: ' + err.message);
      }
    };
    
    leaveBtnContainer.appendChild(leaveBtn);
    
  } catch (err) {
    listEl.innerHTML = `<li style="color:var(--danger);">Failed to load members</li>`;
  }
}

function showGroupInfoButton(groupId, groupTitle) {
  const header = $('chat-header');
  if (!header) return;
  
  const oldBtn = document.getElementById('group-info-btn');
  if (oldBtn) oldBtn.remove();
  
  const btn = document.createElement('button');
  btn.id = 'group-info-btn';
  btn.innerHTML = '<img src="/images/info.png" alt="Group info" style="width:20px; height:20px;">';
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
      btn.textContent = friend.name || friend.username;
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

// ---- FILE HANDLING ----
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

const fileInput = $('file-input');
const fileInfo = $('fileInfo');

if (fileInput) {
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    const validFiles = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`File "${file.name}" is too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
        continue;
      }
      validFiles.push(file);
    }
    
    if (validFiles.length === 0) return;
    
    pendingFiles.push(...validFiles);
    
    if (fileInfo) {
      const fileNames = validFiles.map(f => f.name).join(', ');
      fileInfo.innerHTML = `
        <div style="color: var(--accent); padding: 4px 0;">
          📎 Selected: ${fileNames}
          <button onclick="window.clearSelectedFiles()" style="margin-left: 8px; padding: 2px 8px; background: var(--surface-hover); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;">Clear</button>
        </div>
      `;
    }
    
    e.target.value = '';
  });
}

window.clearSelectedFiles = function() {
  pendingFiles = [];
  if (fileInfo) {
    fileInfo.innerHTML = '';
  }
};

function showUploadProgress(file, progressId) {
  const messagesList = $('messages-list');
  if (!messagesList) return;

  const progressDiv = document.createElement('div');
  progressDiv.id = progressId;
  progressDiv.className = 'message system'; // используем класс system вместо theirs для визуального отличия
  progressDiv.innerHTML = `
    <div class="file-upload-progress">
      <div class="file-name">📤 Uploading: ${escapeHtml(file.name)}</div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: 0%"></div>
      </div>
      <div class="progress-stats">0% • 0 B / ${formatFileSize(file.size)}</div>
    </div>
  `;
  
  messagesList.appendChild(progressDiv);
  scrollMessagesToBottom();
}

function updateUploadProgress(progressId, percent, loaded, total) {
  const progressDiv = $(progressId);
  if (!progressDiv) return;

  const bar = progressDiv.querySelector('.progress-bar');
  const stats = progressDiv.querySelector('.progress-stats');
  
  if (bar) {
    bar.style.width = percent + '%';
  }
  
  if (stats) {
    stats.textContent = `${Math.round(percent)}% • ${formatFileSize(loaded)} / ${formatFileSize(total)}`;
  }
  
  const container = $('chat-messages-wrapper');
  if (container && container.scrollHeight - container.scrollTop - container.clientHeight <= 30) {
    container.scrollTop = container.scrollHeight;
  }
}

function removeUploadProgress(progressId) {
  const progressDiv = $(progressId);
  if (progressDiv) {
    setTimeout(() => {
      if (progressDiv.parentNode) {
        progressDiv.remove();
      }
    }, 500);
  }
}

function renderFileMessage(messageDiv, fileData) {
  if (!fileData.url) {
    console.warn('File URL is missing');
    const errorDiv = document.createElement('div');
    errorDiv.textContent = '[File error: missing URL]';
    messageDiv.appendChild(errorDiv);
    return;
  }

  const isImage = fileData.mime && fileData.mime.startsWith('image/');
  const isVideo = fileData.mime && fileData.mime.startsWith('video/');
  const isAudio = fileData.mime && fileData.mime.startsWith('audio/');

  // --- Обработка изображений, видео и аудио (без дополнительной обёртки, только медиа) ---
  if (isImage || isVideo || isAudio) {
    const mediaContainer = document.createElement('div');
    mediaContainer.className = 'media-message';

    if (isImage) {
      const img = document.createElement('img');
      img.src = fileData.url;
      img.alt = fileData.name || 'Image';
      img.loading = 'lazy';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '300px';
      img.style.borderRadius = '8px';
      img.style.cursor = 'pointer';
      img.onerror = () => {
        img.style.display = 'none';
        const errorSpan = document.createElement('span');
        errorSpan.textContent = '⚠️ Не удалось загрузить изображение';
        errorSpan.style.color = 'var(--danger)';
        errorSpan.style.fontSize = '0.9rem';
        mediaContainer.appendChild(errorSpan);
        console.error('Failed to load image:', fileData.url);
      };
      img.addEventListener('click', () => openFullscreen(fileData.url, fileData.mime));
      mediaContainer.appendChild(img);
    } else if (isVideo) {
      const video = document.createElement('video');
      video.src = fileData.url;
      video.controls = true;
      video.preload = 'metadata';
      video.style.maxWidth = '100%';
      video.style.maxHeight = '300px';
      video.style.borderRadius = '8px';
      video.onerror = () => {
        video.style.display = 'none';
        const errorSpan = document.createElement('span');
        errorSpan.textContent = '⚠️ Не удалось загрузить видео';
        errorSpan.style.color = 'var(--danger)';
        errorSpan.style.fontSize = '0.9rem';
        mediaContainer.appendChild(errorSpan);
        console.error('Failed to load video:', fileData.url);
      };
      video.addEventListener('click', () => openFullscreen(fileData.url, fileData.mime));
      mediaContainer.appendChild(video);
    } else if (isAudio) {
        messageDiv.classList.add('message-audio');

        const audio = document.createElement('audio');
        audio.src = fileData.url;
        audio.preload = 'metadata';

        const customPlayer = document.createElement('div');
        customPlayer.className = 'custom-audio-player';

        const playBtn = document.createElement('button');
        playBtn.className = 'audio-play-btn';
        playBtn.innerHTML = '<img src="/images/play.png" alt="Play" style="width:16px; height:16px;">';
        playBtn.setAttribute('aria-label', 'Play');

        const timeCurrent = document.createElement('span');
        timeCurrent.className = 'audio-time-current';
        timeCurrent.textContent = '0:00';

        const progressContainer = document.createElement('div');
        progressContainer.className = 'audio-progress-container';

        const progressBar = document.createElement('div');
        progressBar.className = 'audio-progress-bar';
        progressBar.style.width = '0%';

        const progressThumb = document.createElement('div');
        progressThumb.className = 'audio-progress-thumb';

        let isDragging = false;
        const onMouseMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const rect = progressContainer.getBoundingClientRect();
            let x = e.clientX - rect.left;
            x = Math.max(0, Math.min(rect.width, x));
            const percent = x / rect.width;
            if (audio.duration) {
                audio.currentTime = percent * audio.duration;
            }
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }
        };

        progressThumb.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        progressContainer.appendChild(progressBar);
        progressContainer.appendChild(progressThumb);

        const timeTotal = document.createElement('span');
        timeTotal.className = 'audio-time-total';
        timeTotal.textContent = '0:00';

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'audio-download-btn';
        downloadBtn.innerHTML = '<img src="/images/download.png" alt="Download" style="width:16px; height:16px;">';
        downloadBtn.setAttribute('aria-label', 'Download');
        downloadBtn.onclick = (e) => {
            e.stopPropagation();
            window.open(fileData.url, '_blank');
        };

        customPlayer.appendChild(playBtn);
        customPlayer.appendChild(timeCurrent);
        customPlayer.appendChild(progressContainer);
        customPlayer.appendChild(timeTotal);
        customPlayer.appendChild(downloadBtn);

        mediaContainer.appendChild(customPlayer);
        mediaContainer.appendChild(audio);

        // Логика
        audio.addEventListener('loadedmetadata', () => {
            timeTotal.textContent = formatTime(audio.duration);
        });

        audio.addEventListener('timeupdate', () => {
            if (!isDragging) {
                const percent = (audio.currentTime / audio.duration) * 100 || 0;
                progressBar.style.width = percent + '%';
                progressThumb.style.left = percent + '%';
                timeCurrent.textContent = formatTime(audio.currentTime);
            }
        });

        playBtn.addEventListener('click', () => {
            if (audio.paused) {
                audio.play();
                playBtn.innerHTML = '<img src="/images/pause.png" alt="Group info" style="width:20px; height:20px;">';
            } else {
                audio.pause();
                playBtn.innerHTML = '<img src="/images/play.png" alt="Play" style="width:16px; height:16px;">';
            }
        });

        audio.addEventListener('ended', () => {
            playBtn.innerHTML = '<img src="/images/play.png" alt="Play" style="width:16px; height:16px;">';
            progressBar.style.width = '0%';
            progressThumb.style.left = '0%';
            timeCurrent.textContent = '0:00';
        });

        // Перемотка по клику на прогресс-бар
        progressContainer.addEventListener('click', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const width = rect.width;
            const percent = Math.max(0, Math.min(1, clickX / width));
            if (audio.duration) {
                audio.currentTime = percent * audio.duration;
            }
        });

        audio.onerror = () => {
            customPlayer.innerHTML = '⚠️ Не удалось загрузить аудио';
            customPlayer.style.color = 'var(--danger)';
        };
    }

    messageDiv.appendChild(mediaContainer);
    return; // Завершаем, чтобы не создавать стандартную обёртку
  }

  // --- Остальные файлы (документы, архивы и т.д.) ---
  const fileDiv = document.createElement('div');
  fileDiv.className = 'message-file-content';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'file-info-header';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'file-icon';


  iconSpan.innerHTML = ''; // очищаем
  const iconImg = document.createElement('img');
  iconImg.src = '/images/file.png'; // новая функция
  iconImg.alt = 'File';
  iconImg.style.width = '24px';
  iconImg.style.height = '24px';
  iconSpan.appendChild(iconImg);
  headerDiv.appendChild(iconSpan);

  
  const infoDiv = document.createElement('div');
  infoDiv.className = 'file-details';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'file-name';
  nameDiv.textContent = fileData.name || 'Unnamed file';
  infoDiv.appendChild(nameDiv);

  if (fileData.size) {
    const sizeDiv = document.createElement('div');
    sizeDiv.className = 'file-size';
    sizeDiv.textContent = formatFileSize(fileData.size);
    infoDiv.appendChild(sizeDiv);
  }

  headerDiv.appendChild(infoDiv);
  fileDiv.appendChild(headerDiv);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'file-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'file-download-btn';
  downloadBtn.innerHTML = '⬇️ Download';
  downloadBtn.onclick = (e) => {
    e.stopPropagation();
    window.open(fileData.url, '_blank');
  };
  actionsDiv.appendChild(downloadBtn);

  fileDiv.appendChild(actionsDiv);
  messageDiv.appendChild(fileDiv);
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function openFullscreen(url, mimeType) {
  const existingModal = document.querySelector('.file-fullscreen-modal');
  if (existingModal) {
    document.body.removeChild(existingModal);
  }
  
  const modal = document.createElement('div');
  modal.className = 'file-fullscreen-modal';
  modal.style.position = 'fixed';
  modal.style.inset = '0';
  modal.style.background = 'rgba(0, 0, 0, 0.95)';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.zIndex = '2000';
  modal.style.padding = '2rem';
  
  const content = document.createElement('div');
  content.style.position = 'relative';
  content.style.maxWidth = '90vw';
  content.style.maxHeight = '90vh';
  
  const closeBtn = document.createElement('button');
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '-40px';
  closeBtn.style.right = '0';
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.color = 'white';
  closeBtn.style.fontSize = '2rem';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.padding = '8px';
  closeBtn.innerHTML = '✕';
  
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      document.body.removeChild(modal);
      document.removeEventListener('keydown', escHandler);
    }
  };
  
  closeBtn.onclick = () => {
    document.body.removeChild(modal);
    document.removeEventListener('keydown', escHandler);
  };
  
  content.appendChild(closeBtn);
  
  if (mimeType.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '90vh';
    img.style.objectFit = 'contain';
    img.style.borderRadius = '8px';
    content.appendChild(img);
  } else if (mimeType.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '90vh';
    content.appendChild(video);
  }
  
  modal.appendChild(content);
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
      document.removeEventListener('keydown', escHandler);
    }
  });
  
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(modal);
}

function formatFileSize(bytes) {
  if (bytes === 0 || bytes === undefined) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(mime) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('word') || mime.includes('document')) return '📘';
  if (mime.includes('sheet') || mime.includes('excel')) return '📗';
  if (mime.includes('zip') || mime.includes('archive')) return '🗜️';
  return '📎';
}

function showToast(message, type = 'info') {
  let toastContainer = document.querySelector('.toast-container');
  
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    toastContainer.style.position = 'fixed';
    toastContainer.style.bottom = '20px';
    toastContainer.style.right = '20px';
    toastContainer.style.zIndex = '9999';
    document.body.appendChild(toastContainer);
  }
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.backgroundColor = type === 'error' ? 'var(--danger)' : 'var(--surface)';
  toast.style.color = 'var(--text)';
  toast.style.padding = '12px 24px';
  toast.style.borderRadius = '8px';
  toast.style.marginTop = '10px';
  toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  toast.style.animation = 'slideIn 0.3s ease';
  toast.style.border = '1px solid var(--border)';
  
  toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(style);

// ---- CALL HANDLING ----

function findConversationByUserId(userId) {
  // Ищем личный чат с otherUser.id === userId
  return conversationListCache.find(c => !c.isGroup && c.otherUser?.id === userId);
}

function initSignalingChannel() {
  if (!currentUser) return;
  
  if (signalingChannel) return;
  
  const url = `${API}/api/signaling`;
  signalingChannel = new EventSource(url, { withCredentials: true });
  
  signalingChannel.addEventListener('offer', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleRemoteOffer(data);
    } catch (err) {
      console.error('Error parsing offer:', err);
    }
  });
  
  signalingChannel.addEventListener('answer', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleRemoteAnswer(data);
    } catch (err) {
      console.error('Error parsing answer:', err);
    }
  });
  
  signalingChannel.addEventListener('ice-candidate', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleRemoteCandidate(data);
    } catch (err) {
      console.error('Error parsing ice-candidate:', err);
    }
  });
  
  signalingChannel.addEventListener('call-ended', (e) => {
    try {
      const data = JSON.parse(e.data);
      endPeerConnection(data.fromUserId);
    } catch (err) {
      console.error('Error parsing call-ended:', err);
    }
  });
  
  // Новый обработчик call-rejected
  signalingChannel.addEventListener('call-rejected', (e) => {
    try {
      const data = JSON.parse(e.data);
      showToast(`${getRemoteName(data.fromUserId)} отклонил звонок`, 'info');
      endCall();
    } catch (err) {
      console.error('Error parsing call-rejected:', err);
    }
  });
  
  signalingChannel.onerror = () => {
    console.error('Signaling error');
    signalingChannel.close();
    signalingChannel = null;
    setTimeout(initSignalingChannel, 3000);
  };
}

async function startCall() {
  if (!currentConversationId) return;
  if (callActive) return;

  try {
    callActive = true;
    currentCallConversationId = currentConversationId;
    showCallUI();
    initSignalingChannel();

    // Проверить поддержку getUserMedia
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Your browser does not support audio calls.');
    }

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.onended = () => {
      endCall();
    };

    const conversation = conversationListCache.find(c => c.id === currentConversationId);
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    updateCallStatus('Starting call...');
    currentCallId = `call_${Date.now()}`;

    if (!conversation.isGroup && conversation.otherUser) {
      await createPeerConnection(conversation.otherUser.id, true);
    }
    else if (conversation.isGroup) {
      try {
        const groupData = await api(`/api/groups/${currentConversationId}`);
        const members = groupData.participants;
        for (const member of members) {
          if (member.id !== currentUser.id) {
            await createPeerConnection(member.id, true);
          }
        }
      } catch (e) {
        console.error('Failed to get group members:', e);
        showToast('Не удалось получить список участников группы', 'error');
        await endCall();
      }
    }
    
  } catch (error) {
    console.error('Error starting call:', error);
    let message = error.message;
    if (error.name === 'NotAllowedError' || error.message.includes('Permission denied')) {
      message = 'Microphone access denied. Please allow microphone permissions in your browser.';
    } else if (error.name === 'NotFoundError') {
      message = 'No microphone found. Please connect a microphone.';
    }
    alert('Failed to start call: ' + message);
    callActive = false;
    currentCallConversationId = null;
    updateCallStatus('');
    hideCallUI();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
  }
}

async function createPeerConnection(targetUserId, initiator = false) {
  try {
    if (peerConnections.has(targetUserId)) return;
    
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
      ]
    });
    
    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }
    
    peerConnection.addEventListener('track', (event) => {
      console.log('Received remote track:', event.track.kind);
      remoteStreams.set(targetUserId, event.streams[0]);
      playRemoteStream(event.streams[0], targetUserId);
    });
    
    peerConnection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        sendSignalingMessage('ice-candidate', {
          targetUserId,
          candidate: event.candidate,
          conversationId: currentCallConversationId
        });
      }
    });
    
    peerConnection.addEventListener('connectionstatechange', () => {
      console.log(`Connection state with ${targetUserId}:`, peerConnection.connectionState);
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        endPeerConnection(targetUserId);
      }
    });
    
    peerConnection.addEventListener('iceconnectionstatechange', () => {
      console.log(`ICE connection state with ${targetUserId}:`, peerConnection.iceConnectionState);
    });
    
    peerConnections.set(targetUserId, peerConnection);
    
    if (initiator) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      sendSignalingMessage('offer', {
        targetUserId,
        offer: offer,
        conversationId: currentCallConversationId
      });
      updateCallStatus(`Calling ${getRemoteName(targetUserId)}...`);
    }
    
  } catch (error) {
    console.error('Error creating peer connection:', error);
  }
}

async function handleRemoteOffer(data) {
  const { fromUserId, offer, conversationId } = data;
  
  // Проверяем, относится ли звонок к текущему активному чату
  if (callActive) {
    if (currentCallConversationId && currentCallConversationId !== conversationId) {
      // Звонок для другого чата — отклоняем
      console.log('Call already active in another conversation, rejecting');
      sendSignalingMessage('call-rejected', { targetUserId: fromUserId, conversationId });
      return;
    }
    // Если тот же чат, продолжаем (возможно переподключение)
  }
  
  // Если нет conversationId, пытаемся найти личный чат по fromUserId
  let targetConversationId = conversationId;
  if (!targetConversationId) {
    const conv = findConversationByUserId(fromUserId);
    if (conv) {
      targetConversationId = conv.id;
    } else {
      console.log('Incoming call from unknown user, rejecting');
      sendSignalingMessage('call-rejected', { targetUserId: fromUserId });
      return;
    }
  }
  
  // Переключаемся на нужный чат, если ещё не там
  if (currentConversationId !== targetConversationId) {
    await selectConversation(targetConversationId);
  }
  
  try {
    let peerConnection = peerConnections.get(fromUserId);
    
    if (!peerConnection) {
      if (!callActive) {
        if (!confirm(`${getRemoteName(fromUserId)} is calling. Accept?`)) {
          sendSignalingMessage('call-rejected', { targetUserId: fromUserId, conversationId: targetConversationId });
          return;
        }
        callActive = true;
        currentCallConversationId = targetConversationId;
        showCallUI();
        initSignalingChannel();
        
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err) {
          console.error('Failed to get media for incoming call:', err);
          callActive = false;
          currentCallConversationId = null;
          hideCallUI();
          sendSignalingMessage('call-rejected', { targetUserId: fromUserId, conversationId: targetConversationId });
          return;
        }
      }
      
      await createPeerConnection(fromUserId, false);
      peerConnection = peerConnections.get(fromUserId);
    }
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    sendSignalingMessage('answer', {
      targetUserId: fromUserId,
      answer: answer,
      conversationId: targetConversationId
    });
    
    updateCallStatus('Connected');
    
  } catch (error) {
    console.error('Error handling offer:', error);
  }
}

async function handleRemoteAnswer(data) {
  const { fromUserId, answer } = data;
  
  try {
    const peerConnection = peerConnections.get(fromUserId);
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      updateCallStatus('Connected');
    }
  } catch (error) {
    console.error('Error handling answer:', error);
  }
}

async function handleRemoteCandidate(data) {
  const { fromUserId, candidate } = data;
  
  try {
    const peerConnection = peerConnections.get(fromUserId);
    if (peerConnection && candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (error) {
    console.error('Error handling ICE candidate:', error);
  }
}

function sendSignalingMessage(type, data) {
  api('/api/signaling', {
    method: 'POST',
    body: JSON.stringify({
      type,
      ...data
    })
  }).catch(e => {
    console.error('Signaling error:', e);
    showToast('Ошибка отправки сигнала', 'error');
  });
}

async function endCall() {
  callActive = false;
  currentCallConversationId = null;
  updateCallStatus('');
  hideCallUI();
  
  // Очищаем все удалённые аудиоэлементы
  remoteAudioElements.forEach((audio, userId) => {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  });
  remoteAudioElements.clear();
  
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  
  peerConnections.forEach((pc, userId) => {
    endPeerConnection(userId);
  });
  peerConnections.clear();
  remoteStreams.clear();
  
  if (currentConversationId) {
    const conversation = conversationListCache.find(c => c.id === currentConversationId);
    if (!conversation) return;
    
    if (!conversation.isGroup && conversation.otherUser) {
      sendSignalingMessage('call-ended', { targetUserId: conversation.otherUser.id, conversationId: currentConversationId });
    } else if (conversation.isGroup) {
      try {
        const groupData = await api(`/api/groups/${currentConversationId}`);
        const members = groupData.participants;
        for (const member of members) {
          if (member.id !== currentUser.id) {
            sendSignalingMessage('call-ended', { targetUserId: member.id, conversationId: currentConversationId });
          }
        }
      } catch (e) {}
    }
  }
}

function endPeerConnection(userId) {
  const pc = peerConnections.get(userId);
  if (pc) {
    pc.close();
    peerConnections.delete(userId);
  }
  remoteStreams.delete(userId);
  
  // Удаляем соответствующий аудиоэлемент
  const audio = remoteAudioElements.get(userId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    remoteAudioElements.delete(userId);
  }
}

function playRemoteStream(stream, userId) {
  let audio = remoteAudioElements.get(userId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = `remote-audio-${userId}`;
    audio.autoplay = true;
    // Можно добавить контейнер, но можно просто в body
    document.body.appendChild(audio);
    remoteAudioElements.set(userId, audio);
  }
  audio.srcObject = stream;
  audio.play().catch(e => console.error('Play error:', e));
}

function getRemoteName(userId) {
  const conversation = conversationListCache.find(c => c.id === currentConversationId);
  if (!conversation) return 'User';
  
  if (!conversation.isGroup && conversation.otherUser) {
    return conversation.otherUser.username;
  }
  
  return 'User ' + String(userId).substring(0, 8);
}

function updateCallStatus(status) {
  const bar = $('call-status-bar');
  const text = $('call-status-text');
  
  if (status) {
    if (bar) bar.classList.remove('hidden');
    if (text) text.textContent = status;
  } else {
    if (bar) bar.classList.add('hidden');
  }
}

function showCallUI() {
  const btn = $('btn-call');
  const btnEnd = $('btn-end-call');
  
  if (btn) {
    btn.style.display = 'inline-block';
    btn.disabled = true;
    btn.innerHTML = '<img src="/images/call.png" alt="Call" style="width:20px; height:20px;">';
  }
  
  if (btnEnd) {
    btnEnd.style.display = 'inline-block';
  }
}

function hideCallUI() {
  const btn = $('btn-call');
  const btnEnd = $('btn-end-call');
  const bar = $('call-status-bar');
  
  if (btn) {
    btn.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<img src="/images/call.png" alt="Call" style="width:20px; height:20px;">';
  }
  
  if (btnEnd) {
    btnEnd.style.display = 'none';
  }
  
  if (bar) {
    bar.classList.add('hidden');
  }
}

const btnCall = $('btn-call');
if (btnCall) {
  btnCall.addEventListener('click', async () => {
    if (callActive) {
      await endCall();
    } else {
      await startCall();
    }
  });
}

const btnEndCall = $('btn-end-call');
if (btnEndCall) {
  btnEndCall.addEventListener('click', async () => {
    await endCall();
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
  initContextMenu();
  
  tryAutoLogin();
});