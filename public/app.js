const API = window.location.origin;

let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let conversationListCache = [];
let isAtBottom = true;
let currentConversationIsGroup = false;

// ---- Call State ----
let currentCall = null;
// {
//   callId, conversationId, isInitiator,
//   peerConnections: Map<userId, RTCPeerConnection>,
//   localStream: MediaStream | null,
//   participants: Map<userId, {id, username}>
// }
let pendingCallInvite = null; // { callId, callerName, callerId, conversationId }
let selfMuted = false;

// ---- File State ----
let pendingFile = null; // { file, base64, dataUrl }

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

const $ = (id) => document.getElementById(id);
const isMobile = () => window.innerWidth <= 768;

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function showAuthError(msg) { const el = $('auth-error'); if (el) el.textContent = msg || ''; }

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return '🗜️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  return '📄';
}

// ---- API ----
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function tryAutoLogin() {
  if (currentUser) renderScreen();
  try {
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('user', JSON.stringify(me));
    renderScreen();
  } catch {
    currentUser = null;
    localStorage.removeItem('user');
    renderScreen();
  }
}

function renderScreen() {
  if (currentUser) {
    hide($('auth-screen'));
    show($('main-screen'));
    const headerUsername = $('header-username');
    if (headerUsername) headerUsername.textContent = currentUser.username;
    if (!currentUser.friend_code) fetchMe();
    startNotificationStream();
    loadConversationList();
    loadNotificationCount();
    if (isMobile()) showSidebar();
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
  if (isMobile()) currentConversationId = null;
}

function showChat() {
  const layout = document.querySelector('.layout');
  if (layout) layout.classList.add('chat-open');
}

// ---- Scroll ----
let scrollDownBtn = null;

function createScrollDownButton() {
  if (document.querySelector('.btn-scroll-down')) return document.querySelector('.btn-scroll-down');
  const chatArea = $('chat-area');
  if (!chatArea) return null;
  const btn = document.createElement('button');
  btn.className = 'btn-scroll-down hidden';
  btn.innerHTML = '↓';
  btn.setAttribute('aria-label', 'Scroll to bottom');
  btn.addEventListener('click', () => { scrollMessagesToBottom(); btn.classList.add('hidden'); });
  chatArea.appendChild(btn);
  return btn;
}

function setupScrollListener() {
  const container = $('chat-messages-wrapper');
  if (!container) return;
  container.addEventListener('scroll', () => {
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 5;
    isAtBottom = bottom;
    if (bottom) { if (scrollDownBtn) scrollDownBtn.classList.add('hidden'); }
    else { if (scrollDownBtn && $('messages-list').children.length > 0) scrollDownBtn.classList.remove('hidden'); }
  });
}

async function fetchMe() {
  try {
    const me = await api('/api/me');
    if (currentUser) { currentUser.friend_code = me.friend_code; localStorage.setItem('user', JSON.stringify(currentUser)); }
  } catch (_) {}
}

const notificationAudio = new Audio('/notification.mp3');
function playNotificationSound(conversationId) {
  if (conversationId && conversationId === currentConversationId) return;
  try { notificationAudio.currentTime = 0; notificationAudio.play().catch(() => {}); } catch (_) {}
}

// ---- Message Rendering ----
// Parse and render a message body (handles text, images, files)
function renderMessageBody(body) {
  // Image: [IMG|filename|mimetype|base64data]
  if (body.startsWith('[IMG|')) {
    const parts = body.slice(5).split('|');
    if (parts.length >= 3) {
      const name = parts[0];
      const mime = parts[1];
      const size = parseInt(parts[2]) || 0;
      const b64 = parts.slice(3).join('|');
      const src = `data:${mime};base64,${b64}`;

      const wrap = document.createElement('div');
      wrap.className = 'msg-image-wrap';
      wrap.title = name;

      const img = document.createElement('img');
      img.src = src;
      img.alt = name;
      wrap.appendChild(img);

      const dlBtn = document.createElement('a');
      dlBtn.className = 'msg-image-dl';
      dlBtn.textContent = '⬇ Save';
      dlBtn.href = src;
      dlBtn.download = name;
      wrap.appendChild(dlBtn);

      wrap.addEventListener('click', (e) => {
        if (e.target === dlBtn || dlBtn.contains(e.target)) return;
        openLightbox(src, name);
      });

      return wrap;
    }
  }

  // File: [FILE|filename|mimetype|size|base64data]
  if (body.startsWith('[FILE|')) {
    const parts = body.slice(6).split('|');
    if (parts.length >= 4) {
      const name = parts[0];
      const mime = parts[1];
      const size = parseInt(parts[2]) || 0;
      const b64 = parts.slice(3).join('|');
      const src = `data:${mime};base64,${b64}`;

      const card = document.createElement('div');
      card.className = 'file-card';

      const icon = document.createElement('div');
      icon.className = 'file-card-icon';
      icon.textContent = fileIcon(mime);
      card.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'file-card-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'file-card-name';
      nameEl.textContent = name;
      const sizeEl = document.createElement('div');
      sizeEl.className = 'file-card-size';
      sizeEl.textContent = formatBytes(size);
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      const dl = document.createElement('a');
      dl.className = 'file-card-dl';
      dl.textContent = '⬇ Download';
      dl.href = src;
      dl.download = name;
      info.appendChild(dl);

      card.appendChild(info);
      return card;
    }
  }

  // Plain text
  const span = document.createElement('span');
  span.textContent = body;
  return span;
}

function buildMessageElement(msg) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ' + (msg.sender_id === currentUser.id ? 'mine' : 'theirs');

  if (currentConversationIsGroup && msg.sender_id !== currentUser.id) {
    const nameSpan = document.createElement('div');
    nameSpan.className = 'message-sender';
    nameSpan.textContent = msg.sender_username || 'Unknown';
    messageDiv.appendChild(nameSpan);
  }

  const bodyContainer = document.createElement('div');
  bodyContainer.appendChild(renderMessageBody(msg.body));
  messageDiv.appendChild(bodyContainer);

  const metaDiv = document.createElement('div');
  metaDiv.className = 'message-meta';
  metaDiv.textContent = new Date(msg.created_at).toLocaleString();
  messageDiv.appendChild(metaDiv);

  return messageDiv;
}

