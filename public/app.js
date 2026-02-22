const API = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let currentConversationId = null;
let eventSource = null;
let unreadByConvo = {};
let dmListCache = [];
let isAtBottom = true;

const $ = (id) => document.getElementById(id);

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
  } else {
    show($('auth-screen'));
    hide($('main-screen'));
  }
}

// ---- ТОЛЬКО ЛОГИН ----

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log('Login clicked');
  
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  
  try {
    const res = await fetch(API + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    console.log('Response:', data);
    
    if (!res.ok) throw new Error(data.error);
    
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    
    renderScreen();
  } catch (err) {
    showAuthError(err.message);
  }
});

// Регистрация пока убираем
$('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  alert('Register disabled for testing');
});

// Выход
$('btn-logout').addEventListener('click', () => {
  token = null;
  currentUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  renderScreen();
});

renderScreen();