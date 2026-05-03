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
let currentReplyTo = null; // { id, text, senderName }

// В DOMContentLoaded или при создании, добавим плашку ответа
const replyPreview = document.getElementById('reply-preview');
const replySenderName = document.getElementById('reply-sender-name');
const replyTextSpan = document.getElementById('reply-text');
const replyCancel = document.getElementById('reply-cancel');
const $ = (id) => document.getElementById(id);
const vapidMeta = document.querySelector('meta[name="vapid-public-key"]');
const publicVapidKey = vapidMeta ? vapidMeta.content : null;
const chatHeader = document.getElementById('chat-header');

if (chatHeader) {
  const observer = new MutationObserver(() => adjustChatMessagesPadding());
  observer.observe(chatHeader, { childList: true, subtree: true, attributes: true });
}

// Функция для динамического отступа снизу
function updateChatMessagesPaddingBottom() {
  const wrapper = document.getElementById('chat-messages-wrapper');
  const sendForm = document.getElementById('send-form');
  const previewList = document.getElementById('file-preview-list');
  if (!wrapper) return;

  let totalHeight = 0;
  if (sendForm && sendForm.style.display !== 'none' && sendForm.offsetHeight > 0) {
    totalHeight += sendForm.offsetHeight;
  }
  if (previewList && previewList.style.display !== 'none' && previewList.children.length > 0) {
    totalHeight += previewList.offsetHeight;
  }
  wrapper.style.paddingBottom = totalHeight + 'px';
}

// Функция для динамического отступа под заголовок
function adjustChatMessagesPadding() {
  const header = document.getElementById('chat-header');
  const wrapper = document.getElementById('chat-messages-wrapper');
  if (header && wrapper) {
    const headerHeight = header.offsetHeight;
    // Сохраняем текущую прокрутку
    const scrollTop = wrapper.scrollTop;
    wrapper.style.paddingTop = headerHeight + 'px';
    // Восстанавливаем прокрутку, если она изменилась
    if (wrapper.scrollTop !== scrollTop) {
      wrapper.scrollTop = scrollTop;
    }
  }
}

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
    // Проверяем, есть ли ожидающий код друга
    const pendingCode = localStorage.getItem('pendingFriendCode');
    if (pendingCode) {
      localStorage.removeItem('pendingFriendCode');
      await addFriendByCode(pendingCode);
    }
  } catch (err) {
    currentUser = null;
    localStorage.removeItem('user');
  }
  renderScreen();
  await processInviteJoin();
}

function renderScreen() {
  console.log('renderScreen called', { currentUser });
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('Service Worker registered');
        return Notification.requestPermission();
      })
      .then(permission => {
        if (permission === 'granted') {
          subscribeUserToPush();
        }
      })
      .catch(err => console.error('Service Worker error:', err));
  }

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
let filePreviewList;
let fileTypeMenu;
let currentFileInputAccept = 'image/*,video/*'; // по умолчанию фото/видео

function renderFilePreviews() {
  if (!filePreviewList) return;
  filePreviewList.innerHTML = '';
  if (pendingFiles.length === 0) {
    filePreviewList.style.display = 'none';
    updateSendFormPosition();
    updateChatMessagesPaddingBottom(); // вызовем здесь, если превью скрыто
    return;
  }
  filePreviewList.style.display = 'flex';
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    const item = document.createElement('div');
    item.className = 'file-preview-item';
    item.dataset.index = i;

    // Создаём превью
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(file);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      item.appendChild(img);
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);
      video.src = url;
      video.muted = true;
      video.autoplay = false;
      video.onloadeddata = () => URL.revokeObjectURL(url);
      item.appendChild(video);
    } else {
      const iconDiv = document.createElement('div');
      iconDiv.className = 'file-icon';
      iconDiv.textContent = getFileIcon(file.type);
      item.appendChild(iconDiv);
    }

    // Имя файла
    const nameSpan = document.createElement('div');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file.name.length > 15 ? file.name.slice(0, 12) + '…' : file.name;
    item.appendChild(nameSpan);

    // Кнопка удаления
    const removeBtn = document.createElement('div');
    removeBtn.className = 'remove-file';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingFiles.splice(i, 1);
      renderFilePreviews();
    });
    item.appendChild(removeBtn);

    filePreviewList.appendChild(item);
  }

  // После добавления всех превью обновляем позицию формы и отступ снизу
  updateSendFormPosition();
  updateChatMessagesPaddingBottom();

  // Если пользователь внизу чата, прокручиваем вниз
  const container = document.getElementById('chat-messages-wrapper');
  if (container && isAtBottom) {
    scrollMessagesToBottom();
  }
}

function updateSendFormPosition() {
  const sendForm = $('send-form');
  const previewList = $('file-preview-list');
  if (!sendForm || !previewList) return;

  let previewHeight = 0;
  // Если превью отображается и содержит элементы
  if (previewList.children.length > 0 && previewList.style.display !== 'none') {
    previewHeight = previewList.offsetHeight;
  }
  sendForm.style.bottom = previewHeight + 'px';
  updateChatMessagesPaddingBottom();
}

function showFileTypeMenu(buttonElement) {
  if (!fileTypeMenu) return;

  // Меню лежит внутри chat-area, у которого на мобильных есть transform.
  // Переносим его в body, чтобы position: fixed считался относительно экрана, а не контейнера.
  if (fileTypeMenu.parentElement !== document.body) {
    document.body.appendChild(fileTypeMenu);
  }

  // Снимаем старые обработчики, если меню открывали раньше.
  if (fileTypeMenu._closeMenuHandler) {
    document.removeEventListener('click', fileTypeMenu._closeMenuHandler);
    document.removeEventListener('touchstart', fileTypeMenu._closeMenuHandler);
    fileTypeMenu._closeMenuHandler = null;
  }

  // Временно показываем меню, чтобы измерить его реальные размеры
  fileTypeMenu.style.visibility = 'hidden';
  fileTypeMenu.classList.remove('hidden');
  const menuWidth = fileTypeMenu.offsetWidth;
  const menuHeight = fileTypeMenu.offsetHeight;
  fileTypeMenu.classList.add('hidden');
  fileTypeMenu.style.visibility = '';

  const safeMenuWidth = menuWidth || 180;
  const safeMenuHeight = menuHeight || 100;

  const buttonRect = buttonElement.getBoundingClientRect();
  const margin = 10;

  // Горизонтальное центрирование с учётом границ экрана
  let left = buttonRect.left + (buttonRect.width / 2) - (safeMenuWidth / 2);
  left = Math.max(margin, Math.min(window.innerWidth - safeMenuWidth - margin, left));

  // Вертикальное позиционирование: сначала пытаемся открыть вниз, если не хватает места — вверх
  let top;
  const spaceBelow = window.innerHeight - buttonRect.bottom;
  if (spaceBelow >= safeMenuHeight + margin) {
    top = buttonRect.bottom + 5;
  } else {
    top = buttonRect.top - safeMenuHeight - 5;
    if (top < margin) top = margin;
  }

  fileTypeMenu.style.left = left + 'px';
  fileTypeMenu.style.top = top + 'px';
  fileTypeMenu.classList.remove('hidden');

  // Корректировка позиции после фактического отображения (на случай изменения размеров)
  requestAnimationFrame(() => {
    const finalRect = fileTypeMenu.getBoundingClientRect();
    let finalTop = finalRect.top;
    if (finalTop < margin) {
      finalTop = margin;
      fileTypeMenu.style.top = finalTop + 'px';
    } else if (finalRect.bottom > window.innerHeight - margin) {
      finalTop = window.innerHeight - finalRect.height - margin;
      if (finalTop < margin) finalTop = margin;
      fileTypeMenu.style.top = finalTop + 'px';
    }
  });

  // Закрытие при клике вне меню (для мобильных добавляем touchstart)
  const closeMenu = (e) => {
    if (!fileTypeMenu.contains(e.target) && !buttonElement.contains(e.target)) {
      fileTypeMenu.classList.add('hidden');
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('touchstart', closeMenu);
      fileTypeMenu._closeMenuHandler = null;
    }
  };
  fileTypeMenu._closeMenuHandler = closeMenu;
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('touchstart', closeMenu);
  }, 0);
}

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
let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  if (notificationAudio) {
    const originalVolume = notificationAudio.volume;
    notificationAudio.volume = 0;
    notificationAudio.play()
      .then(() => {
        notificationAudio.pause();
        notificationAudio.volume = originalVolume;
        audioUnlocked = true;
        console.log('Audio unlocked');
      })
      .catch(e => console.log('Audio unlock failed:', e));
  }
}