function appendMessageToChat(message) {
  const list = $('messages-list');
  if (!list) return;
  const container = $('chat-messages-wrapper');
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 20;
  list.appendChild(buildMessageElement(message));
  requestAnimationFrame(() => {
    if (wasAtBottom) { container.scrollTop = container.scrollHeight; if (scrollDownBtn) scrollDownBtn.classList.add('hidden'); }
    else { if (scrollDownBtn) scrollDownBtn.classList.remove('hidden'); }
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
  if (preview && lastMessageText) preview.textContent = lastMessageText;
  let unreadEl = btn.querySelector('.dm-unread');
  const unread = unreadByConvo[convId] || 0;
  if (unread > 0) {
    if (!unreadEl) { unreadEl = document.createElement('span'); unreadEl.className = 'dm-unread'; btn.appendChild(unreadEl); }
    unreadEl.textContent = unread > 99 ? '99+' : unread;
  } else if (unreadEl) { unreadEl.remove(); }
}

function updateBadgeFromCache() {
  const total = Object.values(unreadByConvo).reduce((a, b) => a + b, 0);
  document.title = total > 0 ? `(${total}) Messenger` : 'Messenger';
}

// ---- Auth ----
const loginForm = $('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); showAuthError('');
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('login-username').value.trim(), password: $('login-password').value }) });
      currentUser = data.user; localStorage.setItem('user', JSON.stringify(currentUser));
      $('login-password').value = ''; renderScreen();
    } catch (err) { showAuthError(err.message); }
  });
}
const registerForm = $('register-form');
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault(); showAuthError('');
    try {
      const data = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('register-username').value.trim(), password: $('register-password').value }) });
      currentUser = data.user; localStorage.setItem('user', JSON.stringify(currentUser));
      $('register-password').value = ''; renderScreen();
    } catch (err) { showAuthError(err.message); }
  });
}
const logoutBtn = $('btn-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
    endCallCleanup();
    currentUser = null; localStorage.removeItem('user'); currentConversationId = null; renderScreen();
  });
}

// ---- SSE Notifications ----
function startNotificationStream() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (!currentUser) return;
  eventSource = new EventSource(`${API}/api/notifications/stream`, { withCredentials: true });
  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEEvent(data);
    } catch (_) {}
  };
  eventSource.onerror = () => {};
}

function stopNotificationStream() {
  if (eventSource) { eventSource.close(); eventSource = null; }
}

function handleSSEEvent(data) {
  switch (data.type) {
    case 'new_message': {
      const convId = data.conversationId;
      const message = data.message;
      unreadByConvo[convId] = (unreadByConvo[convId] || 0) + 1;
      playNotificationSound(convId);
      if (currentConversationId === convId && message) {
        appendMessageToChat(message);
      } else {
        updateSidebarRow(convId, data.previewBody || (message ? message.body : null));
      }
      break;
    }
    case 'new_group':
    case 'added_to_group':
      loadConversationList();
      break;

    // ---- Call events ----
    case 'call_invite':
      handleIncomingCallInvite(data);
      break;
    case 'call_user_joined':
      handleCallUserJoined(data);
      break;
    case 'call_user_left':
      handleCallUserLeft(data);
      break;
    case 'call_rejected':
      handleCallRejected(data);
      break;
    case 'call_sdp_offer':
      handleCallOffer(data);
      break;
    case 'call_sdp_answer':
      handleCallAnswer(data);
      break;
    case 'call_ice_candidate':
      handleCallIce(data);
      break;
  }
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

// ---- Conversations List ----
async function loadConversationList() {
  const list = $('dm-list');
  if (!list) return;
  list.innerHTML = '';
  try {
    const [conversations, notifByConvoResp] = await Promise.all([api('/api/conversations'), api('/api/notifications')]);
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
      const nameHtml = conv.isGroup
        ? `<span class="dm-name">👥 ${escapeHtml(conv.title || 'Group')}</span>`
        : `<span class="dm-name">${escapeHtml(conv.otherUser?.username || 'Unknown')}</span>`;
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          ${nameHtml}
          <span class="dm-preview">${escapeHtml(conv.lastMessage || 'No messages yet')}</span>
        </div>
        ${unread > 0 ? `<span class="dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
      `;
      item.addEventListener('click', () => {
        selectConversation(conv.id);
        if (conv.isGroup) showGroupInfoButton(conv.id, conv.title); else hideGroupInfoButton();
        if (isMobile()) setTimeout(() => showChat(), 10);
      });
      list.appendChild(item);
    }
    updateBadgeFromCache();
  } catch (err) {
    list.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">Could not load conversations</p>';
  }
}
const loadDmList = loadConversationList;

async function selectConversation(convId) {
  convId = parseInt(convId, 10);
  currentConversationId = convId;
  try { await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ conversationId: convId }) }); } catch (_) {}
  unreadByConvo[convId] = 0;
  updateBadgeFromCache();
  updateSidebarRow(convId, null);
  let conversation = conversationListCache.find(c => c.id === convId);
  if (!conversation) { await loadConversationList(); conversation = conversationListCache.find(c => c.id === convId); }
  currentConversationIsGroup = conversation ? conversation.isGroup : false;
  const chatPlaceholder = $('chat-placeholder');
  const chatActive = $('chat-active');
  if (chatPlaceholder) hide(chatPlaceholder);
  if (chatActive) show(chatActive);
  let displayName = '';
  if (conversation) displayName = conversation.isGroup ? (conversation.title || 'Group') : (conversation.otherUser?.username || '…');
  const chatWithName = $('chat-with-name');
  if (chatWithName) chatWithName.textContent = displayName;
  document.querySelectorAll('.dm-item').forEach(el => el.classList.toggle('active', parseInt(el.dataset.id, 10) === convId));
  
  // Update call button
  updateCallButton();

  loadMessages(convId);
  setTimeout(() => { isAtBottom = true; scrollMessagesToBottom(); }, 200);
}

