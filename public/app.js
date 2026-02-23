const API = window.location.origin;
const WS_URL = API.replace(/^http/, 'ws') + '/ws'; // Simple WS URL

let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null; // Keep for HTTP notifications? We'll use WS for new features.
let unreadByConvo = {};
let conversationListCache = [];
let isAtBottom = true;
let currentConversationIsGroup = false;

// --- WebSocket & WebRTC State ---
let ws = null;
let myId = null;
const peers = {}; // Store RTCPeerConnection objects keyed by userId
let localStream = null; // Local media stream
let remoteAudio = null; // Audio element for remote stream

const pcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

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

// --- WebSocket Connection Management ---
function connectWebSocket() {
  if (!currentUser) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
    // Join the user's personal room? Or we can use conversation IDs as rooms.
    // For simplicity, let's join a room based on conversation when selected.
    // We'll join a room when a conversation is selected.
    if (currentConversationId) {
      joinRoom(currentConversationId);
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log('WS received:', data);

    // --- Join confirmation ---
    if (data.type === 'joined') {
      myId = data.userId;
      console.log('Joined room, myId:', myId);
      // Optionally, store other users in the room
      return;
    }

    // --- User joined notification ---
    if (data.type === 'user_joined') {
      console.log('User joined:', data.userId, data.nickname);
      // Could update UI
      return;
    }

    // --- User left notification ---
    if (data.type === 'user_left') {
      console.log('User left:', data.userId);
      // Clean up peer connection if it exists
      if (peers[data.userId]) {
        peers[data.userId].close();
        delete peers[data.userId];
      }
      // If it's the user we were calling, maybe reset call UI
      if (data.userId === currentCallUserId) {
        resetCallUI();
      }
      return;
    }

    // --- Text/File Message ---
    if (data.type === 'message') {
      // Append message to chat if it's from the current conversation
      // Note: We need to know which conversation this message belongs to.
      // The server's broadcast doesn't include conversationId. We need to add it.
      // For now, assume it's for the current conversation.
      if (data.conversationId === currentConversationId) {
        appendMessageToChat({
          id: Date.now(), // Temporary ID
          body: data.text,
          created_at: new Date().toISOString(),
          sender_id: data.senderId,
          sender_username: data.senderNickname,
        });
        // Also update unread count if not current user
        if (data.senderId !== myId) {
          unreadByConvo[currentConversationId] = (unreadByConvo[currentConversationId] || 0) + 1;
          updateSidebarRow(currentConversationId, data.text);
        }
      } else {
        // Handle notification for other conversations
        if (data.conversationId) {
           unreadByConvo[data.conversationId] = (unreadByConvo[data.conversationId] || 0) + 1;
           // Optionally, trigger a load of conversation list to update last message
           loadConversationList();
        }
      }
      playNotificationSound(data.conversationId);
      return;
    }

    // --- WebRTC Signaling ---
    if (data.type === 'offer') {
      handleOffer(data);
    }
    if (data.type === 'answer') {
      handleAnswer(data);
    }
    if (data.type === 'candidate') {
      handleCandidate(data);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    // Attempt to reconnect after a delay
    setTimeout(connectWebSocket, 3000);
  };
}

function joinRoom(roomId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'join',
      roomId: String(roomId), // Ensure string
      nickname: currentUser.username
    }));
  }
}

function sendMessageToRoom(messageText, targetUserId = null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'message',
      conversationId: currentConversationId, // Add context
      text: messageText,
      senderId: myId,
      senderNickname: currentUser.username,
      targetUserId // For private messages (not used in broadcast rooms)
    }));
  }
}

function sendFileToRoom(file, targetUserId = null) {
  const reader = new FileReader();
  reader.onload = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'message',
        conversationId: currentConversationId,
        text: reader.result, // This will be a Data URL
        fileName: file.name,
        fileType: file.type,
        senderId: myId,
        senderNickname: currentUser.username,
        targetUserId
      }));
    }
  };
  reader.readAsDataURL(file);
}

// --- WebRTC Functions ---
async function getLocalStream() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return localStream;
  } catch (err) {
    console.error('Error accessing media devices:', err);
    alert('Could not access microphone. Please check permissions.');
    throw err;
  }
}

function createPeer(userId) {
  if (peers[userId]) {
    console.log('Peer already exists for', userId);
    return peers[userId];
  }

  const pc = new RTCPeerConnection(pcConfig);

  // Add local stream tracks to the connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('Sending ICE candidate to', userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'candidate',
          targetUserId: userId,
          candidate: e.candidate
        }));
      }
    }
  };

  pc.ontrack = (e) => {
    console.log('Received remote track from', userId);
    if (!remoteAudio) {
      remoteAudio = document.getElementById('remote-audio');
    }
    if (remoteAudio) {
      remoteAudio.srcObject = e.streams[0];
      remoteAudio.play().catch(err => console.warn('Audio play failed:', err));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state with', userId, ':', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      // Clean up
      if (peers[userId]) {
        delete peers[userId];
      }
      // Reset UI if this was the active call
      if (userId === currentCallUserId) {
        resetCallUI();
      }
    }
  };

  peers[userId] = pc;
  return pc;
}

async function startCall(userId) {
  if (!userId) {
    console.error('No user ID provided for call');
    return;
  }

  // Prevent starting a call if one is already active
  if (currentCallUserId) {
    alert('You are already in a call. Please hang up first.');
    return;
  }

  try {
    await getLocalStream();

    const pc = createPeer(userId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'offer',
        targetUserId: userId,
        offer: offer
      }));
    }

    // Update UI
    currentCallUserId = userId;
    updateCallUI(true, userId);
  } catch (err) {
    console.error('Failed to start call:', err);
  }
}