document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);

notificationAudio.addEventListener('canplaythrough', () => console.log('Notification audio ready'));
notificationAudio.addEventListener('error', (e) => console.error('Notification audio error:', e));

function playNotificationSound(conversationId) {
  if (conversationId && conversationId === currentConversationId) return;

  if (!notificationAudio || notificationAudio.readyState < 2) {
    console.warn('Audio not loaded yet');
    return;
  }

  try {
    notificationAudio.currentTime = 0;
    notificationAudio.play().catch(err => {
      console.warn('Playback blocked:', err);
    });
  } catch (e) {
    console.error('Play error:', e);
  }
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
      
      // ✅ Добавляем друга только после успешного входа
      const pendingCode = localStorage.getItem('pendingFriendCode');
      if (pendingCode) {
        localStorage.removeItem('pendingFriendCode');
        await addFriendByCode(pendingCode);
      }
      
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
      
      // ✅ Добавляем друга только после успешной регистрации
      const pendingCode = localStorage.getItem('pendingFriendCode');
      if (pendingCode) {
        localStorage.removeItem('pendingFriendCode');
        await addFriendByCode(pendingCode);
      }
      
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

function setReplyTo(messageElement) {
  const messageId = messageElement.dataset.messageId;
  if (!messageId) return;

  // Ищем имя отправителя
  const senderNameEl = messageElement.querySelector('.message-sender');
  const senderName = senderNameEl ? senderNameEl.textContent.trim() : 'Unknown';

  // Текст или имя файла
  let text = '';
  const bodyEl = messageElement.querySelector('.message-body');
  const fileEl = messageElement.querySelector('.message-file-content');
  if (bodyEl) {
    text = bodyEl.textContent.trim().substring(0, 100);
  } else if (fileEl) {
    const fileNameEl = fileEl.querySelector('.file-name');
    text = fileNameEl ? `📎 ${fileNameEl.textContent.trim()}` : 'Файл';
  } else {
    text = 'Сообщение';
  }

  currentReplyTo = { id: messageId, text, senderName };
  renderReplyPreview();
}

function renderReplyPreview() {
  if (!replyPreview) return;
  if (currentReplyTo) {
    replySenderName.textContent = currentReplyTo.senderName;
    replyTextSpan.textContent = currentReplyTo.text;
    replyPreview.classList.remove('hidden');
  } else {
    replyPreview.classList.add('hidden');
  }
}

function clearReplyTo() {
  currentReplyTo = null;
  renderReplyPreview();
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

        if (message.sender_id === currentUser.id) {
          message.read = false;
        }

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
      }else if (data.type === 'messages_read') {
        handleMessagesRead(data);
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
      } else if (data.type === 'new_dm') {
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

function scrollToMessage(messageId) {
  const element = document.querySelector(`.message[data-message-id="${messageId}"]`);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.style.backgroundColor = 'rgba(99,102,241,0.2)';
    setTimeout(() => {
      element.style.backgroundColor = '';
    }, 2000);
  } else {
    // Сообщение может быть не загружено, но по идее оно есть
    console.warn('Message not found', messageId);
  }
}

// ---- Создание элемента сообщения ----
function createMessageElement(message, isGroup, currentUserId) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ' + (message.sender_id === currentUserId ? 'mine' : 'theirs');
  messageDiv.dataset.messageId = message.id;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (message.reply_to) {
    const replyBlock = document.createElement('div');
    replyBlock.className = 'message-reply-preview';
    replyBlock.dataset.replyId = message.reply_to.id;
    let replyText = message.reply_to.body || '';
    // Если тело ответа — JSON с файлом, преобразуем в читаемый вид
    if (replyText.startsWith('{')) {
      try {
        const parsed = JSON.parse(replyText);
        if (parsed.type === 'file') {
          replyText = `📎 ${parsed.name || 'Файл'}`;
        } else if (parsed.type === 'gallery') {
          replyText = `📷 Галерея (${parsed.files?.length || 0} фото/видео)`;
        } else if (parsed.type === 'composite') {
          if (parsed.text) {
            replyText = parsed.text;
          } else {
            replyText = `📎 ${parsed.files?.length || 0} файлов`;
          }
        }
      } catch (_) {}
    }
    if (replyText.length > 100) replyText = replyText.slice(0, 97) + '…';
    replyBlock.innerHTML = `
      <span class="reply-icon">↩️</span>
      <strong>${escapeHtml(message.reply_to.senderName)}</strong>
      <span>${escapeHtml(replyText)}</span>
    `;
    replyBlock.addEventListener('click', (e) => {
      e.stopPropagation();
      scrollToMessage(message.reply_to.id);
    });
    contentDiv.appendChild(replyBlock);
  }

  if (isGroup && message.sender_id !== currentUserId) {
    const nameSpan = document.createElement('div');
    nameSpan.className = 'message-sender';
    nameSpan.textContent = message.sender_username || 'Unknown';
    contentDiv.appendChild(nameSpan);
  }

    // Проверка на файл или составное сообщение
  let isFile = false;
  let fileData = null;
  if (message.message_type === 'file' || message.message_type === 'gallery' || message.message_type === 'composite') {
    try {
      fileData = JSON.parse(message.body);
      if (fileData.type === 'file' || fileData.type === 'gallery' || fileData.type === 'composite') {
        isFile = true;
      }
    } catch (e) {}
  }

  if (isFile && fileData) {
    if (fileData.type === 'composite') {
      // Текст
      if (fileData.text) {
        const textDiv = document.createElement('div');
        textDiv.className = 'message-body';
        textDiv.textContent = fileData.text;
        contentDiv.appendChild(textDiv);
      }
      // Файлы (галерея)
      if (fileData.files && fileData.files.length) {
        renderGallery(contentDiv, fileData.files);
      }
    } else if (fileData.type === 'gallery') {
      renderGallery(contentDiv, fileData.files);
      contentDiv.classList.add('gallery-message-container');
    } else if (fileData.type === 'file') {
      renderFileMessage(contentDiv, fileData, messageDiv);
    }
  } else {
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    bodyDiv.textContent = message.body;
    contentDiv.appendChild(bodyDiv);
  }

  // Реакции (отображаемые под сообщением)
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
    contentDiv.appendChild(reactionsBar);
  }

  // Мета-информация (дата)
  const metaDiv = document.createElement('div');
  metaDiv.className = 'message-meta';
  metaDiv.textContent = new Date(message.created_at).toLocaleString();
  contentDiv.appendChild(metaDiv);

  if (message.sender_id === currentUserId && message.read === false) {
    const indicator = document.createElement('span');
    indicator.className = 'message-read-indicator';
    indicator.setAttribute('aria-label', 'Не прочитано');
    contentDiv.appendChild(indicator);
  }
  messageDiv.appendChild(contentDiv);
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
        } else if (fileData.type === 'gallery') {
          displayText = `📷 Галерея (${fileData.files.length} файлов)`;
        } else if (fileData.type === 'composite') {
          if (fileData.text) {
            displayText = fileData.text;
          } else {
            displayText = `📎 ${fileData.files.length} файлов`;
          }
        }
      } catch (e) {
        // ignore
      }
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

  // Добавляем пункт "Ответить" перед "Удалить"
  const actionsContainer = contextMenu.querySelector('.context-menu-actions');
  const deleteItem = actionsContainer.querySelector('[data-action="delete"]');
  const replyItem = document.createElement('div');
  replyItem.className = 'context-menu-item';
  replyItem.dataset.action = 'reply';
  replyItem.textContent = 'Ответить';

  if (deleteItem) {
    actionsContainer.insertBefore(replyItem, deleteItem);
  } else {
    actionsContainer.appendChild(replyItem);
  }

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
    } else if (action === 'reply') {
      setReplyTo(currentContextMessage);
      hideContextMenu();
    } else if (action === 'react') {
      e.preventDefault();
      e.stopPropagation();
      const message = currentContextMessage;
      hideContextMenu();
      if (message) {
        const rect = message.getBoundingClientRect();
        showEmojiPicker(message, rect.right, rect.top);
      }
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

  const reactionsContainer = contextMenu.querySelector('.context-menu-reactions');
  if (reactionsContainer) {
    reactionsContainer.innerHTML = '';
    EMOJIS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-menu-btn';
      btn.dataset.emoji = emoji.code;
      btn.innerHTML = `<img src="/images/emojis/${emoji.img}" alt="${emoji.code}" class="emoji-img">`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const messageId = currentContextMessage.dataset.messageId;
        toggleReaction(messageId, emoji.code);
        hideContextMenu();
      });
      reactionsContainer.appendChild(btn);
    });
  }

  contextMenu.classList.remove('hidden'); 
}