async function loadMessages(convId) {
  const list = $('messages-list');
  if (!list) return;
  list.innerHTML = '';
  try {
    const messages = await api(`/api/conversations/${convId}/messages`);
    for (const msg of messages) list.appendChild(buildMessageElement(msg));
    requestAnimationFrame(() => scrollMessagesToBottom());
  } catch {
    list.innerHTML = '<p style="color:var(--text-muted)">Could not load messages</p>';
  }
}

// ---- Send Message / File ----
const sendForm = $('send-form');
if (sendForm) {
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentConversationId) return;
    const input = $('message-input');
    if (!input) return;

<<<<<<< HEAD
    // If file pending, send it
    if (pendingFile) {
      await sendPendingFile();
      return;
    }

    const body = input.value.trim();
    if (!body) return;
    try {
      const msg = await api(`/api/conversations/${currentConversationId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      appendMessageToChat(msg);
      input.value = '';
      input.focus();
      requestAnimationFrame(() => scrollMessagesToBottom());
      updateSidebarRow(currentConversationId, body);
      const conversation = conversationListCache.find(c => c.id === currentConversationId);
      if (conversation) conversation.lastMessage = body;
    } catch (err) {
      input.value = body;
      alert('Failed to send: ' + err.message);
=======
    const textInput = $('message-input');
    const text = textInput.value.trim();
    
    // Отправляем текстовое сообщение
    if (text) {
      try {
        const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: text }),
        });
        // Добавляем сообщение в UI сразу после отправки
        appendMessageToChat(msg);
        textInput.value = '';
      } catch (err) {
        alert('Failed to send message: ' + err.message);
      }
    }
    
    // Отправляем файлы
    if (pendingFiles.length > 0) {
      show($('upload-progress'));
      for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i];
        $('progress-bar').style.width = ((i + 1) / pendingFiles.length * 100) + '%';
        try {
          const base64 = await fileToBase64(file);
          const base64Data = base64.split(',')[1] || base64;
          const msg = await api(`/api/conversations/${currentConversationId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              fileData: base64Data,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size
            }),
          });
          // Добавляем файловое сообщение в UI
          appendMessageToChat(msg);
        } catch (err) {
          alert(`Failed to send file ${file.name}: ${err.message}`);
        }
      }
      pendingFiles = [];
      hide($('upload-progress'));
      $('progress-bar').style.width = '0%';
>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
    }
  });
}

// ---- File Handling ----
const fileInput = $('file-input');
if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      alert(`File too large. Maximum size is ${formatBytes(MAX_FILE_SIZE)}.`);
      fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      pendingFile = { file, base64, dataUrl };
      const bar = $('file-preview-bar');
      const nameEl = $('file-preview-name');
      if (nameEl) nameEl.textContent = `📎 ${file.name} (${formatBytes(file.size)})`;
      if (bar) show(bar);
      const input = $('message-input');
      if (input) input.placeholder = 'Add a caption (optional)...';
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });
}

const btnFileRemove = $('btn-file-remove');
if (btnFileRemove) {
  btnFileRemove.addEventListener('click', () => {
    clearPendingFile();
  });
}

function clearPendingFile() {
  pendingFile = null;
  const bar = $('file-preview-bar');
  if (bar) hide(bar);
  const input = $('message-input');
  if (input) input.placeholder = 'Type a message...';
}

