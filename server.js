require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { pool, initDb } = require('./db');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const webpush = require('web-push');
const fsPromises = require('fs').promises;
const helmet = require('helmet');

// ---- VAPID setup ----
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID keys missing – push notifications disabled');
}

// ---- Uploads directory ----
try {
  fs.mkdirSync('uploads', { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') {
    console.error('Failed to create uploads directory:', err);
    process.exit(1);
  }
}

// ---- Allowed MIME types ----
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || String(100 * 1024 * 1024), 10);

// ---- Multer config ----
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error(`Недопустимый тип файла: ${file.mimetype}`), { code: 'INVALID_MIME' }));
    }
  }
});

// ---- Helpers ----
function generateFriendCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

// ---- App setup ----
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env variable is not set');
  process.exit(1);
}

// ---- Helmet / CSP ----
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ["'none'"],
      workerSrc: ["'self'"],
    },
  })
);

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30
};

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : `http://localhost:${PORT}`,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Статика без index.html (отдаём его отдельно с подстановкой VAPID)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---- Rate limiters ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Слишком много запросов, повторите позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sseConnectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.userId ? String(req.userId) : req.ip,
  message: { error: 'Слишком много SSE-соединений, повторите позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 30000,
  max: 10,
  message: { error: 'Слишком много загрузок, повторите позже.' }
});

// ---- Global error handlers ----
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  setTimeout(() => process.exit(1), 1000);
});

// ---- SSE state ----
const sseClients = new Map();       // userId -> Response[]
const signalingChannels = new Map(); // userId -> Set<Response>
const MAX_SSE_PER_USER = 5;
const MAX_SIGNALING_PER_USER = 5;

function isUserOnline(userId) {
  const clients = sseClients.get(userId);
  return !!(clients && clients.length > 0);
}

function broadcastToUser(userId, payload) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i].write(data);
    } catch {
      clients.splice(i, 1);
    }
  }
  if (clients.length === 0) sseClients.delete(userId);
}

async function getUsersToNotifyAboutStatus(userId) {
  const client = await pool.connect();
  try {
    const friendsRes = await client.query(
      'SELECT friend_id FROM friends WHERE user_id = $1', [userId]
    );
    const participantsRes = await client.query(`
      SELECT DISTINCT user_id
      FROM conversation_participants
      WHERE conversation_id IN (
        SELECT conversation_id FROM conversation_participants WHERE user_id = $1
      ) AND user_id != $1
    `, [userId]);
    return [...new Set([
      ...friendsRes.rows.map(r => r.friend_id),
      ...participantsRes.rows.map(r => r.user_id)
    ])];
  } finally {
    client.release();
  }
}

async function broadcastStatusChange(userId, online) {
  const targetUserIds = await getUsersToNotifyAboutStatus(userId);
  const payload = {
    type: 'user_status',
    userId,
    online,
    last_seen: online ? null : new Date().toISOString()
  };
  for (const targetId of targetUserIds) {
    broadcastToUser(targetId, payload);
  }
}

// ---- Auth middleware ----
function authMiddleware(req, res, next) {
  let token = req.cookies.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.substring(7);
  }
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

function streamAuthMiddleware(req, res, next) {
  let token = req.cookies.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.substring(7);
  }
  if (!token) return res.status(401).end();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).end();
  }
}