async function subscribeUserToPush() {
  if (!publicVapidKey) {
    console.warn('VAPID public key missing, push notifications disabled');
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
  });

  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription })
  });
}

// Helper to convert VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.classList.add('hidden');
    currentContextMessage = null;
  }
}

function copyMessageContent(messageElement) {
  const bodyEl = messageElement.querySelector('.message-body');
  if (bodyEl) {
    navigator.clipboard.writeText(bodyEl.textContent).then(() => {
      showToast('Скопировано', 'info');
    }).catch(() => {
      showToast('Не удалось скопировать', 'error');
    });
    return;
  }

  const fileNameEl = messageElement.querySelector('.file-name');
  if (fileNameEl) {
    navigator.clipboard.writeText(fileNameEl.textContent).then(() => {
      showToast('Скопировано', 'info');
    }).catch(() => {
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

// Переменные для долгого нажатия (мобильные)
let longPressTimer = null;
let longPressTarget = null;
let longPressStartX = 0, longPressStartY = 0;

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressTarget = null;
}

function showContextMenuAt(message, clientX, clientY) {
  if (contextMenu && !contextMenu.classList.contains('hidden') && currentContextMessage === message) {
    hideContextMenu();
    return;
  }
  showContextMenu(message, clientX, clientY);
}

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
        list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Нет чатов. Начните новый диалог!</p>';
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
        list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Не удалось загрузить чаты</p>';
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
  adjustChatMessagesPadding();
  clearReplyTo();
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
    if (userRole === 'owner' || userRole === 'admin') {
      show(sendForm);
    } else {
      hide(sendForm);
    }
    updateChatMessagesPaddingBottom(); // добавляем
    hide(btnCall);
  } else {
    show(sendForm);
    updateChatMessagesPaddingBottom(); // добавляем
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
  
  // Восстанавливаем индикатор печати, если другой участник печатает
  const conv = conversationListCache.find(c => c.id === convId);
  if (conv && conv.typingUserId) {
    const typingUser = conv.isGroup 
      ? `Пользователь ${conv.typingUserId}` 
      : (conv.otherUser?.name || conv.otherUser?.username || 'Кто-то');
    showTypingIndicator(typingUser, conv);
  }

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
  { code: 'heart', img: 'heart.png', display: '❤️' },
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

  // Заполняем панель кнопками эмодзи
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

  // Показываем панель, чтобы измерить её размеры
  picker.style.visibility = 'hidden';
  picker.classList.remove('hidden');
  
  const pickerWidth = picker.offsetWidth;
  const pickerHeight = picker.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Корректируем позицию, чтобы панель не выходила за края
  if (x + pickerWidth > viewportWidth - 10) {
    x = viewportWidth - pickerWidth - 10;
  }
  if (y + pickerHeight > viewportHeight - 10) {
    y = viewportHeight - pickerHeight - 10;
  }
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  picker.style.left = x + 'px';
  picker.style.top = y + 'px';
  picker.style.visibility = 'visible';

  // Закрытие по клику вне панели
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

  // Находим контейнер содержимого сообщения
  const contentDiv = messageEl.querySelector('.message-content');
  if (!contentDiv) return;

  let reactionsBar = contentDiv.querySelector('.message-reactions');
  if (!reactionsBar) {
    reactionsBar = document.createElement('div');
    reactionsBar.className = 'message-reactions';
    // Вставляем перед мета-информацией, если она есть, иначе в конец
    const meta = contentDiv.querySelector('.message-meta');
    if (meta) {
      contentDiv.insertBefore(reactionsBar, meta);
    } else {
      contentDiv.appendChild(reactionsBar);
    }
  }

  // Поиск или создание элемента для данного эмодзи
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

  // Если после удаления реакций блок остался пустым – убираем его
  if (reactionsBar.children.length === 0) reactionsBar.remove();
}

function handleMessagesRead(data) {
  const { conversationId, messageIds } = data;
  // Если это текущий открытый чат
  if (currentConversationId === conversationId) {
    messageIds.forEach(msgId => {
      const msgEl = document.querySelector(`.message[data-message-id="${msgId}"]`);
      if (msgEl && msgEl.classList.contains('mine')) {
        const indicator = msgEl.querySelector('.message-read-indicator');
        if (indicator) indicator.remove();
      }
    });
  }
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
    list.innerHTML = '<p style="color:var(--text-muted)">Не удалось загрузить сообщения</p>';
  }
}

// Отправка сообщений
const sendForm = $('send-form');
if (sendForm) {
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (window._sendingMessage) return;
    window._sendingMessage = true;
    if (!currentConversationId) return;

    const input = $('message-input');
    if (!input) return;

    const body = input.value.trim();
    const files = pendingFiles.splice(0);
    const replyToId = currentReplyTo ? currentReplyTo.id : null;

    renderFilePreviews();

    // Если есть и текст, и файлы → составное сообщение
    if (body && files.length) {
      try {
        await sendCompositeMessage(body, files, replyToId);
        input.value = '';
        input.focus();
        clearReplyTo();
      } catch (err) {
        alert('Ошибка при отправке: ' + err.message);
        pendingFiles.unshift(...files);
        renderFilePreviews();
        input.value = body;
      }
    }
    // Только файлы (галерея или одиночные файлы)
    else if (files.length) {
      const mediaFiles = files.filter(isMediaFile);
      const otherFiles = files.filter(f => !isMediaFile(f));

      if (mediaFiles.length >= 2 && mediaFiles.length <= 10 && otherFiles.length === 0) {
        try {
          await sendGallery(mediaFiles, replyToId);
          clearReplyTo();
        } catch (err) {
          alert('Ошибка при отправке галереи: ' + err.message);
          pendingFiles.unshift(...mediaFiles);
          renderFilePreviews();
        }
      } else {
        for (const file of files) {
          try {
            await sendFileWithProgress(file, currentConversationId, replyToId);
            clearReplyTo();
          } catch (err) {
            alert('Ошибка при отправке файла: ' + err.message);
            pendingFiles.unshift(file);
            renderFilePreviews();
          }
        }
      }
    }
    // Только текст
    else if (body) {
      try {
        const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body, replyToId }),
        });
        if (!currentConversationIsGroup) msg.read = false;
        appendMessageToChat(msg);
        input.value = '';
        input.focus();
        updateSidebarRow(currentConversationId, body);
        const conversation = conversationListCache.find(c => c.id === currentConversationId);
        if (conversation) conversation.lastMessage = body;
        clearReplyTo();
      } catch (err) {
        input.value = body;
        alert('Ошибка отправки сообщения: ' + err.message);
      }
    }
    window._sendingMessage = false;
    requestAnimationFrame(() => scrollMessagesToBottom());
  });
}