async function sendPendingFile() {
  if (!pendingFile || !currentConversationId) return;
  const { file, base64 } = pendingFile;
  const caption = ($('message-input')?.value || '').trim();

  // Build body string
  let prefix;
  if (file.type.startsWith('image/')) {
    prefix = `[IMG|${file.name}|${file.type}|${file.size}|${base64}]`;
  } else {
    prefix = `[FILE|${file.name}|${file.type}|${file.size}|${base64}]`;
  }
  // If there's a caption, append on new line — but we'll use the marker only
  // (caption support could be added later; for now send file as standalone)
  const body = prefix;

  const sendBtn = sendForm?.querySelector('button[type="submit"]');
  const originalText = sendBtn?.textContent;
  if (sendBtn) { sendBtn.textContent = 'Sending…'; sendBtn.disabled = true; }

  try {
    const msg = await api(`/api/conversations/${currentConversationId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
    appendMessageToChat(msg);
    if ($('message-input')) $('message-input').value = '';
    clearPendingFile();
    requestAnimationFrame(() => scrollMessagesToBottom());
    const conversation = conversationListCache.find(c => c.id === currentConversationId);
    if (conversation) conversation.lastMessage = file.type.startsWith('image/') ? '📷 Image' : `📎 ${file.name}`;
    updateSidebarRow(currentConversationId, file.type.startsWith('image/') ? '📷 Image' : `📎 ${file.name}`);
  } catch (err) {
    alert('Failed to send file: ' + err.message);
  } finally {
    if (sendBtn) { sendBtn.textContent = originalText; sendBtn.disabled = false; }
  }
}

// ---- Image Lightbox ----
function openLightbox(src, name) {
  const lb = $('img-lightbox');
  const img = $('lightbox-img');
  const dl = $('lightbox-download');
  if (!lb || !img) return;
  img.src = src;
  img.alt = name;
  if (dl) { dl.href = src; dl.download = name; }
  show(lb);
}

const lightboxClose = $('lightbox-close');
if (lightboxClose) lightboxClose.addEventListener('click', () => hide($('img-lightbox')));
const lightboxOverlay = $('lightbox-overlay');
if (lightboxOverlay) lightboxOverlay.addEventListener('click', () => hide($('img-lightbox')));

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
        btn.type = 'button'; btn.textContent = u.username;
        btn.addEventListener('click', async () => {
          try {
            const data = await api('/api/dms', { method: 'POST', body: JSON.stringify({ otherUserId: u.id }) });
            hide($('modal-new-dm'));
            selectConversation(data.conversationId);
            hideGroupInfoButton();
            if (isMobile()) setTimeout(() => showChat(), 10);
          } catch (err) { alert('Failed: ' + err.message); }
        });
        li.appendChild(btn); ul.appendChild(li);
      }
      if (friends.length === 0) ul.innerHTML = '<li style="color:var(--text-muted)">Add friends first</li>';
    } catch (_) { ul.innerHTML = '<li style="color:var(--text-muted)">Could not load friends</li>'; }
  });
}
const btnCloseModal = $('btn-close-modal');
if (btnCloseModal) btnCloseModal.addEventListener('click', () => hide($('modal-new-dm')));
const modalNewDm = $('modal-new-dm');
if (modalNewDm) modalNewDm.addEventListener('click', (e) => { if (e.target.id === 'modal-new-dm') hide($('modal-new-dm')); });

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
        const li = document.createElement('li'); li.textContent = u.username; friendsList.appendChild(li);
      }
      if (friends.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No friends yet.'; li.style.color = 'var(--text-muted)'; li.style.fontStyle = 'italic';
        friendsList.appendChild(li);
      }
    } catch (_) {
      const li = document.createElement('li'); li.textContent = 'Could not load friends'; li.style.color = 'var(--text-muted)'; friendsList.appendChild(li);
    }
  });
}
const btnCopyCode = $('btn-copy-code');
if (btnCopyCode) {
  btnCopyCode.addEventListener('click', () => {
    const code = currentUser?.friend_code;
    if (code && navigator.clipboard) { navigator.clipboard.writeText(code); alert('Copied!'); }
  });
}
const btnAddFriend = $('btn-add-friend');
if (btnAddFriend) {
  btnAddFriend.addEventListener('click', async () => {
    const code = $('friend-code-input')?.value.trim();
    const errEl = $('friends-error');
    if (!errEl) return;
    errEl.textContent = '';
    if (!code) { errEl.textContent = 'Enter a friend code'; return; }
    try {
      await api('/api/friends', { method: 'POST', body: JSON.stringify({ friendCode: code }) });
      if ($('friend-code-input')) $('friend-code-input').value = '';
      alert('Friend added');
      const friends = await api('/api/friends');
      const ul = $('friends-list');
      if (ul) {
        ul.innerHTML = '';
        for (const u of friends) { const li = document.createElement('li'); li.textContent = u.username; ul.appendChild(li); }
      }
    } catch (err) { errEl.textContent = err.message || 'Failed'; }
  });
}
const btnCloseFriends = $('btn-close-friends');
if (btnCloseFriends) btnCloseFriends.addEventListener('click', () => hide($('modal-friends')));
const modalFriends = $('modal-friends');
if (modalFriends) modalFriends.addEventListener('click', (e) => { if (e.target.id === 'modal-friends') hide($('modal-friends')); });

// ---- Delete account ----
const btnDeleteAccount = $('btn-delete-account');
if (btnDeleteAccount) {
  btnDeleteAccount.addEventListener('click', () => {
    hide($('modal-friends')); show($('modal-delete-confirm'));
    const dp = $('delete-password'); const de = $('delete-error');
    if (dp) dp.value = ''; if (de) de.textContent = '';
  });
}
const btnCancelDelete = $('btn-cancel-delete');
if (btnCancelDelete) btnCancelDelete.addEventListener('click', () => hide($('modal-delete-confirm')));
const modalDeleteConfirm = $('modal-delete-confirm');
if (modalDeleteConfirm) modalDeleteConfirm.addEventListener('click', (e) => { if (e.target.id === 'modal-delete-confirm') hide($('modal-delete-confirm')); });
const btnConfirmDelete = $('btn-confirm-delete');
if (btnConfirmDelete) {
  btnConfirmDelete.addEventListener('click', async () => {
    const password = $('delete-password')?.value;
    const errEl = $('delete-error');
    if (!errEl) return;
    errEl.textContent = '';
    if (!password) { errEl.textContent = 'Enter your password'; return; }
    try {
      await api('/api/account', { method: 'DELETE', body: JSON.stringify({ password }) });
      hide($('modal-delete-confirm'));
      endCallCleanup();
      currentUser = null; localStorage.removeItem('user'); currentConversationId = null; renderScreen();
    } catch (err) { errEl.textContent = err.message || 'Failed'; }
  });
}

// ---- Groups ----
const btnGroups = $('btn-groups');
const btnCreateGroupBtn = $('btn-create-group-btn');
const modalCreateGroup = $('modal-create-group');
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
    if (groups.length === 0) { list.innerHTML = '<li style="color:var(--text-muted);">No groups yet.</li>'; return; }
    groups.forEach(group => {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0.5rem 1rem;';
      const nameSpan = document.createElement('span'); nameSpan.textContent = group.title || 'Unnamed Group';
      const viewBtn = document.createElement('button'); viewBtn.textContent = 'View'; viewBtn.style.cssText = 'padding:0.25rem 0.5rem;';
      viewBtn.addEventListener('click', () => {
        hide($('modal-groups-list')); selectConversation(group.id); showGroupInfoButton(group.id, group.title); if (isMobile()) showChat();
      });
      li.appendChild(nameSpan); li.appendChild(viewBtn); list.appendChild(li);
    });
  } catch { list.innerHTML = '<li style="color:var(--danger);">Failed to load groups</li>'; }
}

if (btnGroups) btnGroups.addEventListener('click', async () => { show($('modal-groups-list')); await loadGroupsList(); });
if (btnCreateGroupBtn) btnCreateGroupBtn.addEventListener('click', async () => { show(modalCreateGroup); await loadFriendsForGroup(); });

const btnCloseGroup = $('btn-close-group');
if (btnCloseGroup) btnCloseGroup.addEventListener('click', () => hide(modalCreateGroup));
if (modalCreateGroup) modalCreateGroup.addEventListener('click', (e) => { if (e.target.id === 'modal-create-group') hide(modalCreateGroup); });

const btnCloseGroupsList = $('btn-close-groups-list');
if (btnCloseGroupsList) btnCloseGroupsList.addEventListener('click', () => hide($('modal-groups-list')));
const modalGroupsList = $('modal-groups-list');
if (modalGroupsList) modalGroupsList.addEventListener('click', (e) => { if (e.target.id === 'modal-groups-list') hide(modalGroupsList); });

async function loadFriendsForGroup() {
  const list = $('group-friends-list');
  if (!list) return;
  list.innerHTML = '';
  if ($('group-error')) $('group-error').textContent = '';
  if ($('group-title')) $('group-title').value = '';
  try {
    const friends = await api('/api/friends');
    if (friends.length === 0) { list.innerHTML = '<li style="color:var(--text-muted);padding:1rem;">Add friends first</li>'; return; }
    friends.forEach(friend => {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex;align-items:center;padding:0.5rem 1rem;';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = friend.id; cb.id = `friend-${friend.id}`;
      cb.style.cssText = 'margin-right:0.75rem;width:18px;height:18px;';
      const label = document.createElement('label'); label.htmlFor = `friend-${friend.id}`; label.textContent = friend.username;
      label.style.cssText = 'flex:1;cursor:pointer;';
      li.appendChild(cb); li.appendChild(label); list.appendChild(li);
    });
  } catch { list.innerHTML = '<li style="color:var(--danger);">Failed to load friends</li>'; }
}

const btnCreateGroup = $('btn-create-group');
if (btnCreateGroup) {
  btnCreateGroup.addEventListener('click', async () => {
    const title = $('group-title').value.trim();
    const checkboxes = document.querySelectorAll('#group-friends-list input[type="checkbox"]:checked');
    const userIds = Array.from(checkboxes).map(cb => parseInt(cb.value, 10));
    const errorEl = $('group-error');
    if (!title) { errorEl.textContent = 'Group name required'; return; }
    if (userIds.length === 0) { errorEl.textContent = 'Select at least one friend'; return; }
    try {
      const data = await api('/api/groups', { method: 'POST', body: JSON.stringify({ title, userIds }) });
      hide(modalCreateGroup);
      await loadConversationList();
      selectConversation(data.conversationId);
      showGroupInfoButton(data.conversationId, title);
      if (isMobile()) showChat();
    } catch (err) { errorEl.textContent = err.message; }
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
  btn.style.cssText = 'background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;padding:0 10px;min-width:44px;min-height:44px;';
  btn.title = 'Group info';
  btn.addEventListener('click', () => showGroupInfo(groupId, groupTitle));
  header.appendChild(btn);
}

function hideGroupInfoButton() {
  const btn = document.getElementById('group-info-btn');
  if (btn) btn.remove();
}

async function showGroupInfo(groupId, groupTitle) {
  const modal = $('modal-group-info'); const titleEl = $('group-info-title'); const listEl = $('group-members-list');
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
      li.style.padding = '0.25rem 0'; listEl.appendChild(li);
    });
    const addBtn = $('btn-add-member');
    if (addBtn) { addBtn.dataset.groupId = groupId; addBtn.dataset.groupTitle = groupTitle; }
  } catch { listEl.innerHTML = '<li style="color:var(--danger);">Failed to load</li>'; }
}

const btnCloseGroupInfo = $('btn-close-group-info');
if (btnCloseGroupInfo) btnCloseGroupInfo.addEventListener('click', () => hide(modalGroupInfo));
if (modalGroupInfo) modalGroupInfo.addEventListener('click', (e) => { if (e.target.id === 'modal-group-info') hide($('modal-group-info')); });

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
  if ($('add-member-error')) $('add-member-error').textContent = '';
  try {
    const [friends, group] = await Promise.all([api('/api/friends'), api(`/api/groups/${groupId}`)]);
    const memberIds = group.participants.map(p => p.id);
    const available = friends.filter(f => !memberIds.includes(f.id));
    if (available.length === 0) { list.innerHTML = '<li style="color:var(--text-muted);">All friends already in group</li>'; return; }
    list.innerHTML = '';
    available.forEach(friend => {
      const li = document.createElement('li');
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = friend.username;
      btn.style.cssText = 'width:100%;text-align:left;padding:0.5rem 1rem;';
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ userId: friend.id }) });
          hide(modalAddMember); showGroupInfo(groupId, groupTitle);
        } catch (err) { if ($('add-member-error')) $('add-member-error').textContent = err.message; }
      });
      li.appendChild(btn); list.appendChild(li);
    });
  } catch { list.innerHTML = '<li style="color:var(--danger);">Failed to load friends</li>'; }
}

const btnCloseAddMember = $('btn-close-add-member');
if (btnCloseAddMember) btnCloseAddMember.addEventListener('click', () => hide(modalAddMember));
if (modalAddMember) modalAddMember.addEventListener('click', (e) => { if (e.target.id === 'modal-add-member') hide($('modal-add-member')); });

// ---- CALL BUTTON ----
function updateCallButton() {
  const header = $('chat-header');
  if (!header) return;
  let callBtn = document.getElementById('btn-call-header');
  if (!callBtn) {
    callBtn = document.createElement('button');
    callBtn.id = 'btn-call-header';
    callBtn.className = 'btn-call';
    callBtn.title = 'Start voice call';
    callBtn.innerHTML = '📞';
    callBtn.addEventListener('click', handleCallButtonClick);
    header.appendChild(callBtn);
  }
  if (currentCall) {
    callBtn.classList.add('in-call');
    callBtn.title = 'End call';
    callBtn.innerHTML = '📞';
  } else {
    callBtn.classList.remove('in-call');
    callBtn.title = 'Start voice call';
    callBtn.innerHTML = '📞';
  }
}

<<<<<<< HEAD
function handleCallButtonClick() {
  if (currentCall) {
    leaveCall();
  } else {
    startCall();
=======
function getFileIcon(mimeType) {
  if (!mimeType) return '📎';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📘';
  if (mimeType.includes('excel') || mimeType.includes('sheet')) return '📗';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '🗜️';
  return '📎';
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

window.downloadFile = function(fileId, fileName) {
  const fileInfo = receivedFiles.get(fileId);
  if (!fileInfo || !fileInfo.blob) {
    alert('File not found');
    return;
  }
  const url = URL.createObjectURL(fileInfo.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.showMedia = function(fileId, type) {
  const fileInfo = receivedFiles.get(fileId);
  if (!fileInfo || !fileInfo.blob) {
    alert('Media not found');
    return;
  }
  const modal = $('media-modal');
  const content = $('modal-content');
  const url = URL.createObjectURL(fileInfo.blob);
  if (type === 'image') {
    content.innerHTML = `<img src="${url}" style="max-width:90vw; max-height:90vh;">`;
  } else if (type === 'video') {
    content.innerHTML = `<video src="${url}" controls autoplay style="max-width:90vw; max-height:90vh;"></video>`;
  }
  modal.classList.remove('hidden');
};

function addSystemMessage(text) {
  const list = $('messages-list');
  if (!list) return;
  const div = document.createElement('div');
  div.style.textAlign = 'center';
  div.style.color = 'var(--text-muted)';
  div.style.fontSize = '0.85rem';
  div.style.padding = '0.5rem';
  div.textContent = text;
  list.appendChild(div);
  $('chat-messages-wrapper').scrollTop = $('chat-messages-wrapper').scrollHeight;
}

// ========== ЗВОНКИ (WebSocket и WebRTC) ==========
function connectCallWS() {
  // Если соединение уже открыто или подключается, не создаём новое
  if (callWS && (callWS.readyState === WebSocket.CONNECTING || callWS.readyState === WebSocket.OPEN)) {
    return;
  }
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
      console.log('Call WS ready');
      break;
    case 'call_joined':
      callParticipants = data.participants || [];
      updateCallParticipantsList();
      break;
    case 'user_joined':
      callParticipants.push(data.userId);
      addSystemMessage(`🎤 ${data.username || 'User'} joined the call`);
      updateCallParticipantsList();
      if (callActive && localStream) createOffer(data.userId);
      break;
    case 'user_left':
      callParticipants = callParticipants.filter(id => id !== data.userId);
      addSystemMessage(`👋 A participant left`);
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
      if (data.muted) mutedUsers.add(data.userId);
      else mutedUsers.delete(data.userId);
      updateCallParticipantsList();
      break;
    case 'error':
      alert(data.message);
      if (data.message.includes('full')) endCall();
      break;
>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
  }
}

// ---- WEBRTC CALLS ----

async function startCall() {
  if (!currentConversationId) return;
<<<<<<< HEAD
  if (currentCall) { alert('Already in a call'); return; }

=======
  
  // Проверяем, открыт ли WebSocket, и подключаем при необходимости
  if (!callWS || callWS.readyState !== WebSocket.OPEN) {
    connectCallWS();
    // Даём время на установку соединения
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const { callId } = await api('/api/calls/start', { method: 'POST', body: JSON.stringify({ conversationId: currentConversationId }) });

    currentCall = {
      callId,
      conversationId: currentConversationId,
      isInitiator: true,
      peerConnections: new Map(),
      localStream: stream,
      participants: new Map([[currentUser.id, { id: currentUser.id, username: currentUser.username }]])
    };
    selfMuted = false;
    showCallActiveBar();
    updateCallButton();
    showToast('📞 Calling...');
  } catch (err) {
    alert('Could not start call: ' + err.message);
  }
}

async function handleIncomingCallInvite(data) {
  const { callId, callerName, callerId, conversationId } = data;
  // If already in a call, auto-reject
  if (currentCall) {
    try { await api(`/api/calls/${callId}/reject`, { method: 'POST' }); } catch (_) {}
    return;
  }
  pendingCallInvite = { callId, callerName, callerId, conversationId };
  // Show the incoming call bar (regardless of which conversation is open)
  const bar = $('call-incoming-bar');
  const text = $('call-incoming-text');
  if (text) text.textContent = `📞 ${callerName} is calling...`;
  if (bar) show(bar);
}

const btnCallAccept = $('btn-call-accept');
if (btnCallAccept) {
  btnCallAccept.addEventListener('click', async () => {
    if (!pendingCallInvite) return;
    const invite = pendingCallInvite;
    pendingCallInvite = null;
    hide($('call-incoming-bar'));
    await acceptCall(invite);
  });
}

const btnCallReject = $('btn-call-reject');
if (btnCallReject) {
  btnCallReject.addEventListener('click', async () => {
    if (!pendingCallInvite) return;
    const { callId } = pendingCallInvite;
    pendingCallInvite = null;
    hide($('call-incoming-bar'));
    try { await api(`/api/calls/${callId}/reject`, { method: 'POST' }); } catch (_) {}
  });
}

async function acceptCall(invite) {
  const { callId, conversationId } = invite;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const { existingParticipants } = await api(`/api/calls/${callId}/accept`, { method: 'POST' });

    currentCall = {
      callId,
      conversationId,
      isInitiator: false,
      peerConnections: new Map(),
      localStream: stream,
      participants: new Map([[currentUser.id, { id: currentUser.id, username: currentUser.username }]])
    };
    selfMuted = false;

    // Connect to existing participants
    for (const peer of existingParticipants) {
      currentCall.participants.set(peer.id, peer);
      await createPeerConnection(peer.id, true); // we are the new joiner, so we initiate
    }

    showCallActiveBar();
    updateCallButton();
    showToast('📞 Call connected');
  } catch (err) {
    alert('Could not join call: ' + err.message);
  }
}

async function createPeerConnection(peerId, isOfferingside) {
  if (!currentCall) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  currentCall.peerConnections.set(peerId, pc);

  // Add local audio tracks
  currentCall.localStream.getTracks().forEach(track => pc.addTrack(track, currentCall.localStream));

  // Remote audio
  pc.ontrack = (event) => {
    const audioId = `audio-peer-${peerId}`;
    let audio = document.getElementById(audioId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = audioId;
      audio.autoplay = true;
      $('audio-container').appendChild(audio);
    }
    audio.srcObject = event.streams[0];
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && currentCall) {
      api('/api/signal', {
        method: 'POST',
        body: JSON.stringify({
          targetUserId: peerId,
          payload: {
            type: 'call_ice_candidate',
            callId: currentCall.callId,
            candidate: event.candidate,
            targetUserId: currentUser.id
          }
        })
      }).catch(() => {});
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      removeAudioEl(peerId);
    }
  };

  if (isOfferingside) {
    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await api('/api/signal', {
      method: 'POST',
      body: JSON.stringify({
        targetUserId: peerId,
        payload: { type: 'call_sdp_offer', callId: currentCall.callId, sdp: offer, fromUserId: currentUser.id }
      })
    });
  }

  return pc;
}

async function handleCallOffer(data) {
  const { callId, sdp, fromUserId } = data;
  if (!currentCall || currentCall.callId !== callId) return;
  
  let pc = currentCall.peerConnections.get(fromUserId);
  if (!pc) {
    pc = await createPeerConnection(fromUserId, false);
  }

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await api('/api/signal', {
    method: 'POST',
    body: JSON.stringify({
      targetUserId: fromUserId,
      payload: { type: 'call_sdp_answer', callId, sdp: answer, fromUserId: currentUser.id }
    })
  });
}

async function handleCallAnswer(data) {
  const { callId, sdp, fromUserId } = data;
  if (!currentCall || currentCall.callId !== callId) return;
  const pc = currentCall.peerConnections.get(fromUserId);
  if (pc && pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
}

async function handleCallIce(data) {
  const { callId, candidate, fromUserId } = data;
  if (!currentCall || currentCall.callId !== callId) return;
  const pc = currentCall.peerConnections.get(fromUserId);
  if (pc && candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
}

function handleCallUserJoined(data) {
  if (!currentCall || currentCall.callId !== data.callId) return;
  currentCall.participants.set(data.userId, { id: data.userId, username: data.username });
  updateCallActiveText();
  showToast(`📞 ${data.username} joined the call`);
}

function handleCallUserLeft(data) {
  if (!currentCall || currentCall.callId !== data.callId) return;
  currentCall.participants.delete(data.userId);
  const pc = currentCall.peerConnections.get(data.userId);
  if (pc) { pc.close(); currentCall.peerConnections.delete(data.userId); }
  removeAudioEl(data.userId);
  updateCallActiveText();
  showToast(`📞 ${data.username} left the call`);
  if (currentCall.participants.size <= 1) {
    endCallCleanup();
    showToast('📞 Call ended');
  }
}

function handleCallRejected(data) {
  showToast(`📞 ${data.username} declined the call`);
}

async function leaveCall() {
  if (!currentCall) return;
  const callId = currentCall.callId;
  endCallCleanup();
  try { await api(`/api/calls/${callId}/end`, { method: 'POST' }); } catch (_) {}
  showToast('📞 Left the call');
}

function endCallCleanup() {
  if (!currentCall) return;
  // Close all peer connections
  for (const [, pc] of currentCall.peerConnections) { try { pc.close(); } catch (_) {} }
  // Stop local stream
  if (currentCall.localStream) currentCall.localStream.getTracks().forEach(t => t.stop());
  // Remove all audio elements
  const audioContainer = $('audio-container');
  if (audioContainer) audioContainer.innerHTML = '';
  currentCall = null;
  selfMuted = false;
  hide($('call-active-bar'));
  hide($('call-incoming-bar'));
  updateCallButton();
}

function removeAudioEl(peerId) {
  const audio = document.getElementById(`audio-peer-${peerId}`);
  if (audio) audio.remove();
}

function showCallActiveBar() {
  const bar = $('call-active-bar');
  if (bar) show(bar);
  updateCallActiveText();
}

function updateCallActiveText() {
  const el = $('call-active-text');
  if (!el || !currentCall) return;
  const count = currentCall.participants.size;
  const names = [...currentCall.participants.values()].filter(p => p.id !== currentUser.id).map(p => p.username);
  if (names.length === 0) el.textContent = 'Waiting for others...';
  else el.textContent = `In call with ${names.join(', ')}`;
}

const btnCallMute = $('btn-call-mute');
if (btnCallMute) {
  btnCallMute.addEventListener('click', () => {
    if (!currentCall?.localStream) return;
    selfMuted = !selfMuted;
    currentCall.localStream.getAudioTracks().forEach(t => { t.enabled = !selfMuted; });
    btnCallMute.textContent = selfMuted ? '🔇' : '🎤';
    btnCallMute.classList.toggle('muted', selfMuted);
    btnCallMute.title = selfMuted ? 'Unmute' : 'Mute';
  });
}

const btnCallEnd = $('btn-call-end');
if (btnCallEnd) btnCallEnd.addEventListener('click', () => leaveCall());

// ---- Toast ----
let toastTimeout = null;
function showToast(msg) {
  const toast = $('notification-toast');
  if (!toast) return;
  toast.textContent = msg;
  show(toast);
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => hide(toast), 3500);
}

// ---- Window resize ----
window.addEventListener('resize', () => {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  if (!isMobile()) { layout.classList.remove('chat-open'); }
  else { if (!currentConversationId) showSidebar(); else showChat(); }
});

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  scrollDownBtn = createScrollDownButton();
  setupScrollListener();

  const header = $('chat-header');
  if (header && isMobile() && !$('mobile-back-btn')) {
    const btn = document.createElement('button');
    btn.innerHTML = '←'; btn.id = 'mobile-back-btn';
    btn.setAttribute('aria-label', 'Back');
    btn.style.cssText = 'font-size:26px;margin-right:12px;cursor:pointer;background:none;border:none;color:var(--text);padding:0 5px;min-width:44px;min-height:44px;';
    btn.onclick = () => showSidebar();
    header.insertBefore(btn, header.firstChild);
  }
<<<<<<< HEAD

=======
  
  // Добавляем обработчик для file-input
  const fileInput = $('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', handleFileSelect);
  }
  
  // Подключаем WebSocket для звонков при старте
  connectCallWS();
  
>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
  tryAutoLogin();
});