// ---- Push notifications ----
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Неверная подписка' });
  }
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE
       SET keys_auth = EXCLUDED.keys_auth, keys_p256dh = EXCLUDED.keys_p256dh`,
      [req.userId, subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save push subscription:', err);
    res.status(500).json({ error: 'Не удалось сохранить подписку' });
  } finally {
    client.release();
  }
});

async function sendPushNotifications(users, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  for (const userId of users) {
    if (isUserOnline(userId)) continue;
    const subs = await pool.query(
      'SELECT endpoint, keys_auth, keys_p256dh FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { auth: sub.keys_auth, p256dh: sub.keys_p256dh } },
          JSON.stringify(payload)
        );
      } catch (err) {
        if (err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        } else {
          console.error('Push send error:', err.message);
        }
      }
    }
  }
}

// ---- Auth routes ----
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || trimmedUsername.length < 2 || trimmedUsername.length > 50) {
    return res.status(400).json({ error: 'Имя пользователя должно быть от 2 до 50 символов' });
  }
  if (!password || password.length < 6 || password.length > 72) {
    return res.status(400).json({ error: 'Пароль должен быть от 6 до 72 символов' });
  }

  const hash = await bcrypt.hash(password, 12);
  let friendCode = generateFriendCode();
  const MAX_ATTEMPTS = 10;

  for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
    try {
      const r = await pool.query(
        'INSERT INTO users (username, password_hash, friend_code) VALUES ($1, $2, $3) RETURNING id, username, friend_code',
        [trimmedUsername, hash, friendCode]
      );
      const user = r.rows[0];
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
      res.cookie('token', token, COOKIE_OPTIONS);
      return res.json({ user: { id: user.id, username: user.username, friend_code: user.friend_code } });
    } catch (e) {
      if (e.code === '23505') {
        if (e.constraint?.includes('friend_code')) {
          friendCode = generateFriendCode();
          continue;
        }
        return res.status(400).json({ error: 'Имя пользователя уже занято' });
      }
      throw e;
    }
  }
  return res.status(500).json({ error: 'Не удалось сгенерировать уникальный код друга' });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || !password) {
    return res.status(400).json({ error: 'Требуется имя пользователя и пароль' });
  }

  const r = await pool.query(
    'SELECT id, username, password_hash, friend_code FROM users WHERE username = $1',
    [trimmedUsername]
  );
  const user = r.rows[0];

  // Постоянное время для защиты от timing attack
  const dummyHash = '$2a$12$invalidhashfortimingprotection000000000000000000000000';
  const valid = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  let friendCode = user.friend_code;
  if (!friendCode) {
    friendCode = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [friendCode, user.id]);
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, COOKIE_OPTIONS);
  return res.json({ user: { id: user.id, username: user.username, friend_code: friendCode } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      closeUserConnections(payload.userId);
    } catch (_) {}
  }
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ success: true });
});

// ---- Me ----
app.get('/api/me', authMiddleware, async (req, res) => {
  const r = await pool.query(
    'SELECT id, username, display_name, friend_code FROM users WHERE id = $1',
    [req.userId]
  );
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'Не найдено' });

  if (!user.friend_code) {
    user.friend_code = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [user.friend_code, user.id]);
  }

  res.json({
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    friend_code: user.friend_code
  });
});

app.get('/api/display-name', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT display_name, username FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  res.json({ displayName: user.display_name || user.username, username: user.username });
});

app.post('/api/display-name', authMiddleware, async (req, res) => {
  const trimmedName = req.body?.displayName?.trim();
  if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 50) {
    return res.status(400).json({ error: 'Имя должно быть от 2 до 50 символов' });
  }
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [trimmedName, req.userId]);
  res.json({ displayName: trimmedName });
});

app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароль обязательны' });
  }
  if (newPassword.length < 6 || newPassword.length > 72) {
    return res.status(400).json({ error: 'Новый пароль должен быть от 6 до 72 символов' });
  }
  const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!userRes.rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });

  const isValid = await bcrypt.compare(oldPassword, userRes.rows[0].password_hash);
  if (!isValid) return res.status(401).json({ error: 'Неверный старый пароль' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId]);
  res.json({ success: true });
});

function closeUserConnections(userId) {
  const sseList = sseClients.get(userId);
  if (sseList) {
    sseList.forEach(c => { try { c.end(); } catch (_) {} });
    sseClients.delete(userId);
  }
  const sigSet = signalingChannels.get(userId);
  if (sigSet) {
    sigSet.forEach(c => { try { c.end(); } catch (_) {} });
    signalingChannels.delete(userId);
  }
}

// ---- Delete account ----
app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'Не найдено' });
  if (!password || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Требуется пароль для удаления аккаунта' });
  }

  const messagesResult = await pool.query('SELECT body FROM messages WHERE sender_id = $1', [req.userId]);
  const messages = messagesResult.rows;

  closeUserConnections(req.userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM notifications WHERE message_id IN (SELECT id FROM messages WHERE sender_id = $1)', [req.userId]);
    await client.query('DELETE FROM notifications WHERE user_id = $1', [req.userId]);
    await client.query('DELETE FROM messages WHERE sender_id = $1', [req.userId]);
    await client.query('DELETE FROM conversation_participants WHERE user_id = $1', [req.userId]);
    await client.query('DELETE FROM friends WHERE user_id = $1 OR friend_id = $1', [req.userId]);
    await client.query(`
      DELETE FROM conversations
      WHERE id IN (
        SELECT c.id FROM conversations c
        LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
        GROUP BY c.id HAVING COUNT(cp.user_id) = 0
      )
    `);
    await client.query('DELETE FROM users WHERE id = $1', [req.userId]);
    await client.query('COMMIT');

    // Удаляем файлы
    const uploadsDir = path.resolve(__dirname, 'uploads');
    for (const msg of messages) {
      if (msg.body?.includes('/uploads/')) {
        const matches = msg.body.match(/\/uploads\/([^"'\s]+)/g);
        if (matches) {
          for (const match of matches) {
            try {
              const filename = path.basename(new URL(match, 'http://dummy').pathname.split('?')[0]);
              const filePath = path.join(uploadsDir, filename);
              if (filePath.startsWith(uploadsDir)) {
                await fsPromises.unlink(filePath).catch(() => {});
              }
            } catch (_) {}
          }
        }
      }
    }

    res.clearCookie('token', COOKIE_OPTIONS);
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Delete account error:', e);
    res.status(500).json({ error: 'Не удалось удалить аккаунт' });
  } finally {
    client.release();
  }
});

// ---- Friends ----
app.get('/api/friends', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.friend_code, u.last_seen,
           COALESCE(u.display_name, u.username) AS name
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = $1
    ORDER BY u.username
  `, [req.userId]);

  res.json(r.rows.map(u => ({ ...u, online: isUserOnline(u.id) })));
});