async function sendFileWithProgress(file, conversationId, replyToId) {
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
            downloadUrl: fileData.downloadUrl,
            name: fileData.name,
            mime: fileData.type,
            size: file.size
          };

          const msg = await api(`/api/conversations/${conversationId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ body: JSON.stringify(fileMessage), replyToId }),
          });

          if (!currentConversationIsGroup) {
            msg.read = false;
          }
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

// ---- Friends modal ----

// Добавление друга по ссылке
async function addFriendByCode(code) {
  if (!code) return false;
  try {
    const result = await api('/api/friends', {
      method: 'POST',
      body: JSON.stringify({ friendCode: code })
    });
    // После добавления друга создаём личный чат
    if (result && result.id) {
      const dmData = await api('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ otherUserId: result.id })
      });
      showToast(`Пользователь ${result.username} добавлен в друзья!`, 'success');
      if (dmData && dmData.conversationId) {
        await selectConversation(dmData.conversationId);
        if (isMobile()) showChat();
      }
      return true;
    }
  } catch (err) {
    console.error('Add friend by code error:', err);
    if (err.message.includes('already')) {
      showToast('Этот пользователь уже у вас в друзьях', 'info');
    } else {
      showToast('Не удалось добавить друга по ссылке: ' + err.message, 'error');
    }
    return false;
  }
  return false;
}

// Обработка параметра code в URL
function checkAndAddFriendFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (!code) return;

  // Убираем параметр из URL, чтобы при обновлении страницы не добавлять повторно
  const newUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, newUrl);

  if (currentUser) {
    // Пользователь уже авторизован – сразу добавляем
    addFriendByCode(code);
  } else {
    // Сохраняем код в localStorage для добавления после входа
    localStorage.setItem('pendingFriendCode', code);
  }
}



const btnShareLink = document.getElementById('btn-share-link');
if (btnShareLink) {
  btnShareLink.addEventListener('click', () => {
    const friendCode = currentUser?.friend_code;
    if (!friendCode) return;
    const shareUrl = `${window.location.origin}/?code=${friendCode}`;
    if (navigator.share) {
      navigator.share({
        title: 'Приглашение в друзья',
        text: 'Присоединяйся ко мне в мессенджере!',
        url: shareUrl
      }).catch(() => {
        copyToClipboard(shareUrl);
        showToast('Ссылка скопирована в буфер обмена', 'info');
      });
    } else {
      copyToClipboard(shareUrl);
      showToast('Ссылка скопирована в буфер обмена', 'info');
    }
  });
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

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
        li.textContent = 'Пока нет друзей. Поделитесь своим кодом или добавьте чужой.';
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
      showToast('Скопировано', 'info');
    }
  });
}

const btnAddFriend = $('btn-add-friend');
if (btnAddFriend) {
  btnAddFriend.addEventListener('click', async () => {
    const codeInput = $('friend-code-input');
    const errEl = $('friends-error');
    if (!errEl || !codeInput) return;

    errEl.textContent = '';
    const code = codeInput.value.trim();

    // 1. Валидация
    if (!code) {
      errEl.textContent = 'Введите код друга';
      return;
    }

    // 2. Блокируем кнопку на время запроса (чтобы не спамить)
    const originalText = btnAddFriend.textContent;
    btnAddFriend.disabled = true;
    btnAddFriend.textContent = 'Добавить';

    try {
      // 3. Запрос на добавление друга
      const addedFriend = await api('/api/friends', {
        method: 'POST',
        body: JSON.stringify({ friendCode: code })
      });

      // 4. Убедимся, что сервер вернул объект с id друга
      if (!addedFriend || !addedFriend.id) {
        throw new Error('Сервер не вернул данные о друге');
      }

      // 5. Создаём личный чат (если ещё не существует)
      const dmData = await api('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ otherUserId: addedFriend.id })
      });

      if (!dmData || !dmData.conversationId) {
        throw new Error('Не удалось создать чат');
      }

      // 6. Успех – очищаем поле, обновляем список, переходим в чат
      codeInput.value = '';
      errEl.textContent = '';
      await loadConversationList();
      selectConversation(dmData.conversationId);
      if (isMobile()) setTimeout(() => showChat(), 10);
      showToast('Друг добавлен, чат создан', 'success');

      // 7. Обновляем список друзей в модалке (если она открыта)
      try {
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
      } catch (e) { /* не критично */ }

    } catch (err) {
      // 8. Показываем понятную ошибку
      console.error('Add friend error:', err);
      errEl.textContent = err.message || 'Не удалось добавить друга. Проверьте код и повторите.';
    } finally {
      btnAddFriend.disabled = false;
      btnAddFriend.textContent = originalText;
    }
  });
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
    hide($('modal-profile'));
    show($('modal-delete-confirm'));
    const deletePassword = $('delete-password');
    const deleteError = $('delete-error');
    if (deletePassword) deletePassword.value = '';
    if (deleteError) deleteError.textContent = '';
  });
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
      errEl.textContent = 'Введите ваш пароль';
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
const btnSaveDisplayName = $('btn-save-display-name');
const profileDisplayNameInput = $('profile-display-name');
const profileError = $('profile-error');

// Новая модалка смены пароля
const modalChangePassword = document.getElementById('modal-change-password');
const btnChangePassword = document.getElementById('btn-change-password');
const btnConfirmChangePassword = document.getElementById('btn-confirm-change-password');

// Открытие модалки смены пароля
if (btnChangePassword) {
  btnChangePassword.addEventListener('click', () => {
    // Очищаем поля и ошибки перед показом
    document.getElementById('change-old-password').value = '';
    document.getElementById('change-new-password').value = '';
    document.getElementById('change-confirm-password').value = '';
    document.getElementById('change-password-error').textContent = '';
    // Закрываем модалку профиля, чтобы не было наложения
    hide(modalProfile);
    show(modalChangePassword);
  });
}

// Подтверждение смены пароля
if (btnConfirmChangePassword) {
  btnConfirmChangePassword.addEventListener('click', async () => {
    const oldPassword = document.getElementById('change-old-password').value.trim();
    const newPassword = document.getElementById('change-new-password').value.trim();
    const confirmPassword = document.getElementById('change-confirm-password').value.trim();
    const errorEl = document.getElementById('change-password-error');
    errorEl.textContent = '';

    if (!oldPassword || !newPassword || !confirmPassword) {
      errorEl.textContent = 'Все поля обязательны для заполнения';
      return;
    }
    if (newPassword.length < 6) {
      errorEl.textContent = 'Новый пароль должен содержать минимум 6 символов';
      return;
    }
    if (newPassword !== confirmPassword) {
      errorEl.textContent = 'Пароли не совпадают';
      return;
    }

    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword })
      });

      showToast('Пароль успешно изменён. Пожалуйста, войдите снова.', 'success');

      if (callActive) await endCall();
      if (signalingChannel) {
        signalingChannel.close();
        signalingChannel = null;
      }

      await api('/api/logout', { method: 'POST' });

      currentUser = null;
      localStorage.removeItem('user');
      localStorage.removeItem('lastConversationId');
      currentConversationId = null;
      renderScreen();

      hide(modalChangePassword);
      hide(modalProfile);
    } catch (err) {
      errorEl.textContent = err.message || 'Ошибка при смене пароля';
    }
  });
}

// Закрытие модалки смены пароля по клику на фон
if (modalChangePassword) {
  modalChangePassword.addEventListener('click', (e) => {
    if (e.target.id === 'modal-change-password') hide(modalChangePassword);
  });
}

// Остальной код (меню, сохранение отображаемого имени, удаление аккаунта и т.д.) остаётся без изменений

if (btnMenu) {
  btnMenu.addEventListener('click', () => {
    if (modalProfile && currentUser) {
      profileDisplayNameInput.value = currentUser.display_name || currentUser.username;
      profileError.textContent = '';
      show(modalProfile);
    }
  });
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
      profileError.textContent = 'Имя не может быть пустым';
      return;
    }
    if (newName.length < 2) {
      profileError.textContent = 'Имя должно содержать минимум 2 символа';
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

async function processInviteJoin() {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('join');
  if (token) {
    // Убираем параметр из URL, чтобы не повторять
    const newUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);

    if (!currentUser) {
      localStorage.setItem('pendingInviteToken', token);
      return;
    }

    try {
      const result = await api('/api/join', { method: 'POST', body: JSON.stringify({ token }) });
      showToast('Вы присоединились к беседе!', 'success');
      await loadConversationList();
      selectConversation(result.conversationId);
      if (isMobile()) showChat();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  // Если токена в URL нет, но есть сохранённый в localStorage
  const pendingToken = localStorage.getItem('pendingInviteToken');
  if (pendingToken && currentUser) {
    localStorage.removeItem('pendingInviteToken');
    try {
      const result = await api('/api/join', { method: 'POST', body: JSON.stringify({ token: pendingToken }) });
      showToast('Вы присоединились к беседе!', 'success');
      await loadConversationList();
      selectConversation(result.conversationId);
      if (isMobile()) showChat();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
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
    list.innerHTML = '<li style="color:var(--danger);">Не удалось загрузить группы</li>';
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
      list.innerHTML = '<li style="color:var(--text-muted); padding:1rem;">Сначала добавьте друзей</li>';
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
    list.innerHTML = '<li style="color:var(--danger);">Не удалось загрузить друзей</li>';
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
      errorEl.textContent = 'Название группы обязательно';
      return;
    }
    if (userIds.length === 0) {
      errorEl.textContent = 'Выберите хотя бы одного друга';
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

function showInviteModal(link) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Пригласительная ссылка</h2>
      <p>Поделитесь этой ссылкой – любой авторизованный пользователь сможет присоединиться.</p>
      <input type="text" id="invite-link-input" value="${escapeHtml(link)}" readonly style="width:100%; margin-bottom:1rem;">
      <div class="modal-actions">
        <button class="btn-primary" id="copy-invite-link">Копировать</button>
        <button class="btn-close-modal">Закрыть</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.classList.remove('hidden');

  modal.querySelector('#copy-invite-link').addEventListener('click', () => {
    const input = modal.querySelector('#invite-link-input');
    input.select();
    document.execCommand('copy');
    showToast('Ссылка скопирована', 'info');
  });
  modal.querySelector('.btn-close-modal').addEventListener('click', () => {
    modal.remove();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
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
      li.style.justifyContent = 'flex-start';
      li.style.padding = '0.5rem 0';
      li.style.gap = '1rem';
      
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
        actionsDiv.style.flexWrap = 'nowrap';
        
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

              const muteBtn = document.createElement('button');
              muteBtn.className = 'admin-action-btn';
              muteBtn.title = 'Mute for 10 minutes';

              const muteImg = document.createElement('img');
              muteImg.src = '/images/mute.png';
              muteImg.alt = 'Mute';
              muteImg.style.width = '20px';
              muteImg.style.height = '20px';
              muteBtn.appendChild(muteImg);

              muteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const minutes = 10; // фиксированная длительность
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
              actionsDiv.appendChild(muteBtn);
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
    if (isOwner || isAdmin) {

      const existingInviteBtn = document.getElementById('group-invite-btn');
      if (existingInviteBtn) existingInviteBtn.remove();
      const inviteBtn = document.createElement('button');
      inviteBtn.textContent = '🔗 Создать ссылку-приглашение';
      inviteBtn.className = 'btn-primary';
      inviteBtn.style.marginTop = '1rem';
      inviteBtn.style.width = '100%';
      inviteBtn.id = 'group-invite-btn';
      inviteBtn.addEventListener('click', async () => {
        try {
          const res = await api(`/api/conversations/${groupId}/invite`, { method: 'POST' });
          // Показываем модалку со ссылкой
          showInviteModal(res.link);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      listEl.parentNode.appendChild(inviteBtn);
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
    listEl.innerHTML = `<li style="color:var(--danger);">Не удалось загрузить участников</li>`;
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
  adjustChatMessagesPadding();
}

function hideGroupInfoButton() {
  const btn = document.getElementById('group-info-btn');
  if (btn) btn.remove();
  adjustChatMessagesPadding();
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
      list.innerHTML = '<li style="color:var(--text-muted);">Все друзья уже в группе</li>';
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
    list.innerHTML = `<li style="color:var(--danger);">Не удалось загрузить друзей</li>`;
  }
}

if (modalAddMember) {
  modalAddMember.addEventListener('click', (e) => {
    if (e.target.id === 'modal-add-member') hide(modalAddMember);
  });
}

// ---- FILE HANDLING ----
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

const fileLabel = document.getElementById('file-label');
const fileInput = document.getElementById('file-input');

// Загрузка всех файлов с прогрессом
async function uploadFiles(files, onProgress) {
  const uploaded = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileData = await uploadFile(file); // существующая функция
    uploaded.push(fileData);
    if (onProgress) onProgress(i + 1, files.length);
  }
  return uploaded;
}

// Прогресс для составного сообщения
function showCompositeProgress(progressId, completed, total) {
  const messagesList = $('messages-list');
  if (!messagesList) return;
  const progressDiv = document.createElement('div');
  progressDiv.id = progressId;
  progressDiv.className = 'message system';
  progressDiv.innerHTML = `
    <div class="file-upload-progress">
      <div class="file-name">📤 Отправка (${completed}/${total})</div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${(completed/total)*100}%"></div>
      </div>
    </div>
  `;
  messagesList.appendChild(progressDiv);
  scrollMessagesToBottom();
}
function updateCompositeProgress(progressId, completed, total) {
  const progressDiv = $(progressId);
  if (!progressDiv) return;
  const bar = progressDiv.querySelector('.progress-bar');
  const nameSpan = progressDiv.querySelector('.file-name');
  if (bar) bar.style.width = `${(completed/total)*100}%`;
  if (nameSpan) nameSpan.textContent = `📤 Отправка (${completed}/${total})`;
}
function removeCompositeProgress(progressId) {
  const progressDiv = $(progressId);
  if (progressDiv) progressDiv.remove();
}

// Отправка составного сообщения (текст + файлы)
async function sendCompositeMessage(text, files, replyToId) {
  const total = files.length;
  const progressId = `composite-${Date.now()}-${Math.random()}`;
  let completed = 0;

  showCompositeProgress(progressId, completed, total);

  try {
    const uploadedFiles = await uploadFiles(files, (done, total) => {
      completed = done;
      updateCompositeProgress(progressId, completed, total);
    });

    removeCompositeProgress(progressId);

    const compositeBody = {
      type: 'composite',
      text: text,
      files: uploadedFiles
    };
    const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: JSON.stringify(compositeBody), replyToId }),
    });

    if (!currentConversationIsGroup) msg.read = false;
    appendMessageToChat(msg);
    updateSidebarRow(currentConversationId, text ? text : `📎 ${files.length} файлов`);
    return msg;
  } catch (err) {
    removeCompositeProgress(progressId); // обязательно убираем прогресс при ошибке
    throw err;
  }
}

if (fileLabel && fileInput) {
  fileLabel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showFileTypeMenu(fileLabel);
  });

  // Обработчики для кнопок меню
  const mediaBtn = document.querySelector('#file-type-menu button[data-type="media"]');
  const allBtn = document.querySelector('#file-type-menu button[data-type="all"]');
  const hideFileTypeMenu = () => {
    fileTypeMenu.classList.add('hidden');
    if (fileTypeMenu._closeMenuHandler) {
      document.removeEventListener('click', fileTypeMenu._closeMenuHandler);
      document.removeEventListener('touchstart', fileTypeMenu._closeMenuHandler);
      fileTypeMenu._closeMenuHandler = null;
    }
  };

  if (mediaBtn) {
    mediaBtn.addEventListener('click', () => {
      fileInput.accept = 'image/*,video/*';
      fileInput.multiple = true;
      hideFileTypeMenu();
      fileInput.click();
    });

  }
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      fileInput.accept = '*/*';
      fileInput.multiple = false;
      hideFileTypeMenu();
      fileInput.click();
    });
  }

  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    // Если выбрано больше 10 медиафайлов — предупреждение
    const mediaFiles = files.filter(isMediaFile);
    if (mediaFiles.length > 10) {
      alert('Нельзя отправить более 10 фото/видео одновременно');
      e.target.value = '';
      return;
    }

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`Файл "${file.name}" слишком большой (макс ${MAX_FILE_SIZE / 1024 / 1024} MB)`);
        continue;
      }
      pendingFiles.push(file);
    }

    renderFilePreviews();
    e.target.value = '';
  });
}

window.clearSelectedFiles = function() {
  pendingFiles = [];
  renderFilePreviews();
};

function showUploadProgress(file, progressId) {
  const messagesList = $('messages-list');
  if (!messagesList) return;

  const progressDiv = document.createElement('div');
  progressDiv.id = progressId;
  progressDiv.className = 'message system'; // используем класс system вместо theirs для визуального отличия
  progressDiv.innerHTML = `
    <div class="file-upload-progress">
      <div class="file-name">📤 Загрузка: ${escapeHtml(file.name)}</div>
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

function renderFileMessage(container, fileData, messageDiv) {
  if (fileData.type === 'gallery') {
    renderGallery(container, fileData.files).catch(err => {
      console.error('Gallery render error:', err);
      const errorDiv = document.createElement('div');
      errorDiv.textContent = '⚠️ Ошибка загрузки галереи';
      errorDiv.style.color = 'var(--danger)';
      container.appendChild(errorDiv);
    });
    return;
  }
  if (!fileData.url) {
    console.warn('File URL is missing');
    const errorDiv = document.createElement('div');
    errorDiv.textContent = '[File error: missing URL]';
    container.appendChild(errorDiv);
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
          window.open(fileData.downloadUrl || fileData.url, '_blank');
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

    container.appendChild(mediaContainer);
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
    window.open(fileData.downloadUrl || fileData.url, '_blank');
  };
  actionsDiv.appendChild(downloadBtn);

  fileDiv.appendChild(actionsDiv);
  container.appendChild(fileDiv);
}

// Вспомогательные функции для получения размеров
function getImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = reject;
    img.src = url;
  });
}