async function handleOffer(data) {
  console.log('Received offer from', data.senderId);
  if (!data.offer) return;

  // If already in a call with someone else, maybe auto-decline? For simplicity, we'll just handle it.
  // You might want to add a "incoming call" UI here.
  try {
    await getLocalStream();

    const pc = createPeer(data.senderId);

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'answer',
        targetUserId: data.senderId,
        answer: answer
      }));
    }

    // Update UI: we are now in a call with the caller
    currentCallUserId = data.senderId;
    updateCallUI(true, data.senderId);

  } catch (err) {
    console.error('Error handling offer:', err);
  }
}

async function handleAnswer(data) {
  console.log('Received answer from', data.senderId);
  if (!data.answer) return;

  const pc = peers[data.senderId];
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    } catch (err) {
      console.error('Error setting remote description:', err);
    }
  } else {
    console.warn('No peer found for answer from', data.senderId);
  }
}

async function handleCandidate(data) {
  console.log('Received ICE candidate from', data.senderId);
  if (!data.candidate) return;

  const pc = peers[data.senderId];
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  } else {
    console.warn('No peer found for candidate from', data.senderId);
  }
}

function hangUp() {
  for (const userId in peers) {
    peers[userId].close();
    delete peers[userId];
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (remoteAudio) {
    remoteAudio.srcObject = null;
  }
  resetCallUI();
}

function resetCallUI() {
  currentCallUserId = null;
  updateCallUI(false);
}

// UI update for call state
function updateCallUI(isInCall, otherUserId = null) {
  const callBtn = document.getElementById('btn-start-call');
  const hangUpBtn = document.getElementById('btn-hangup');
  if (callBtn && hangUpBtn) {
    if (isInCall) {
      callBtn.disabled = true;
      callBtn.style.opacity = '0.5';
      hangUpBtn.disabled = false;
      hangUpBtn.style.opacity = '1';
    } else {
      callBtn.disabled = false;
      callBtn.style.opacity = '1';
      hangUpBtn.disabled = true;
      hangUpBtn.style.opacity = '0.5';
    }
  }
}

let currentCallUserId = null;

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
    
    startNotificationStream(); // Keep SSE for now? Or rely solely on WS? Let's keep both.
    connectWebSocket(); // Connect WebSocket
    loadConversationList();
    loadNotificationCount();
    
    if (isMobile()) {
      showSidebar();
    }
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
    stopNotificationStream();
    if (ws) {
      ws.close();
    }
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
    
    hangUp(); // End any active call on logout
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
        loadConversationList();
      } else if (data.type === 'added_to_group') {
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
  
  // Check if it's a file message
  if (message.fileName) {
    // It's a file
    const link = document.createElement('a');
    link.href = message.body; // This is the data URL
    link.download = message.fileName;
    link.textContent = `📎 Download ${message.fileName}`;
    link.style.display = 'block';
    link.style.color = 'var(--accent)';
    link.style.textDecoration = 'underline';
    messageDiv.appendChild(link);
  } else {
    // It's text
    const bodyDiv = document.createElement('div');
    bodyDiv.textContent = message.body;
    messageDiv.appendChild(bodyDiv);
  }
  
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
        nameHtml = `<span class="dm-name">👥 ${escapeHtml(conv.title || 'Group')}</span>`;
      } else {
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
  
  // Join the WebSocket room for this conversation
  if (ws && ws.readyState === WebSocket.OPEN) {
    joinRoom(convId);
  }
  
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
      // Use HTTP API for now to persist messages, but also send via WebSocket for real-time?
      // For simplicity, we'll just use HTTP and rely on SSE/WS for real-time updates.
      // However, WebRTC and file sending are handled via WS.
      // Let's keep HTTP for text messages for persistence.
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

// --- File Send Handler ---
const fileInput = $('file-input');
const btnSendFile = $('btn-send-file');

if (btnSendFile) {
  btnSendFile.addEventListener('click', () => {
    if (fileInput) {
      fileInput.click();
    }
  });
}

if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && currentConversationId) {
      // Send file via WebSocket (or HTTP). Using WebSocket for simplicity.
      sendFileToRoom(file);
      // Optionally, also save to DB via HTTP API if needed.
      fileInput.value = ''; // Reset
    }
  });
}

// --- Call Buttons ---
const btnStartCall = $('btn-start-call');
const btnHangup = $('btn-hangup');

if (btnStartCall) {
  btnStartCall.addEventListener('click', () => {
    if (currentConversationId && !currentConversationIsGroup) {
      // For DM, find the other user's ID
      const conversation = conversationListCache.find(c => c.id === currentConversationId);
      if (conversation && conversation.otherUser) {
        startCall(conversation.otherUser.id);
      } else {
        alert('Cannot start call: unknown user');
      }
    } else if (currentConversationIsGroup) {
      alert('Group calls not supported yet');
    } else {
      alert('Select a conversation first');
    }
  });
}

if (btnHangup) {
  btnHangup.addEventListener('click', hangUp);
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
  
  // Create remote audio element
  if (!document.getElementById('remote-audio')) {
    const audio = document.createElement('audio');
    audio.id = 'remote-audio';
    audio.autoplay = true;
    document.body.appendChild(audio);
  }
  
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