app.post('/api/friends', authMiddleware, async (req, res) => {
  const code = String(req.body?.friendCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Требуется код друга' });

  const other = await pool.query('SELECT id, username FROM users WHERE UPPER(friend_code) = $1', [code]);
  const friend = other.rows[0];

  if (!friend) return res.status(404).json({ error: 'Пользователь с таким кодом не найден' });
  if (friend.id === req.userId) return res.status(400).json({ error: 'Нельзя добавить самого себя' });

  try {
    await pool.query(
      'INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT (user_id, friend_id) DO NOTHING',
      [req.userId, friend.id]
    );
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Неверный пользователь' });
    throw e;
  }

  res.json({ id: friend.id, username: friend.username });
});

// ---- Conversations ----
app.get('/api/conversations', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT 
      c.id, c.created_at, c.is_group, c.title, c.is_channel,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id, 'username', u.username, 'display_name', u.display_name,
            'name', COALESCE(u.display_name, u.username),
            'role', cp.role, 'last_seen', u.last_seen
          )
        ), '[]'::json
      ) AS participants,
      MAX(m.created_at) AS last_at,
      (
        SELECT jsonb_build_object(
          'id', m2.id, 'body', m2.body, 'sender_id', m2.sender_id,
          'sender_username', u2.username, 'created_at', m2.created_at
        )
        FROM messages m2
        JOIN users u2 ON u2.id = m2.sender_id
        WHERE m2.conversation_id = c.id
        ORDER BY m2.created_at DESC LIMIT 1
      ) AS last_message
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = $1)
    GROUP BY c.id
    ORDER BY last_at DESC NULLS LAST
  `, [req.userId]);

  const convos = r.rows.map(row => {
    const participants = row.participants || [];
    const otherUsers = participants
      .filter(p => p.id !== req.userId)
      .map(p => ({ ...p, online: isUserOnline(p.id) }));
    return {
      id: row.id,
      isGroup: row.is_group || false,
      isChannel: row.is_channel || false,
      title: row.title,
      participants,
      otherUsers,
      otherUser: !row.is_group && otherUsers.length > 0 ? otherUsers[0] : null,
      lastMessage: row.last_message ? row.last_message.body : null,
      lastMessageData: row.last_message,
      lastAt: row.last_at,
      createdAt: row.created_at
    };
  });

  res.json(convos);
});

// ---- Create DM ----
app.post('/api/dms', authMiddleware, async (req, res) => {
  const otherId = parseInt(req.body?.otherUserId, 10);
  if (!otherId || otherId <= 0 || otherId === req.userId) {
    return res.status(400).json({ error: 'Требуется корректный другой пользователь' });
  }

  const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [otherId]);
  if (!userExists.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, otherId]
  );
  if (!isFriend.rows.length) return res.status(403).json({ error: 'Сначала добавьте этого пользователя в друзья' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user1 = Math.min(req.userId, otherId);
    const user2 = Math.max(req.userId, otherId);

    const insertResult = await client.query(
      `INSERT INTO conversations (is_group, user1_id, user2_id)
       VALUES (false, $1, $2)
       ON CONFLICT (user1_id, user2_id) WHERE is_group = false
       DO NOTHING RETURNING id`,
      [user1, user2]
    );

    let conversationId;
    if (insertResult.rows.length > 0) {
      conversationId = insertResult.rows[0].id;
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
        [conversationId, req.userId, otherId]
      );
    } else {
      const sel = await client.query(
        'SELECT id FROM conversations WHERE user1_id = $1 AND user2_id = $2 AND is_group = false',
        [user1, user2]
      );
      conversationId = sel.rows[0].id;
    }

    await client.query('COMMIT');
    broadcastToUser(otherId, { type: 'new_dm', conversationId });
    res.json({ conversationId });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ---- Typing ----
app.post('/api/typing', authMiddleware, async (req, res) => {
  const convId = parseInt(req.body?.conversationId, 10);
  const { action } = req.body || {};
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Неверный ID чата' });
  if (action !== 'start' && action !== 'stop') return res.status(400).json({ error: 'Действие должно быть "start" или "stop"' });

  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [convId]
  );
  if (!part.rows.some(p => p.user_id === req.userId)) {
    return res.status(403).json({ error: 'Вы не участвуете в этом чате' });
  }

  const payload = { type: 'typing', conversationId: convId, userId: req.userId, action };
  for (const { user_id } of part.rows.filter(p => p.user_id !== req.userId)) {
    broadcastToUser(user_id, payload);
  }
  res.json({ ok: true });
});

// ---- Groups ----
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};
  if (!title?.trim() || !Array.isArray(userIds) || userIds.length < 1) {
    return res.status(400).json({ error: 'Название и хотя бы один другой пользователь обязательны' });
  }

  const otherUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && id !== req.userId);
  if (!otherUserIds.length) return res.status(400).json({ error: 'Требуется хотя бы один корректный ID другого пользователя' });

  for (const uid of otherUserIds) {
    const exists = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (!exists.rows.length) return res.status(404).json({ error: `Пользователь с ID ${uid} не существует` });
    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    if (!isFriend.rows.length) return res.status(403).json({ error: `Пользователь ${uid} не ваш друг` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO conversations (is_group, title) VALUES (true, $1) RETURNING id',
      [title.trim()]
    );
    const cid = ins.rows[0].id;
    for (const uid of [req.userId, ...otherUserIds]) {
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [cid, uid, uid === req.userId ? 'owner' : 'member']
      );
    }
    await client.query('COMMIT');
    for (const uid of otherUserIds) {
      broadcastToUser(uid, { type: 'new_group', conversationId: cid, groupTitle: title.trim() });
    }
    res.json({ conversationId: cid });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

app.get('/api/groups/:id', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const result = await pool.query(`
    SELECT c.id, c.title, c.created_at, c.is_channel,
           json_agg(json_build_object(
             'id', u.id, 'username', u.username, 'display_name', u.display_name,
             'name', COALESCE(u.display_name, u.username),
             'role', cp.role, 'muted_until', cp.muted_until, 'last_seen', u.last_seen
           )) as participants
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id
    WHERE c.id = $1 AND c.is_group = true
    GROUP BY c.id
  `, [groupId]);

  if (!result.rows.length) return res.status(404).json({ error: 'Группа не найдена' });

  const group = result.rows[0];
  if (!group.participants.some(p => p.id === req.userId)) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  group.participants = group.participants.map(p => ({ ...p, online: isUserOnline(p.id) }));
  res.json({ ...group, isChannel: group.is_channel || false });
});

// ---- Invite ----
app.post('/api/conversations/:id/invite', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId)) return res.status(400).json({ error: 'Invalid conversation ID' });

  const convCheck = await pool.query('SELECT is_group FROM conversations WHERE id = $1', [convId]);
  if (!convCheck.rows.length || !convCheck.rows[0].is_group) {
    return res.status(400).json({ error: 'Only groups and channels can have invites' });
  }

  const roleRes = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (!roleRes.rows.length) return res.status(403).json({ error: 'Not a member' });
  const role = roleRes.rows[0].role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Only owners and admins can create invites' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await pool.query(
    `INSERT INTO group_invites (conversation_id, token, created_by, expires_at, max_uses, uses)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [convId, token, req.userId, expiresAt, null, 0]
  );

  const inviteLink = `${process.env.FRONTEND_URL || req.protocol + '://' + req.get('host')}/?join=${token}`;
  res.json({ link: inviteLink, token });
});