function getVideoDimensions(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = reject;
    video.src = url;
  });
}

// Рендеринг одиночного медиа (как в обычном сообщении)
function renderSingleMedia(container, file) {
  const mediaContainer = document.createElement('div');
  mediaContainer.className = 'media-message';

  const mime = file.mime || file.type;
  if (mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = file.url;
    img.alt = file.name || 'Image';
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
    };
    img.addEventListener('click', () => openFullscreen(file.url, file.mime));
    mediaContainer.appendChild(img);
  } else if (mime.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = file.url;
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
    };
    video.addEventListener('click', () => openFullscreen(file.url, file.mime));
    mediaContainer.appendChild(video);
  }
  container.appendChild(mediaContainer);
}

// Рендеринг двух элементов (1fr 1fr)
function renderTwoItems(container, items) {
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gap = '2px';
  grid.style.borderRadius = '8px';
  grid.style.overflow = 'hidden';

  items.forEach(item => {
    const media = createMediaElement(item);
    grid.appendChild(media);
  });

  container.appendChild(grid);
}

// Рендеринг трёх элементов (первый большой, два справа)
function renderThreeItems(container, items) {
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '2fr 1fr';
  grid.style.gap = '2px';
  grid.style.borderRadius = '8px';
  grid.style.overflow = 'hidden';

  const left = createMediaElement(items[0]);
  grid.appendChild(left);

  const rightColumn = document.createElement('div');
  rightColumn.style.display = 'grid';
  rightColumn.style.gridTemplateRows = '1fr 1fr';
  rightColumn.style.gap = '2px';
  rightColumn.appendChild(createMediaElement(items[1]));
  rightColumn.appendChild(createMediaElement(items[2]));

  grid.appendChild(rightColumn);
  container.appendChild(grid);
}

// Рендеринг четырёх элементов (2x2)
function renderFourItems(container, items) {
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gridTemplateRows = '1fr 1fr';
  grid.style.gap = '2px';
  grid.style.borderRadius = '8px';
  grid.style.overflow = 'hidden';

  items.forEach(item => {
    grid.appendChild(createMediaElement(item));
  });

  container.appendChild(grid);
}

// Создание элемента медиа (изображение/видео) с обёрткой для единообразного размера
function createMediaElement(file) {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.width = '100%';
  wrapper.style.paddingTop = `${(1 / (file.aspectRatio || 1)) * 100}%`; // сохраняем пропорции
  wrapper.style.backgroundColor = '#f0f0f0';
  wrapper.style.cursor = 'pointer';

  const media = document.createElement(file.mime?.startsWith('video/') ? 'video' : 'img');
  media.src = file.url;
  if (file.mime?.startsWith('video/')) {
    media.controls = false; // в галерее контролы скрыты, клик открывает fullscreen
  }
  media.style.position = 'absolute';
  media.style.top = '0';
  media.style.left = '0';
  media.style.width = '100%';
  media.style.height = '100%';
  media.style.objectFit = 'cover';
  media.style.borderRadius = '0';

  media.addEventListener('click', (e) => {
    e.stopPropagation();
    openFullscreen(file.url, file.mime);
  });

  wrapper.appendChild(media);
  return wrapper;
}