app.post('/api/join', authMiddleware, async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string' || token.length > 128) {
    return res.status(400).json({ error: 'Token required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inviteRes = await client.query(
      'SELECT id, conversation_id, expires_at, max_uses, uses FROM group_invites WHERE token = $1 FOR UPDATE',
      [token]
    );
    if (!inviteRes.rows.length) return res.status(404).json({ error: 'Invalid or expired invite' });

    const invite = inviteRes.rows[0];
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await client.query('DELETE FROM group_invites WHERE id = $1', [invite.id]);
      return res.status(410).json({ error: 'Invite expired' });
    }
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
      await client.query('DELETE FROM group_invites WHERE id = $1', [invite.id]);
      return res.status(410).json({ error: 'Invite already used' });
    }

    const conversationId = invite.conversation_id;
    const memberCheck = await client.query(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, req.userId]
    );
    if (!memberCheck.rows.length) {
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [conversationId, req.userId, 'member']
      );
      const newUses = invite.uses + 1;
      if (invite.max_uses !== null && newUses >= invite.max_uses) {
        await client.query('DELETE FROM group_invites WHERE id = $1', [invite.id]);
      } else {
        await client.query('UPDATE group_invites SET uses = $1 WHERE id = $2', [newUses, invite.id]);
      }
    }

    await client.query('COMMIT');
    res.json({ conversationId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Join error:', err);
    res.status(500).json({ error: 'Failed to join' });
  } finally {
    client.release();
  }
});