function renderGridGallery(container, items) {
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
  grid.style.gap = '2px';
  grid.style.borderRadius = '8px';
  grid.style.overflow = 'hidden';

  items.forEach(item => {
    const media = createMediaElement(item);
    grid.appendChild(media);
  });

  container.appendChild(grid);
}

// Обновлённая renderGallery
async function renderGallery(container, files) {
  // Получаем пропорции всех файлов
  const items = await Promise.all(files.map(async (file) => {
    const mime = file.mime || file.type;
    let width, height;
    if (mime.startsWith('image/')) {
      try {
        const dims = await getImageDimensions(file.url);
        width = dims.width;
        height = dims.height;
      } catch {
        width = 1; height = 1;
      }
    } else if (mime.startsWith('video/')) {
      try {
        const dims = await getVideoDimensions(file.url);
        width = dims.width;
        height = dims.height;
      } catch {
        width = 16; height = 9; // fallback 16:9
      }
    } else {
      width = 1; height = 1;
    }
    return { ...file, width, height, aspectRatio: width / height };
  }));

  const galleryDiv = document.createElement('div');
  galleryDiv.className = 'gallery-message';
  galleryDiv.style.borderRadius = '8px';
  galleryDiv.style.overflow = 'hidden';

  const count = items.length;
  if (count === 1) {
    renderSingleMedia(galleryDiv, items[0]);
  } else if (count === 2) {
    renderTwoItems(galleryDiv, items);
  } else if (count === 3) {
    renderThreeItems(galleryDiv, items);
  } else if (count === 4) {
    renderFourItems(galleryDiv, items);
  } else {
    renderGridGallery(galleryDiv, items);
  }

  container.appendChild(galleryDiv);
}

// Пример функции открытия полноэкранной галереи (можно реализовать по необходимости)
function openFullscreenGallery(files) {
  // Здесь можно реализовать модальное окно с просмотром всех файлов
  console.log('Open fullscreen gallery with', files.length, 'files');
}

// Проверка, является ли файл медиа (изображение или видео)
function isMediaFile(file) {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

// Загрузка одного файла на сервер, возвращает Promise с fileData
function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/api/upload', true);
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        // Можно обновлять прогресс, но для групповой загрузки проще отслеживать общий прогресс отдельно
        // Пока не используем
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const fileData = JSON.parse(xhr.responseText);
          fileData.mime = fileData.type; // добавляем поле mime для единообразия
          resolve(fileData);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error('Upload failed'));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