// ---- Channels ----
app.post('/api/channels', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};
  if (!title?.trim() || !Array.isArray(userIds) || userIds.length < 1) {
    return res.status(400).json({ error: 'Название и хотя бы один другой пользователь обязательны' });
  }

  const otherUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && id !== req.userId);
  if (!otherUserIds.length) return res.status(400).json({ error: 'Требуется хотя бы один корректный ID другого пользователя' });

  for (const uid of otherUserIds) {
    const exists = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (!exists.rows.length) return res.status(404).json({ error: `Пользователь с ID ${uid} не существует` });
    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    if (!isFriend.rows.length) return res.status(403).json({ error: `Пользователь ${uid} не ваш друг` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO conversations (is_group, is_channel, title) VALUES (true, true, $1) RETURNING id',
      [title.trim()]
    );
    const cid = ins.rows[0].id;
    for (const uid of [req.userId, ...otherUserIds]) {
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [cid, uid, uid === req.userId ? 'owner' : 'member']
      );
    }
    await client.query('COMMIT');
    for (const uid of otherUserIds) {
      broadcastToUser(uid, { type: 'new_channel', conversationId: cid, channelTitle: title.trim() });
    }
    res.json({ conversationId: cid });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ---- Leave Group ----
app.post('/api/groups/:id/leave', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const check = await pool.query(`
    SELECT c.is_group, cp.role FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);

  if (!check.rows.length || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Группа не найдена или вы не участник' });
  }

  const isOwner = check.rows[0].role === 'owner';

  if (isOwner) {
    const admins = await pool.query(
      `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND role = 'admin' AND user_id != $2`,
      [groupId, req.userId]
    );
    let newOwnerId;
    if (admins.rows.length > 0) {
      newOwnerId = admins.rows[Math.floor(Math.random() * admins.rows.length)].user_id;
    } else {
      const members = await pool.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
        [groupId, req.userId]
      );
      if (members.rows.length > 0) {
        newOwnerId = members.rows[Math.floor(Math.random() * members.rows.length)].user_id;
      }
    }
    if (newOwnerId) {
      await pool.query(
        `UPDATE conversation_participants SET role = 'owner' WHERE conversation_id = $1 AND user_id = $2`,
        [groupId, newOwnerId]
      );
      const participants = await pool.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [groupId]
      );
      for (const row of participants.rows) {
        broadcastToUser(row.user_id, { type: 'owner_changed', conversationId: groupId, newOwnerId });
      }
    }
  }

  await pool.query(
    'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );

  const left = await pool.query(
    'SELECT COUNT(*)::int AS c FROM conversation_participants WHERE conversation_id = $1', [groupId]
  );
  if (left.rows[0].c === 0) {
    await pool.query('DELETE FROM conversations WHERE id = $1', [groupId]);
  }

  res.json({ success: true });
});

// ---- Messages ----
app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Неверный ID чата' });

  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (!part.rows.length) return res.status(404).json({ error: 'Чат не найден' });

  // Пагинация
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  const queryParams = [convId, req.userId];
  let beforeClause = '';
  if (before && !isNaN(before)) {
    queryParams.push(before);
    beforeClause = `AND m.id < $${queryParams.length}`;
  }
  queryParams.push(limit);
  const limitClause = `$${queryParams.length}`;

  const r = await pool.query(`
    SELECT 
      m.id, m.body, m.created_at, m.sender_id,
      u.username AS sender_username, u.display_name AS sender_display_name,
      m.reply_to_id,
      r.body AS reply_body,
      ru.username AS reply_sender_username, ru.display_name AS reply_sender_display_name,
      (SELECT json_agg(json_build_object('emoji', r2.emoji, 'count', r2.cnt, 'me', r2.me))
       FROM (SELECT emoji, COUNT(*) as cnt, bool_or(user_id = $2) as me
             FROM reactions WHERE message_id = m.id GROUP BY emoji) r2) AS reactions
    FROM messages m
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1 ${beforeClause}
    ORDER BY m.created_at ASC
    LIMIT ${limitClause}
  `, queryParams);

  const messages = r.rows.map(row => {
    const msg = {
      id: row.id,
      body: row.body,
      created_at: row.created_at,
      sender_id: row.sender_id,
      sender_username: row.sender_username,
      sender_display_name: row.sender_display_name,
      reactions: row.reactions || [],
      reply_to_id: row.reply_to_id
    };
    if (row.reply_to_id) {
      msg.reply_to = {
        id: row.reply_to_id,
        body: row.reply_body,
        senderName: row.reply_sender_display_name || row.reply_sender_username || 'Unknown'
      };
    }
    return msg;
  });

  const convCheck = await pool.query('SELECT is_group FROM conversations WHERE id = $1', [convId]);
  const isGroup = convCheck.rows[0]?.is_group || false;
  if (!isGroup) {
    const participants = await pool.query(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
      [convId, req.userId]
    );
    const otherUserId = participants.rows[0]?.user_id;
    if (otherUserId) {
      const notifRes = await pool.query(
        'SELECT message_id FROM notifications WHERE user_id = $1 AND conversation_id = $2',
        [otherUserId, convId]
      );
      const unreadMessageIds = new Set(notifRes.rows.map(row => row.message_id));
      for (const msg of messages) {
        if (msg.sender_id === req.userId) {
          msg.read = !unreadMessageIds.has(msg.id);
        }
      }
    }
  }

  res.json(messages);
});

app.post('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Неверный ID чата' });

  const { body, replyToId } = req.body || {};
  const messageBody = String(body || '').trim();
  if (!messageBody) return res.status(400).json({ error: 'Текст сообщения обязателен' });
  if (messageBody.length > 5000) return res.status(400).json({ error: 'Сообщение слишком длинное (максимум 5000 символов)' });

  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [convId]
  );
  if (!part.rows.length) return res.status(404).json({ error: 'Чат не найден' });
  if (!part.rows.some(p => p.user_id === req.userId)) return res.status(403).json({ error: 'Вы не участвуете в этом чате' });

  const convInfo = await pool.query('SELECT is_channel FROM conversations WHERE id = $1', [convId]);
  if (!convInfo.rows.length) return res.status(404).json({ error: 'Чат не найден' });
  if (convInfo.rows[0].is_channel) {
    const roleRes = await pool.query(
      'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [convId, req.userId]
    );
    if (roleRes.rows[0]?.role !== 'owner') {
      return res.status(403).json({ error: 'В каналах только владелец может отправлять сообщения' });
    }
  }

  const muteCheck = await pool.query(
    'SELECT muted_until FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (muteCheck.rows[0]?.muted_until && new Date(muteCheck.rows[0].muted_until) > new Date()) {
    return res.status(403).json({ error: 'Вы заглушены' });
  }

  let replyToIdNum = replyToId ? parseInt(replyToId, 10) : null;
  if (replyToIdNum) {
    const orig = await pool.query('SELECT id, conversation_id FROM messages WHERE id = $1', [replyToIdNum]);
    if (!orig.rows.length) return res.status(400).json({ error: 'Сообщение для ответа не существует' });
    if (orig.rows[0].conversation_id !== convId) return res.status(400).json({ error: 'Сообщение для ответа из другого чата' });
  }

  const ins = await pool.query(`
    WITH new_msg AS (
      INSERT INTO messages (conversation_id, sender_id, body, reply_to_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    )
    SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name,
           r.body AS reply_body, ru.username AS reply_sender_username, ru.display_name AS reply_sender_display_name
    FROM new_msg m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id
  `, [convId, req.userId, messageBody, replyToIdNum]);

  const fullMsg = ins.rows[0];
  let msgType = 'text';
  try {
    const parsed = JSON.parse(fullMsg.body);
    if (['file', 'gallery', 'composite'].includes(parsed.type)) msgType = parsed.type;
  } catch (_) {}

  const resultMsg = {
    id: fullMsg.id, body: fullMsg.body, created_at: fullMsg.created_at,
    sender_id: fullMsg.sender_id, sender_username: fullMsg.sender_username,
    sender_display_name: fullMsg.sender_display_name, message_type: msgType
  };
  if (fullMsg.reply_to_id) {
    resultMsg.reply_to = {
      id: fullMsg.reply_to_id, body: fullMsg.reply_body,
      senderName: fullMsg.reply_sender_display_name || fullMsg.reply_sender_username || 'Unknown'
    };
  }

  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);
  for (const uid of otherUserIds) {
    await pool.query(
      'INSERT INTO notifications (user_id, conversation_id, message_id) VALUES ($1, $2, $3)',
      [uid, convId, resultMsg.id]
    );
    broadcastToUser(uid, { type: 'new_message', conversationId: convId, message: resultMsg });
  }

  const pushPayload = {
    title: `Новое сообщение от ${resultMsg.sender_username}`,
    body: messageBody.length > 100 ? messageBody.slice(0, 97) + '...' : messageBody,
    icon: '/images/logo.png',
    data: { conversationId: convId, messageId: resultMsg.id },
  };
  sendPushNotifications(otherUserIds, pushPayload).catch(err => console.error('Push error:', err));

  res.status(201).json(resultMsg);
});

// ---- Delete Message ----
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  if (isNaN(messageId) || messageId <= 0) return res.status(400).json({ error: 'Invalid message ID' });

  const r = await pool.query(
    'SELECT id, sender_id, conversation_id, body FROM messages WHERE id = $1', [messageId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Сообщение не найдено' });

  const message = r.rows[0];

  if (message.sender_id !== req.userId) {
    const roleCheck = await pool.query(
      'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [message.conversation_id, req.userId]
    );
    const role = roleCheck.rows[0]?.role;
    if (!role || (role !== 'owner' && role !== 'admin')) {
      return res.status(403).json({ error: 'Нет прав для удаления этого сообщения' });
    }
  }

  // Удаляем файлы
  if (message.body?.includes('/uploads/')) {
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const matches = message.body.match(/\/uploads\/([^"'\s]+)/g);
    if (matches) {
      for (const match of matches) {
        try {
          const filename = path.basename(new URL(match, 'http://dummy').pathname.split('?')[0]);
          const filePath = path.join(uploadsDir, filename);
          if (filePath.startsWith(uploadsDir)) {
            await fsPromises.unlink(filePath).catch(() => {});
          }
        } catch (_) {}
      }
    }
  }

  await pool.query('DELETE FROM notifications WHERE message_id = $1', [messageId]);
  await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

  const participants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [message.conversation_id]
  );
  const deletePayload = { type: 'message_deleted', conversationId: message.conversation_id, messageId: message.id };
  for (const row of participants.rows) {
    broadcastToUser(row.user_id, deletePayload);
  }

  res.json({ success: true });
});

// ---- Reactions ----
app.post('/api/messages/:id/reactions', authMiddleware, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const { emoji } = req.body || {};

  if (isNaN(messageId) || messageId <= 0 || !emoji || typeof emoji !== 'string' || emoji.length > 50) {
    return res.status(400).json({ error: 'Неверный ID сообщения или эмодзи' });
  }

  // Белый список эмодзи
  const ALLOWED_EMOJIS = new Set(['like', 'heart', 'laugh', 'wow', 'sad', 'angry']);
  if (!ALLOWED_EMOJIS.has(emoji)) {
    return res.status(400).json({ error: 'Недопустимый эмодзи' });
  }

  const msg = await pool.query('SELECT conversation_id FROM messages WHERE id = $1', [messageId]);
  if (!msg.rows.length) return res.status(404).json({ error: 'Сообщение не найдено' });

  const convId = msg.rows[0].conversation_id;
  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (!part.rows.length) return res.status(403).json({ error: 'Вы не участвуете в этом чате' });

  const existing = await pool.query(
    'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, req.userId, emoji]
  );

  let action;
  if (existing.rows.length) {
    await pool.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
    action = 'remove';
  } else {
    await pool.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, req.userId, emoji]);
    action = 'add';
  }

  const participants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [convId]
  );
  const payload = { type: 'reaction', messageId, userId: req.userId, emoji, action };
  for (const row of participants.rows) {
    broadcastToUser(row.user_id, payload);
  }

  res.json({ success: true, action });
});

// ---- Notifications ----
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1', [req.userId]);
  res.json({ count: r.rows[0].c });
});

app.get('/api/notifications', authMiddleware, async (req, res) => {
  const r = await pool.query(
    'SELECT conversation_id, COUNT(*)::int AS c FROM notifications WHERE user_id = $1 GROUP BY conversation_id',
    [req.userId]
  );
  const byConvo = {};
  r.rows.forEach(row => { byConvo[row.conversation_id] = row.c; });
  res.json(byConvo);
});

app.get('/api/notifications/stream', streamAuthMiddleware, sseConnectionLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const userId = req.userId;

  if (sseClients.has(userId) && sseClients.get(userId).length >= MAX_SSE_PER_USER) {
    res.status(429).end('Слишком много SSE-соединений');
    return;
  }

  const wasOnline = isUserOnline(userId);
  if (!sseClients.has(userId)) sseClients.set(userId, []);
  sseClients.get(userId).push(res);

  if (!wasOnline) {
    broadcastStatusChange(userId, true).catch(err => console.error('broadcastStatusChange error:', err));
  }

  // Keepalive пинг каждые 25 секунд
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); }
  }, 25000);

  req.on('close', async () => {
    clearInterval(keepalive);
    const list = sseClients.get(userId);
    if (list) {
      const i = list.indexOf(res);
      if (i !== -1) list.splice(i, 1);
      if (list.length === 0) {
        sseClients.delete(userId);
        try {
          await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
          await broadcastStatusChange(userId, false);
        } catch (err) {
          console.error(`Failed to update last_seen for user ${userId}:`, err);
        }
      }
    }
  });
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  const { conversationId } = req.body || {};
  if (conversationId != null) {
    const convId = parseInt(conversationId, 10);
    if (!isNaN(convId) && convId > 0) {
      const notifResult = await pool.query(
        'SELECT message_id FROM notifications WHERE user_id = $1 AND conversation_id = $2',
        [req.userId, convId]
      );
      const messageIds = notifResult.rows.map(r => r.message_id);
      if (messageIds.length > 0) {
        await pool.query(
          'DELETE FROM notifications WHERE user_id = $1 AND conversation_id = $2',
          [req.userId, convId]
        );
        const senderRes = await pool.query(
          'SELECT DISTINCT sender_id FROM messages WHERE id = ANY($1::int[])', [messageIds]
        );
        for (const { sender_id } of senderRes.rows) {
          if (sender_id !== req.userId) {
            broadcastToUser(sender_id, {
              type: 'messages_read',
              conversationId: convId,
              messageIds,
              readerId: req.userId
            });
          }
        }
      }
    }
  }
  res.json({ ok: true });
});

// ---- Signaling ----
app.get('/api/signaling', streamAuthMiddleware, sseConnectionLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const userId = req.userId;

  if (signalingChannels.has(userId) && signalingChannels.get(userId).size >= MAX_SIGNALING_PER_USER) {
    res.status(429).end('Слишком много сигнальных соединений');
    return;
  }

  if (!signalingChannels.has(userId)) signalingChannels.set(userId, new Set());
  signalingChannels.get(userId).add(res);

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepalive);
    const set = signalingChannels.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) signalingChannels.delete(userId);
    }
  });
});

app.post('/api/signaling', authMiddleware, async (req, res) => {
  const { type, targetUserId, offer, answer, candidate, conversationId } = req.body || {};
  if (!type || !targetUserId) return res.status(400).json({ error: 'Требуется тип и целевой пользователь' });

  const VALID_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'call-ended', 'call-rejected']);
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'Неизвестный тип сигнала' });

  const targetId = parseInt(targetUserId, 10);
  if (isNaN(targetId) || targetId <= 0) return res.status(400).json({ error: 'Неверный ID целевого пользователя' });

  const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
  if (!userExists.rows.length) return res.status(404).json({ error: 'Целевой пользователь не найден' });

  const areFriends = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, targetId]
  );
  if (!areFriends.rows.length) {
    const common = await pool.query(`
      SELECT 1 FROM conversation_participants cp1
      JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
      WHERE cp1.user_id = $1 AND cp2.user_id = $2 LIMIT 1
    `, [req.userId, targetId]);
    if (!common.rows.length) return res.status(403).json({ error: 'Нет общего чата или дружбы' });
  }

  const payload = { type, fromUserId: req.userId };
  if (type === 'offer') { if (!offer) return res.status(400).json({ error: 'Требуется offer' }); payload.offer = offer; }
  else if (type === 'answer') { if (!answer) return res.status(400).json({ error: 'Требуется answer' }); payload.answer = answer; }
  else if (type === 'ice-candidate') { if (!candidate) return res.status(400).json({ error: 'Требуется candidate' }); payload.candidate = candidate; }
  else if (conversationId) { payload.conversationId = conversationId; }

  const channels = signalingChannels.get(targetId);
  if (channels) {
    const eventName = type;
    for (const client of Array.from(channels)) {
      try {
        client.write(`event: ${eventName}\n`);
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        channels.delete(client);
      }
    }
    if (channels.size === 0) signalingChannels.delete(targetId);
  }

  res.json({ ok: true });
});

// ---- Group Members ----
app.get('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const groupCheck = await pool.query('SELECT is_group FROM conversations WHERE id = $1', [groupId]);
  if (!groupCheck.rows.length) return res.status(404).json({ error: 'Группа не найдена' });
  if (!groupCheck.rows[0].is_group) return res.status(400).json({ error: 'Это не группа' });

  const memberCheck = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!memberCheck.rows.length) return res.status(403).json({ error: 'Вы не участник этой группы' });

  const r = await pool.query(`
    SELECT u.id, u.username, u.display_name, cp.role
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = $1
  `, [groupId]);

  res.json(r.rows);
});

app.post('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.body?.userId, 10);

  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });
  if (isNaN(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: 'Требуется корректный ID пользователя' });

  const convRes = await pool.query('SELECT id, title, is_group FROM conversations WHERE id = $1', [groupId]);
  if (!convRes.rows.length) return res.status(404).json({ error: 'Чат не найден' });
  if (!convRes.rows[0].is_group) return res.status(400).json({ error: 'Это не группа' });

  const roleRes = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!roleRes.rows.length) return res.status(403).json({ error: 'Вы не участник этой группы' });
  const userRole = roleRes.rows[0].role;
  if (userRole !== 'owner' && userRole !== 'admin') {
    return res.status(403).json({ error: 'Только владельцы и администраторы могут добавлять участников' });
  }

  const userRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [targetUserId]);
  if (!userRes.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

  const existing = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );
  if (existing.rows.length) return res.status(400).json({ error: 'Пользователь уже в группе' });

  const friendCheck = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, targetUserId]
  );
  if (!friendCheck.rows.length) return res.status(403).json({ error: 'Вы можете добавлять только друзей' });

  await pool.query(
    'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
    [groupId, targetUserId, 'member']
  );

  const participantsRes = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [groupId]
  );

  broadcastToUser(targetUserId, { type: 'added_to_group', conversationId: groupId, groupTitle: convRes.rows[0].title });
  const memberAddedPayload = { type: 'member_added', conversationId: groupId, userId: targetUserId, user: { id: userRes.rows[0].id, username: userRes.rows[0].username, role: 'member' } };
  for (const { user_id } of participantsRes.rows) {
    if (user_id !== targetUserId) broadcastToUser(user_id, memberAddedPayload);
  }

  res.json({ success: true });
});

// ---- Group moderation ----
app.post('/api/groups/:id/promote', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.body?.userId, 10);
  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  const requester = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!requester.rows.length || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец группы может назначать администраторов' });
  }
  await pool.query(
    `UPDATE conversation_participants SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`,
    [groupId, targetUserId]
  );
  res.json({ success: true });
});

app.post('/api/groups/:id/mute', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.body?.userId, 10);
  const muteMinutes = parseInt(req.body?.minutes, 10);

  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0 || isNaN(muteMinutes) || muteMinutes < 1) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  const MAX_MUTE_MINUTES = 525600;
  if (muteMinutes > MAX_MUTE_MINUTES) return res.status(400).json({ error: `Максимальная длительность мута: ${MAX_MUTE_MINUTES} минут` });

  const requester = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!requester.rows.length) return res.status(404).json({ error: 'Not a member' });
  const reqRole = requester.rows[0].role;
  if (reqRole !== 'owner' && reqRole !== 'admin') return res.status(403).json({ error: 'Только администраторы могут заглушать участников' });

  const target = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );
  if (!target.rows.length) return res.status(404).json({ error: 'User not in group' });
  const tgtRole = target.rows[0].role;
  if (tgtRole === 'owner') return res.status(403).json({ error: 'Нельзя заглушить владельца' });
  if (tgtRole === 'admin' && reqRole !== 'owner') return res.status(403).json({ error: 'Только владелец может заглушать администраторов' });

  await pool.query(
    `UPDATE conversation_participants SET muted_until = NOW() + ($1 * interval '1 minute') WHERE conversation_id = $2 AND user_id = $3`,
    [muteMinutes, groupId, targetUserId]
  );
  res.json({ success: true });
});

app.post('/api/groups/:id/demote', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.body?.userId, 10);
  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  const requester = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!requester.rows.length || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец группы может снимать администраторов' });
  }
  await pool.query(
    `UPDATE conversation_participants SET role = 'member' WHERE conversation_id = $1 AND user_id = $2 AND role = 'admin'`,
    [groupId, targetUserId]
  );
  res.json({ success: true });
});

app.post('/api/groups/:id/unmute', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.body?.userId, 10);
  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  const requester = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!requester.rows.length) return res.status(404).json({ error: 'Not a member' });
  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Только администраторы могут разглушать участников' });
  }
  await pool.query(
    'UPDATE conversation_participants SET muted_until = NULL WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );
  res.json({ success: true });
});

app.delete('/api/groups/:id/kick/:userId', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.params.userId, 10);
  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }
  if (targetUserId === req.userId) return res.status(400).json({ error: 'Нельзя кикнуть самого себя' });

  const allParticipants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [groupId]
  );
  const allUserIds = allParticipants.rows.map(r => r.user_id);

  const requester = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (!requester.rows.length) return res.status(404).json({ error: 'Not a member' });
  const reqRole = requester.rows[0].role;
  if (reqRole !== 'owner' && reqRole !== 'admin') return res.status(403).json({ error: 'Только администраторы могут кикать участников' });

  const target = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );
  if (!target.rows.length) return res.status(404).json({ error: 'User not in group' });
  const tgtRole = target.rows[0].role;
  if (tgtRole === 'owner') return res.status(403).json({ error: 'Нельзя кикнуть владельца' });
  if (tgtRole === 'admin' && reqRole !== 'owner') return res.status(403).json({ error: 'Только владелец может кикать администраторов' });

  await pool.query(
    'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );

  const remaining = await pool.query(
    'SELECT COUNT(*)::int AS c FROM conversation_participants WHERE conversation_id = $1', [groupId]
  );

  if (remaining.rows[0].c === 0) {
    const payload = { type: 'group_deleted', conversationId: groupId };
    for (const uid of allUserIds) broadcastToUser(uid, payload);
  } else {
    broadcastToUser(targetUserId, { type: 'kicked_from_group', conversationId: groupId });
    const memberRemovedPayload = { type: 'member_removed', conversationId: groupId, userId: targetUserId };
    for (const uid of allUserIds) {
      if (uid !== targetUserId) broadcastToUser(uid, memberRemovedPayload);
    }
  }

  res.json({ success: true });
});

// ---- File Upload ----
app.post('/api/upload', authMiddleware, uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `Файл слишком большой. Максимум ${Math.round(MAX_UPLOAD_SIZE / 1024 / 1024)} МБ.` });
        }
        return res.status(400).json({ error: 'Ошибка загрузки файла: ' + err.message });
      }
      if (err.code === 'INVALID_MIME') {
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: 'Не удалось загрузить файл.' });
    }

    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const originalName = req.file.originalname;
    const fixedName = /[Ð-ÿ]/.test(originalName)
      ? Buffer.from(originalName, 'latin1').toString('utf8')
      : originalName;

    res.json({
      url: '/uploads/' + encodeURIComponent(req.file.filename),
      downloadUrl: '/api/files/' + encodeURIComponent(req.file.filename) + '?name=' + encodeURIComponent(fixedName),
      name: fixedName,
      type: req.file.mimetype
    });
  });
});

// ---- Static files ----
app.use('/uploads', (req, res, next) => {
  // Защита от path traversal
  const filename = path.basename(req.path);
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (safeFilename !== filename) return res.status(400).end();
  next();
}, express.static('uploads'));

app.get('/api/files/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeFilename || safeFilename !== filename) return res.status(400).end();

  const uploadsDir = path.resolve(__dirname, 'uploads');
  const resolvedPath = path.resolve(path.join(uploadsDir, safeFilename));
  if (!resolvedPath.startsWith(uploadsDir)) return res.status(400).end();
  if (!fs.existsSync(resolvedPath)) return res.status(404).end();

  const name = req.query.name;
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(name || filename)}`
  );
  res.sendFile(resolvedPath);
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Serve index.html with VAPID key substitution ----
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Не найдено' });
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return res.status(500).end();
    const safeVapidKey = (process.env.VAPID_PUBLIC_KEY || '').replace(/[^A-Za-z0-9\-_]/g, '');
    const result = html.replace('__VAPID_PUBLIC_KEY__', safeVapidKey);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result);
  });
});

// ---- Main ----
async function main() {
  try {
    await initDb();

    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user1_id INTEGER, ADD COLUMN IF NOT EXISTS user2_id INTEGER`);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_channel BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()`);
      await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`);
      console.log('All columns added/verified');
    } catch (err) {
      console.error('Failed to add columns:', err);
      throw err;
    } finally {
      client.release();
    }

    const clientIdx = await pool.connect();
    try {
      await clientIdx.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_dm 
        ON conversations (user1_id, user2_id) WHERE is_group = false
      `);
    } catch (err) {
      console.error('Failed to create DM index:', err);
    } finally {
      clientIdx.release();
    }

    const clientFK = await pool.connect();
    try {
      await clientFK.query(`
        ALTER TABLE conversations 
        DROP CONSTRAINT IF EXISTS conversations_user1_id_fkey,
        DROP CONSTRAINT IF EXISTS conversations_user2_id_fkey
      `);
      await clientFK.query(`
        ALTER TABLE conversations 
        ADD CONSTRAINT conversations_user1_id_fkey FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE,
        ADD CONSTRAINT conversations_user2_id_fkey FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE
      `);
    } catch (err) {
      console.error('Failed to recreate foreign keys:', err);
    } finally {
      clientFK.release();
    }

    console.log('Database initialization complete');
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }

  server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

// ---- Graceful shutdown ----
let server;

async function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);

  // Закрываем все SSE и signaling соединения
  for (const [, clients] of sseClients) {
    clients.forEach(c => { try { c.end(); } catch (_) {} });
  }
  sseClients.clear();

  for (const [, set] of signalingChannels) {
    set.forEach(c => { try { c.end(); } catch (_) {} });
  }
  signalingChannels.clear();

  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      pool.end().then(() => {
        console.log('Database pool closed');
        process.exit(0);
      }).catch(err => {
        console.error('Error closing pool:', err);
        process.exit(1);
      });
    });
  } else {
    await pool.end().catch(() => {});
    process.exit(0);
  }

  setTimeout(() => {
    console.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main();