async function sendGallery(files, replyToId) {
  const total = files.length;
  const progressId = `gallery-${Date.now()}-${Math.random()}`;
  let completed = 0;
  const uploadedFiles = [];

  showGalleryProgress(progressId, completed, total);

  for (const file of files) {
    try {
      const fileData = await uploadFile(file);
      uploadedFiles.push(fileData);
      completed++;
      updateGalleryProgress(progressId, completed, total);
    } catch (err) {
      removeGalleryProgress(progressId);
      throw new Error(`Failed to upload ${file.name}: ${err.message}`);
    }
  }

  const galleryMessage = {
    type: 'gallery',
    files: uploadedFiles
  };

  try {
    const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: JSON.stringify(galleryMessage), replyToId }),
    });
    if (!currentConversationIsGroup) msg.read = false;
    appendMessageToChat(msg);
    updateSidebarRow(currentConversationId, `📷 Галерея (${total} файлов)`);
  } finally {
    removeGalleryProgress(progressId);
  }
}

function showGalleryProgress(progressId, completed, total) {
  const messagesList = $('messages-list');
  if (!messagesList) return;

  const progressDiv = document.createElement('div');
  progressDiv.id = progressId;
  progressDiv.className = 'message system';
  progressDiv.innerHTML = `
    <div class="file-upload-progress">
      <div class="file-name">📸 Загрузка галереи (${completed}/${total})</div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${(completed/total)*100}%"></div>
      </div>
    </div>
  `;
  messagesList.appendChild(progressDiv);
  scrollMessagesToBottom();
}

function updateGalleryProgress(progressId, completed, total) {
  const progressDiv = $(progressId);
  if (!progressDiv) return;
  const bar = progressDiv.querySelector('.progress-bar');
  const nameSpan = progressDiv.querySelector('.file-name');
  if (bar) bar.style.width = `${(completed/total)*100}%`;
  if (nameSpan) nameSpan.textContent = `📸 Загрузка галереи (${completed}/${total})`;
}

function removeGalleryProgress(progressId) {
  const progressDiv = $(progressId);
  if (progressDiv) progressDiv.remove();
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
      throw new Error('Ваш браузер не поддерживает аудиозвонки.');
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
    alert('Не удалось начать звонок: ' + message);
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
      updateCallStatus(`Вызов ${getRemoteName(targetUserId)}...`);
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

  if (conversationId && !callActive) {
    (async () => {
      try {
        const groupData = await api(`/api/groups/${conversationId}`);
        const members = groupData.participants;
        for (const member of members) {
          if (member.id !== currentUser.id && member.id !== fromUserId) {
            if (!peerConnections.has(member.id)) {
              await createPeerConnection(member.id, true);
            }
          }
        }
      } catch (e) {
        console.error('Failed to mesh group call', e);
      }
    })();
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
        if (!confirm(`${getRemoteName(fromUserId)} звонит. Принять?`)) {
          sendSignalingMessage('call-rejected', { targetUserId: fromUserId, conversationId: targetConversationId });
          return;
        }
        callActive = true;
        currentCallConversationId = targetConversationId;
        showCallUI();
        initSignalingChannel();
        
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          if (localStream) {
            // Добавляем треки во все существующие пиры (кроме того, с которым только что создали или получили)
            for (const [uid, pc] of peerConnections) {
              if (uid !== fromUserId) {
                localStream.getTracks().forEach(track => {
                  pc.addTrack(track, localStream);
                });
              }
            }
          }
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
    
    updateCallStatus('Подключено');
    
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
      updateCallStatus('Подключено');
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
    document.body.appendChild(audio);
    remoteAudioElements.set(userId, audio);
  }
  audio.srcObject = stream;
  audio.play().catch(e => {
    console.warn('Autoplay blocked, showing manual play button', e);
    // Показать кнопку "Разрешить звук" над чатом
    const btn = document.createElement('button');
    btn.textContent = '🔊 Нажмите для включения звука';
    btn.className = 'unmute-call-btn';
    btn.onclick = () => {
      audio.play();
      btn.remove();
    };
    document.querySelector('.call-status-bar')?.appendChild(btn);
  });
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
  adjustChatMessagesPadding();
  updateChatMessagesPaddingBottom();
});

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM loaded, initializing app');
  adjustChatMessagesPadding();
  filePreviewList = document.getElementById('file-preview-list');
  fileTypeMenu = document.getElementById('file-type-menu');
  
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
  // Привязка обработчиков к сообщениям
  const messagesList = document.getElementById('messages-list');
  // Добавляем обработчик для кнопки отмены ответа
  if (replyCancel) {
    replyCancel.addEventListener('click', clearReplyTo);
  }
  if (messagesList) {
    // Двойной клик
    messagesList.addEventListener('dblclick', (e) => {
      const message = e.target.closest('.message');
      if (!message) return;
      const interactive = e.target.closest('button, a, .audio-play-btn, .audio-download-btn, .delete-message-btn, input, label, video, audio');
      if (interactive) return;
      setReplyTo(message);
      e.preventDefault();
    });

    // Правый клик (контекстное меню)
    messagesList.addEventListener('contextmenu', (e) => {
      const message = e.target.closest('.message');
      if (!message) return;
      const interactive = e.target.closest('button, a, .audio-play-btn, .audio-download-btn, .delete-message-btn, input, label, video, audio');
      if (interactive) return;
      showContextMenuAt(message, e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
    });

    // Свайпы для мобильных (ответ влево, назад вправо)
    let touchStartX = 0, touchStartY = 0;
    let isVerticalSwipe = false;

    messagesList.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      isVerticalSwipe = false;
    });

    messagesList.addEventListener('touchmove', (e) => {
      if (!touchStartX) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      
      // Если вертикальное движение превысило 20px, считаем жест вертикальным скроллом
      if (Math.abs(dy) > 20 && !isVerticalSwipe) {
        isVerticalSwipe = true;
      }
      
      // Если это вертикальный скролл – не обрабатываем горизонтальные команды
      if (isVerticalSwipe) return;
      
      // Горизонтальный жест: только если смещение по X больше Y и превышает порог
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) { // Свайп влево → ответить на сообщение
          const message = e.target.closest('.message');
          if (message) {
            setReplyTo(message);
            e.preventDefault();
            touchStartX = 0; // сброс, чтобы не обрабатывать повторно
          }
        } else if (dx > 0) { // Свайп вправо → вернуться к списку чатов
          e.preventDefault();
          touchStartX = 0;
          if (isMobile()) {
            showSidebar();
          }
        }
      }
    });

    messagesList.addEventListener('touchend', () => {
      touchStartX = 0;
      isVerticalSwipe = false;
    });
  }
  renderFilePreviews();
  tryAutoLogin();
  updateChatMessagesPaddingBottom();
  updateChatMessagesPaddingBottom();
  checkAndAddFriendFromUrl();
});
// Auth tabs switching
const tabs = document.querySelectorAll('.auth-tab');
const authError = document.getElementById('auth-error');

if (tabs.length) {
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      if (target === 'login') {
        loginForm.classList.add('active');
        registerForm.classList.remove('active');
      } else {
        registerForm.classList.add('active');
        loginForm.classList.remove('active');
      }

      // Clear error when switching
      if (authError) authError.textContent = '';
    });
  });
}