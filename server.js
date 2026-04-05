require('dotenv').config();
require('express-async-errors'); // Автоматически передаёт ошибки из async в next()
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

// Setup VAPID
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Атомарное создание папки uploads
try {
  fs.mkdirSync('uploads', { recursive: true });
} catch (err) {
  if (err.code !== 'EEXIST') {
    console.error('Failed to create uploads directory:', err);
    process.exit(1);
  }
}

// Настройка Multer для загрузки файлов с ограничениями
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

// Генерация friend code
function generateFriendCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const charsLength = chars.length;
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % charsLength];
  }
  return result;
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30
};

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Лимит для SSE соединений (на пользователя)
const sseConnectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.userId ? String(req.userId) : req.ip,
  message: { error: 'Слишком много SSE-соединений, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Глобальные обработчики непойманных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Даём время на завершение текущих запросов, затем выходим
  setTimeout(() => process.exit(1), 1000);
});

const sseClients = new Map(); // userId -> array of response objects
const MAX_SSE_PER_USER = 5;   // Максимум одновременных SSE соединений на пользователя

function isUserOnline(userId) {
  const clients = sseClients.get(userId);
  return clients && clients.length > 0;
}

// Вспомогательная функция для безопасной рассылки SSE
function broadcastToUser(userId, payload) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i].write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      // При ошибке закрываем соединение и удаляем
      clients[i].end();
      clients.splice(i, 1);
    }
  }
  if (clients.length === 0) {
    sseClients.delete(userId);
  }
}

// Получить список пользователей, которым нужно сообщить об изменении статуса userId
async function getUsersToNotifyAboutStatus(userId) {
  const client = await pool.connect();
  try {
    // Друзья
    const friendsRes = await client.query(
      'SELECT friend_id FROM friends WHERE user_id = $1',
      [userId]
    );
    const friendIds = friendsRes.rows.map(r => r.friend_id);

    // Участники общих диалогов (кроме себя)
    const participantsRes = await client.query(`
      SELECT DISTINCT user_id
      FROM conversation_participants
      WHERE conversation_id IN (
        SELECT conversation_id
        FROM conversation_participants
        WHERE user_id = $1
      ) AND user_id != $1
    `, [userId]);
    const chatParticipantIds = participantsRes.rows.map(r => r.user_id);

    // Объединяем и убираем дубли
    return [...new Set([...friendIds, ...chatParticipantIds])];
  } finally {
    client.release();
  }
}

// Разослать событие об изменении статуса
async function broadcastStatusChange(userId, online) {
  const targetUserIds = await getUsersToNotifyAboutStatus(userId);
  const payload = {
    type: 'user_status',
    userId: userId,
    online: online,
    last_seen: online ? null : new Date().toISOString()
  };
  for (const targetId of targetUserIds) {
    broadcastToUser(targetId, payload);
  }
}

// Middleware для проверки авторизации (стандартный)
function authMiddleware(req, res, next) {
  let token = req.cookies.token;

  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

// Middleware для SSE (только куки и заголовок, без query token)
function streamAuthMiddleware(req, res, next) {
  let token = req.cookies.token;

  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
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
//---- уведомления ----
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Неверная подписка' });
  }

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE
       SET keys_auth = EXCLUDED.keys_auth,
           keys_p256dh = EXCLUDED.keys_p256dh`,
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
  for (const userId of users) {
    // Не отправляем push, если пользователь сейчас онлайн (у него открыто SSE соединение)
    if (isUserOnline(userId)) {
      continue;
    }
    const subs = await pool.query(
      'SELECT endpoint, keys_auth, keys_p256dh FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    for (const sub of subs.rows) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          auth: sub.keys_auth,
          p256dh: sub.keys_p256dh,
        },
      };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err) {
        if (err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        } else {
          console.error('Push send error:', err);
        }
      }
    }
  }
}

// ---- Auth ----
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || trimmedUsername.length < 2 || trimmedUsername.length > 50) {
    return res.status(400).json({ error: 'Имя пользователя должно быть от 2 до 50 символов' });
  }
  if (!password || password.length < 6 || password.length > 72) {
    return res.status(400).json({ error: 'Пароль должен быть от 6 до 72 символов' });
  }

  const hash = await bcrypt.hash(password, 10);
  let friendCode = generateFriendCode();
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    try {
      const r = await pool.query(
        'INSERT INTO users (username, password_hash, friend_code) VALUES ($1, $2, $3) RETURNING id, username, friend_code',
        [trimmedUsername, hash, friendCode]
      );
      const user = r.rows[0];
      const token = jwt.sign({ userId: user.id }, JWT_SECRET);

      res.cookie('token', token, COOKIE_OPTIONS);

      return res.json({
        user: {
          id: user.id,
          username: user.username,
          friend_code: user.friend_code
        }
      });
    } catch (e) {
      if (e.code === '23505') {
        if (e.constraint && e.constraint.includes('friend_code')) {
          friendCode = generateFriendCode();
          attempts++;
          continue;
        }
        return res.status(400).json({ error: 'Имя пользователя уже занято' });
      }
      throw e; // будет перехвачено express-async-errors
    }
  }
  return res.status(500).json({ error: 'Не удалось сгенерировать уникальный код друга' });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || !password) return res.status(400).json({ error: 'Требуется имя пользователя и пароль' });

  const r = await pool.query('SELECT id, username, password_hash, friend_code FROM users WHERE username = $1', [trimmedUsername]);
  const user = r.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  let friendCode = user.friend_code;
  if (!friendCode) {
    friendCode = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [friendCode, user.id]);
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET);

  res.cookie('token', token, COOKIE_OPTIONS);

  return res.json({
    user: {
      id: user.id,
      username: user.username,
      friend_code: friendCode
    }
  });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ success: true });
});

// ---- Me ----
app.get('/api/me', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT id, username, display_name, friend_code FROM users WHERE id = $1', [req.userId]);
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

// ---- Display Name ----
app.get('/api/display-name', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT display_name, username FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  res.json({
    displayName: user.display_name || user.username,
    username: user.username
  });
});

app.post('/api/display-name', authMiddleware, async (req, res) => {
  const { displayName } = req.body || {};
  const trimmedName = displayName?.trim();

  if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 50) {
    return res.status(400).json({ error: 'Display name must be 2-50 characters' });
  }

  await pool.query(
    'UPDATE users SET display_name = $1 WHERE id = $2',
    [trimmedName, req.userId]
  );

  res.json({ displayName: trimmedName });
});

// Смена пароля
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const trimmedOld = oldPassword ? oldPassword.trim() : '';
  const trimmedNew = newPassword ? newPassword.trim() : '';

  if (!trimmedOld || !trimmedNew) {
    return res.status(400).json({ error: 'Старый и новый пароль обязательны' });
  }

  if (trimmedNew.length < 6 || trimmedNew.length > 72) {
    return res.status(400).json({ error: 'Новый пароль должен быть от 6 до 72 символов' });
  }

  // Получаем текущий хеш пароля пользователя
  const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (userRes.rows.length === 0) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  const user = userRes.rows[0];
  const isValid = await bcrypt.compare(trimmedOld, user.password_hash);
  if (!isValid) {
    return res.status(401).json({ error: 'Неверный старый пароль' });
  }

  // Генерируем новый хеш
  const newHash = await bcrypt.hash(trimmedNew, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId]);

  // Необязательно: сбросить все сессии – удалим куку на клиенте
  // На сервере просто возвращаем успех, клиент сам выйдет
  res.json({ success: true });
});

// ---- Delete account ----
app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];

  if (!user) return res.status(404).json({ error: 'Не найдено' });

  if (!password || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Требуется пароль для удаления аккаунта' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Удалить файлы, загруженные пользователем (из сообщений)
    const messages = await client.query('SELECT body FROM messages WHERE sender_id = $1', [req.userId]);
    for (const msg of messages.rows) {
      if (msg.body && msg.body.includes('/uploads/')) {
        const matches = msg.body.match(/\/uploads\/([^"'\s]+)/g);
        if (matches) {
          for (const match of matches) {
            const filename = path.basename(match);
            const filePath = path.join(__dirname, 'uploads', filename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }
        }
      }
    }

    // 2. Удалить уведомления, адресованные другим пользователям о сообщениях удаляемого
    await client.query(
      'DELETE FROM notifications WHERE message_id IN (SELECT id FROM messages WHERE sender_id = $1)',
      [req.userId]
    );

    // 3. Удалить уведомления самого пользователя
    await client.query('DELETE FROM notifications WHERE user_id = $1', [req.userId]);

    // 4. Удалить сообщения пользователя
    await client.query('DELETE FROM messages WHERE sender_id = $1', [req.userId]);

    // 5. Удалить записи из conversation_participants
    await client.query('DELETE FROM conversation_participants WHERE user_id = $1', [req.userId]);

    // 6. Удалить связи друзей
    await client.query('DELETE FROM friends WHERE user_id = $1 OR friend_id = $1', [req.userId]);

    // 7. Удалить пустые диалоги
    await client.query(`
      DELETE FROM conversations
      WHERE id IN (
        SELECT c.id
        FROM conversations c
        LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id
        GROUP BY c.id
        HAVING COUNT(cp.user_id) = 0
      )
    `);

    // 8. Удалить пользователя
    await client.query('DELETE FROM users WHERE id = $1', [req.userId]);

    await client.query('COMMIT');
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

  const friends = r.rows.map(u => ({
    ...u,
    online: isUserOnline(u.id)
  }));
  res.json(friends);
});

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendCode } = req.body || {};
  const code = String(friendCode || '').trim().toUpperCase();

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
      c.id,
      c.created_at,
      c.is_group,
      c.title,
      c.is_channel,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'display_name', u.display_name,
            'name', COALESCE(u.display_name, u.username),
            'role', cp.role,
            'last_seen', u.last_seen
          )
        ),
        '[]'::json
      ) AS participants,
      MAX(m.created_at) AS last_at,
      (
        SELECT jsonb_build_object(
          'id', m2.id,
          'body', m2.body,
          'sender_id', m2.sender_id,
          'sender_username', u2.username,
          'created_at', m2.created_at
        )
        FROM messages m2
        JOIN users u2 ON u2.id = m2.sender_id
        WHERE m2.conversation_id = c.id
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS last_message
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.id IN (
      SELECT conversation_id 
      FROM conversation_participants 
      WHERE user_id = $1
    )
    GROUP BY c.id
    ORDER BY last_at DESC NULLS LAST
  `, [req.userId]);

  const convos = r.rows.map(row => {
    const participants = row.participants || [];
    const otherUsers = participants.filter(p => p.id !== req.userId).map(p => ({
      ...p,
      online: isUserOnline(p.id)
    }));
    const lastMessage = row.last_message;

    return {
      id: row.id,
      isGroup: row.is_group || false,
      isChannel: row.is_channel || false,
      title: row.title,
      participants: participants, // original
      otherUsers: otherUsers,
      otherUser: !row.is_group && otherUsers.length > 0 ? otherUsers[0] : null,
      lastMessage: lastMessage ? lastMessage.body : null,
      lastMessageData: lastMessage,
      lastAt: row.last_at,
      createdAt: row.created_at
    };
  });

  res.json(convos);
});

// Create DM (с использованием уникального индекса на user1_id, user2_id)
app.post('/api/dms', authMiddleware, async (req, res) => {
  const { otherUserId } = req.body || {};
  if (!otherUserId || otherUserId === req.userId) {
    return res.status(400).json({ error: 'Требуется корректный другой пользователь' });
  }

  const otherId = parseInt(otherUserId, 10);
  if (isNaN(otherId) || otherId <= 0) {
    return res.status(400).json({ error: 'Неверный пользователь ID' });
  }

  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, otherId]
  );

  if (isFriend.rows.length === 0) {
    return res.status(403).json({ error: 'Сначала добавьте этого пользователя в друзья' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user1 = Math.min(req.userId, otherId);
    const user2 = Math.max(req.userId, otherId);

    // Пытаемся вставить новый диалог, если он ещё не существует
    const insertResult = await client.query(
      `INSERT INTO conversations (is_group, user1_id, user2_id)
       VALUES (false, $1, $2)
       ON CONFLICT (user1_id, user2_id) WHERE is_group = false
       DO NOTHING
       RETURNING id`,
      [user1, user2]
    );

    let conversationId;
    if (insertResult.rows.length > 0) {
      // Новый диалог создан, добавляем участников
      conversationId = insertResult.rows[0].id;
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
        [conversationId, req.userId, otherId]
      );
    } else {
      // Диалог уже существует, получаем его ID
      const selectResult = await client.query(
        'SELECT id FROM conversations WHERE user1_id = $1 AND user2_id = $2 AND is_group = false',
        [user1, user2]
      );
      conversationId = selectResult.rows[0].id;
    }

    await client.query('COMMIT');
    res.json({ conversationId });
  } catch (e) {
    await client.query('ROLLBACK');
    // Если ошибка сериализации – повторяем (маловероятно, но оставим)
    if (e.code === '40001') {
      // Можно реализовать повтор, но для простоты вернём ошибку
      return res.status(500).json({ error: 'Одновременное создание, повторите попытку' });
    }
    throw e;
  } finally {
    client.release();
  }
});

// ---- IsTyping ----
app.post('/api/typing', authMiddleware, async (req, res) => {
  const { conversationId, action } = req.body;
  const convId = parseInt(conversationId, 10);
  if (isNaN(convId) || convId <= 0) {
    return res.status(400).json({ error: 'Неверный ID чата' });
  }
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ error: 'Действие должно быть "start" или "stop"' });
  }

  // Проверяем, является ли пользователь участником беседы
  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );
  if (!part.rows.some(p => p.user_id === req.userId)) {
    return res.status(403).json({ error: 'Вы не участвуете в этом чате' });
  }

  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);

  const payload = {
    type: 'typing',
    conversationId: convId,
    userId: req.userId,
    action: action
  };

  for (const uid of otherUserIds) {
    broadcastToUser(uid, payload);
  }

  res.json({ ok: true });
});

// ---- Groups ----
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};

  if (!title || !Array.isArray(userIds) || userIds.length < 1) {
    return res.status(400).json({ error: 'Название и хотя бы один другой пользователь обязательны' });
  }

  const otherUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && id !== req.userId);
  if (otherUserIds.length === 0) {
    return res.status(400).json({ error: 'Требуется хотя бы один корректный ID другого пользователя' });
  }

  for (const uid of otherUserIds) {
    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: `Пользователь с ID${uid} не существует` });
    }

    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    if (isFriend.rows.length === 0) {
      return res.status(403).json({ error: `Пользователь ${uid} не ваш друг` });
    }
  }

  const allUserIds = [req.userId, ...otherUserIds];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const ins = await client.query(
      'INSERT INTO conversations (is_group, title) VALUES (true, $1) RETURNING id',
      [title]
    );

    const cid = ins.rows[0].id;

    for (const uid of allUserIds) {
      const role = uid === req.userId ? 'owner' : 'member';
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [cid, uid, role]
      );
    }

    await client.query('COMMIT');

    // Уведомляем новых участников (кроме создателя)
    for (const uid of otherUserIds) {
      broadcastToUser(uid, {
        type: 'new_group',
        conversationId: cid,
        groupTitle: title
      });
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
              'id', u.id, 
              'username', u.username,
              'display_name', u.display_name,
              'name', COALESCE(u.display_name, u.username),
              'role', cp.role, 
              'muted_until', cp.muted_until,
              'last_seen', u.last_seen
            )) as participants
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id
    WHERE c.id = $1 AND c.is_group = true
    GROUP BY c.id
  `, [groupId]);

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Группа не найдена' });
  }

  const group = result.rows[0];
  const isMember = group.participants.some(p => p.id === req.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  // Добавляем online статус каждому участнику
  group.participants = group.participants.map(p => ({
    ...p,
    online: isUserOnline(p.id)
  }));

  res.json({
    ...group,
    isChannel: group.is_channel || false,
    participants: group.participants
  });
});

// ---- Channels ----
app.post('/api/channels', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};

  if (!title || !Array.isArray(userIds) || userIds.length < 1) {
    return res.status(400).json({ error: 'Название и хотя бы один другой пользователь обязательны' });
  }

  const otherUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && id !== req.userId);
  if (otherUserIds.length === 0) {
    return res.status(400).json({ error: 'Требуется хотя бы один корректный ID другого пользователя' });
  }

  // Проверяем существование и дружбу
  for (const uid of otherUserIds) {
    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: `Пользователь с ID${uid} не существует` });
    }
    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    if (isFriend.rows.length === 0) {
      return res.status(403).json({ error: `Пользователь ${uid} не ваш друг` });
    }
  }

  const allUserIds = [req.userId, ...otherUserIds];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Вставляем канал с is_channel = true
    const ins = await client.query(
      'INSERT INTO conversations (is_group, is_channel, title) VALUES (true, true, $1) RETURNING id',
      [title]
    );
    const cid = ins.rows[0].id;

    for (const uid of allUserIds) {
      const role = uid === req.userId ? 'owner' : 'member';
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [cid, uid, role]
      );
    }

    await client.query('COMMIT');

    // Уведомляем новых участников (кроме создателя)
    for (const uid of otherUserIds) {
      broadcastToUser(uid, {
        type: 'new_channel',
        conversationId: cid,
        channelTitle: title
      });
    }

    res.json({ conversationId: cid });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ---- LEAVE GROUP ----
app.post('/api/groups/:id/leave', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const check = await pool.query(`
    SELECT c.is_group, cp.role
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);

  if (check.rows.length === 0 || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Группа не найдена or not a member' });
  }

  const role = check.rows[0].role;
  const isOwner = role === 'owner';

  if (isOwner) {
    const admins = await pool.query(`
      SELECT user_id FROM conversation_participants
      WHERE conversation_id = $1 AND role = 'admin' AND user_id != $2
    `, [groupId, req.userId]);

    let newOwnerId;

    if (admins.rows.length > 0) {
      newOwnerId = admins.rows[Math.floor(Math.random() * admins.rows.length)].user_id;
    } else {
      const members = await pool.query(`
        SELECT user_id FROM conversation_participants
        WHERE conversation_id = $1 AND user_id != $2
      `, [groupId, req.userId]);

      if (members.rows.length > 0) {
        newOwnerId = members.rows[Math.floor(Math.random() * members.rows.length)].user_id;
      }
    }

    if (newOwnerId) {
      await pool.query(`
        UPDATE conversation_participants
        SET role = 'owner'
        WHERE conversation_id = $1 AND user_id = $2
      `, [groupId, newOwnerId]);

      const participants = await pool.query(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
        [groupId]
      );
      for (const row of participants.rows) {
        broadcastToUser(row.user_id, {
          type: 'owner_changed',
          conversationId: groupId,
          newOwnerId: newOwnerId
        });
      }
    }
  }

  await pool.query(
    'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );

  const left = await pool.query(
    'SELECT COUNT(*)::int AS c FROM conversation_participants WHERE conversation_id = $1',
    [groupId]
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
  if (part.rows.length === 0) return res.status(404).json({ error: 'Чат не найден' });

  const r = await pool.query(`
    SELECT 
      m.id, 
      m.body, 
      m.created_at, 
      m.sender_id,
      u.username AS sender_username,
      u.display_name AS sender_display_name,
      m.reply_to_id,
      r.body AS reply_body,
      ru.username AS reply_sender_username,
      ru.display_name AS reply_sender_display_name,
      (SELECT json_agg(json_build_object('emoji', r2.emoji, 'count', r2.cnt, 'me', r2.me))
       FROM (SELECT emoji, COUNT(*) as cnt, bool_or(user_id = $2) as me
             FROM reactions WHERE message_id = m.id GROUP BY emoji) r2) AS reactions
    FROM messages m
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1
    ORDER BY m.created_at ASC
  `, [convId, req.userId]);

  // Преобразуем результат, добавляя поле reply_to
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
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );
  if (part.rows.length === 0) return res.status(404).json({ error: 'Чат не найден' });

  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Вы не участвуете в этом чате' });

  const convInfo = await pool.query(
    'SELECT is_group, is_channel FROM conversations WHERE id = $1',
    [convId]
  );
  if (convInfo.rows.length === 0) return res.status(404).json({ error: 'Чат не найден' });
  const { is_group: isGroup, is_channel: isChannel } = convInfo.rows[0];

  if (isChannel) {
    const roleCheck = await pool.query(
      'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [convId, req.userId]
    );
    const role = roleCheck.rows[0]?.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Только администраторы могут писать в каналах' });
    }
  }

  const muteCheck = await pool.query(
    'SELECT muted_until FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (muteCheck.rows[0]?.muted_until && new Date(muteCheck.rows[0].muted_until) > new Date()) {
    return res.status(403).json({ error: 'Вы заглушены' });
  }

  // Проверка replyToId
  let replyToIdNum = replyToId ? parseInt(replyToId, 10) : null;
  if (replyToIdNum) {
    const orig = await pool.query('SELECT id, conversation_id FROM messages WHERE id = $1', [replyToIdNum]);
    if (orig.rows.length === 0) {
      return res.status(400).json({ error: 'Message to reply не существует' });
    }
    if (orig.rows[0].conversation_id !== convId) {
      return res.status(400).json({ error: 'Message to reply is Вы не участвуете в этом чате' });
    }
  }

  const ins = await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, body, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, body, created_at, sender_id',
    [convId, req.userId, messageBody, replyToIdNum]
  );
  const msg = ins.rows[0];

  // Получаем полные данные сообщения вместе с reply_to
  const fullMsg = await pool.query(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.username AS sender_username,
           u.display_name AS sender_display_name,
           m.reply_to_id, r.body AS reply_body,
           ru.username AS reply_sender_username, ru.display_name AS reply_sender_display_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id
    WHERE m.id = $1
  `, [msg.id]);

  const messageWithReply = fullMsg.rows[0];
  const resultMsg = {
    id: messageWithReply.id,
    body: messageWithReply.body,
    created_at: messageWithReply.created_at,
    sender_id: messageWithReply.sender_id,
    sender_username: messageWithReply.sender_username,
    sender_display_name: messageWithReply.sender_display_name,
  };
  if (messageWithReply.reply_to_id) {
    resultMsg.reply_to = {
      id: messageWithReply.reply_to_id,
      body: messageWithReply.reply_body,
      senderName: messageWithReply.reply_sender_display_name || messageWithReply.reply_sender_username || 'Unknown'
    };
  }

  // Отправляем уведомления
  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);
  const payload = {
    type: 'new_message',
    conversationId: convId,
    message: resultMsg,
  };

  for (const uid of otherUserIds) {
    await pool.query(
      'INSERT INTO notifications (user_id, conversation_id, message_id) VALUES ($1, $2, $3)',
      [uid, convId, msg.id]
    );
    broadcastToUser(uid, payload);
  }

  const pushPayload = {
    title: `Новое сообщение от ${resultMsg.sender_username}`,
    body: messageBody.length > 100 ? messageBody.slice(0, 97) + '...' : messageBody,
    icon: '/images/logo.png',
    data: { conversationId: convId, messageId: msg.id },
  };
  sendPushNotifications(otherUserIds, pushPayload).catch(console.error);

  res.status(201).json(resultMsg);
});

// Legacy DM endpoints (совместимость)
app.get('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Неверный ID чата' });

  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Чат не найден' });

  const r = await pool.query(`
    SELECT 
      m.id, 
      m.body, 
      m.created_at, 
      m.sender_id,
      u.username AS sender_username
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1
    ORDER BY m.created_at ASC
  `, [convId]);

  res.json(r.rows);
});

app.post('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Неверный ID чата' });

  const { body } = req.body || {};
  const messageBody = String(body || '').trim();
  if (!messageBody) return res.status(400).json({ error: 'Текст сообщения обязателен' });
  if (messageBody.length > 5000) return res.status(400).json({ error: 'Сообщение слишком длинное (максимум 5000 символов)' });

  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Чат не найден' });

  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Вы не участвуете в этом чате' });

  const muteCheck = await pool.query(`
    SELECT muted_until FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [convId, req.userId]);

  if (muteCheck.rows[0]?.muted_until &&
      new Date(muteCheck.rows[0].muted_until) > new Date()) {
    return res.status(403).json({ error: 'Вы заглушены' });
  }

  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);

  const ins = await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, sender_id',
    [convId, req.userId, messageBody]
  );

  const msg = ins.rows[0];
  const sender = await pool.query('SELECT username FROM users WHERE id = $1', [req.userId]);

  const payload = {
    type: 'new_message',
    conversationId: convId,
    message: {
      id: msg.id,
      body: msg.body,
      created_at: msg.created_at,
      sender_id: msg.sender_id,
      sender_username: sender.rows[0]?.username || '',
    },
  };

  for (const uid of otherUserIds) {
    await pool.query(
      'INSERT INTO notifications (user_id, conversation_id, message_id) VALUES ($1, $2, $3)',
      [uid, convId, msg.id]
    );

    broadcastToUser(uid, payload);
  }

  res.status(201).json(payload.message);
});

// ---- DELETE MESSAGE ----
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  if (isNaN(messageId) || messageId <= 0) return res.status(400).json({ error: 'Invalid message ID' });

  const r = await pool.query(
    'SELECT id, sender_id, conversation_id, body FROM messages WHERE id = $1',
    [messageId]
  );

  if (r.rows.length === 0) {
    return res.status(404).json({ error: 'Сообщение не найдено' });
  }

  const message = r.rows[0];

  // Проверка прав
  if (message.sender_id !== req.userId) {
    const roleCheck = await pool.query(`
      SELECT role FROM conversation_participants
      WHERE conversation_id = $1 AND user_id = $2
    `, [message.conversation_id, req.userId]);

    if (roleCheck.rows.length === 0 ||
        (roleCheck.rows[0].role !== 'owner' && roleCheck.rows[0].role !== 'admin')) {
      return res.status(403).json({ error: 'Нет прав для удаления этого сообщения' });
    }
  }

  // Удаляем файл, если сообщение содержит ссылку на загруженный файл (с защитой path traversal)
  if (message.body && message.body.includes('/uploads/')) {
    const matches = message.body.match(/\/uploads\/([^"'\s]+)/g);
    if (matches) {
      for (const match of matches) {
        const filename = path.basename(match);
        const filePath = path.join(__dirname, 'uploads', filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }
  }

  await pool.query('DELETE FROM notifications WHERE message_id = $1', [messageId]);
  await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);

  const participants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [message.conversation_id]
  );

  const deletePayload = {
    type: 'message_deleted',
    conversationId: message.conversation_id,
    messageId: message.id
  };

  for (const row of participants.rows) {
    broadcastToUser(row.user_id, deletePayload);
  }

  res.json({ success: true });
});

// ---- REACTIONS ----
app.post('/api/messages/:id/reactions', authMiddleware, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const { emoji } = req.body;

  if (isNaN(messageId) || messageId <= 0 || !emoji) {
    return res.status(400).json({ error: 'Неверный ID сообщения или эмодзи' });
  }

  // Проверяем, имеет ли пользователь доступ к сообщению
  const msg = await pool.query(
    'SELECT conversation_id FROM messages WHERE id = $1',
    [messageId]
  );
  if (msg.rows.length === 0) {
    return res.status(404).json({ error: 'Сообщение не найдено' });
  }
  const convId = msg.rows[0].conversation_id;

  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (part.rows.length === 0) {
    return res.status(403).json({ error: 'Вы не участвуете в этом чате' });
  }

  // Переключаем реакцию
  const existing = await pool.query(
    'SELECT id FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, req.userId, emoji]
  );

  let action;
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM reactions WHERE id = $1', [existing.rows[0].id]);
    action = 'remove';
  } else {
    await pool.query(
      'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
      [messageId, req.userId, emoji]
    );
    action = 'add';
  }

  // Рассылаем событие всем участникам беседы
  const participants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );
  const payload = {
    type: 'reaction',
    messageId,
    userId: req.userId,
    emoji,
    action
  };
  for (const row of participants.rows) {
    broadcastToUser(row.user_id, payload);
  }

  res.json({ success: true, action });
});

// ---- Notifications ----
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
  const r = await pool.query(
    'SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1',
    [req.userId]
  );
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

// SSE для уведомлений с лимитом соединений
app.get('/api/notifications/stream', streamAuthMiddleware, sseConnectionLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.userId;

  // Проверяем лимит
  if (sseClients.has(userId) && sseClients.get(userId).length >= MAX_SSE_PER_USER) {
    res.status(429).end('Слишком много SSE-соединений');
    return;
  }

  const wasOnline = sseClients.has(userId) && sseClients.get(userId).length > 0;

  if (!sseClients.has(userId)) sseClients.set(userId, []);
  sseClients.get(userId).push(res);

  // Если пользователь только что появился в сети
  if (!wasOnline) {
    broadcastStatusChange(userId, true).catch(console.error);
  }

  res.on('close', async () => {
    const list = sseClients.get(userId);
    if (list) {
      const wasOnlineBefore = list.length > 0;
      const i = list.indexOf(res);
      if (i !== -1) {
        list.splice(i, 1);
      }
      const isOnlineNow = list.length > 0;
      if (!isOnlineNow) {
        sseClients.delete(userId);
        // Обновляем last_seen в БД
        await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
        // Если был онлайн, а теперь нет – стал офлайн
        if (wasOnlineBefore) {
          await broadcastStatusChange(userId, false);
        }
      }
    }
    res.end();
  });
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  const { conversationId } = req.body || {};

  if (conversationId != null) {
    const notifResult = await pool.query(
      'SELECT message_id FROM notifications WHERE user_id = $1 AND conversation_id = $2',
      [req.userId, conversationId]
    );
    const messageIds = notifResult.rows.map(r => r.message_id);
    if (messageIds.length > 0) {
      await pool.query(
        'DELETE FROM notifications WHERE user_id = $1 AND conversation_id = $2',
        [req.userId, conversationId]
      );

      // Находим отправителей этих сообщений
      const senderRes = await pool.query(
        'SELECT DISTINCT sender_id FROM messages WHERE id = ANY($1::int[])',
        [messageIds]
      );
      const senderIds = senderRes.rows.map(r => r.sender_id);

      // Для каждого отправителя (кроме себя) отправляем событие messages_read
      for (const senderId of senderIds) {
        if (senderId === req.userId) continue;
        broadcastToUser(senderId, {
          type: 'messages_read',
          conversationId: Number(conversationId),
          messageIds: messageIds,
          readerId: req.userId
        });
      }
    }
  }
 res.json({ ok: true });
});

// ---- CALL SIGNALING ----
const signalingChannels = new Map(); // userId -> Set of response streams
const MAX_SIGNALING_PER_USER = 5;

app.get('/api/signaling', streamAuthMiddleware, sseConnectionLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = req.userId;

  if (signalingChannels.has(userId) && signalingChannels.get(userId).size >= MAX_SIGNALING_PER_USER) {
    res.status(429).end('Слишком много сигнальных соединений');
    return;
  }

  if (!signalingChannels.has(userId)) signalingChannels.set(userId, new Set());
  signalingChannels.get(userId).add(res);

  res.on('close', () => {
    const set = signalingChannels.get(userId);
    if (set) {
      set.delete(res);
      res.end();
      if (set.size === 0) signalingChannels.delete(userId);
    }
  });
});

app.post('/api/signaling', authMiddleware, async (req, res) => {
  const { type, targetUserId, offer, answer, candidate } = req.body || {};

  if (!type || !targetUserId) {
    return res.status(400).json({ error: 'Требуется тип и целевой пользователь' });
  }

  // Валидация в зависимости от типа
  if (type === 'offer' && !offer) {
    return res.status(400).json({ error: 'Требуется предложение' });
  }
  if (type === 'answer' && !answer) {
    return res.status(400).json({ error: 'Требуется ответ' });
  }
  if (type === 'ice-candidate' && !candidate) {
    return res.status(400).json({ error: 'Требуется кандидат' });
  }

  const targetId = parseInt(targetUserId, 10);
  if (isNaN(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Неверный ID целевого пользователя' });
  }

  // Проверяем, что целевой пользователь существует
  const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
  if (userExists.rows.length === 0) {
    return res.status(404).json({ error: 'Target user не существует' });
  }

  const areFriends = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, targetId]
  );

  if (areFriends.rows.length === 0) {
    const commonConversation = await pool.query(`
      SELECT 1 FROM conversation_participants cp1
      JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
      WHERE cp1.user_id = $1 AND cp2.user_id = $2
      LIMIT 1
    `, [req.userId, targetId]);

    if (commonConversation.rows.length === 0) {
      return res.status(403).json({ error: 'Вы не друзья и у вас нет общего чата' });
    }
  }

  const payload = {
    type,
    fromUserId: req.userId,
    [type === 'ice-candidate' ? 'candidate' : type]: type === 'ice-candidate' ? candidate : (type === 'offer' ? offer : answer)
  };

  const channels = signalingChannels.get(targetId);
  if (channels) {
    const eventName = type === 'ice-candidate' ? 'ice-candidate' : type;
    // Безопасная итерация с удалением сбойных
    for (const client of Array.from(channels)) {
      try {
        client.write(`event: ${eventName}\n`);
        client.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (e) {
        channels.delete(client);
        client.end();
      }
    }
    if (channels.size === 0) signalingChannels.delete(targetId);
  }

  res.json({ ok: true });
});

// ---- GROUP MEMBERS ----
app.get('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) {
    return res.status(400).json({ error: 'Неверный ID группы' });
  }

  // 1. Проверяем существование группы и что это действительно группа
  const groupCheck = await pool.query(
    'SELECT is_group FROM conversations WHERE id = $1',
    [groupId]
  );
  if (groupCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Группа не найдена' });
  }
  if (!groupCheck.rows[0].is_group) {
    return res.status(400).json({ error: 'Это не группа' });
  }

  // 2. Проверяем, является ли пользователь участником
  const memberCheck = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (memberCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Вы не участник этой группы' });
  }

  // 3. Возвращаем список участников
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
  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);

  // Валидация параметров
  if (isNaN(groupId) || groupId <= 0) {
    return res.status(400).json({ error: 'Неверный ID группы' });
  }
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Требуется корректный ID пользователя' });
  }

  // Получаем информацию о группе и проверяем, что это группа/канал
  const convRes = await pool.query(
    'SELECT id, title, is_group FROM conversations WHERE id = $1',
    [groupId]
  );
  if (convRes.rows.length === 0) {
    return res.status(404).json({ error: 'Чат не найден' });
  }
  const conversation = convRes.rows[0];
  if (!conversation.is_group) {
    return res.status(400).json({ error: 'Это не группа or channel' });
  }

  // Проверяем права текущего пользователя
  const roleRes = await pool.query(
    'SELECT role FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );
  if (roleRes.rows.length === 0) {
    return res.status(403).json({ error: 'You are Вы не участник этой группы' });
  }
  const userRole = roleRes.rows[0].role;
  if (userRole !== 'owner' && userRole !== 'admin') {
    return res.status(403).json({ error: 'Только владельцы и администраторы могут добавлять участников' });
  }

  // Проверяем существование добавляемого пользователя
  const userRes = await pool.query(
    'SELECT id, username FROM users WHERE id = $1',
    [targetUserId]
  );
  if (userRes.rows.length === 0) {
    return res.status(404).json({ error: 'User Не найдено' });
  }
  const targetUser = userRes.rows[0];

  // Проверяем, не состоит ли уже пользователь в группе
  const existing = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, targetUserId]
  );
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Пользователь уже в группе' });
  }

  // (Опционально) Проверяем, что добавляемый пользователь является другом текущего
  const friendCheck = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, targetUserId]
  );
  if (friendCheck.rows.length === 0) {
    return res.status(403).json({ error: 'Вы можете добавлять только друзей' });
  }

  // Добавляем участника
  await pool.query(
    'INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES ($1, $2, $3)',
    [groupId, targetUserId, 'member']
  );

  // Получаем список всех участников для уведомлений
  const participantsRes = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [groupId]
  );
  const participantIds = participantsRes.rows.map(row => row.user_id);

  // Уведомляем нового участника
  broadcastToUser(targetUserId, {
    type: 'added_to_group',
    conversationId: groupId,
    groupTitle: conversation.title
  });

  // Уведомляем остальных участников о новом члене
  const memberAddedPayload = {
    type: 'member_added',
    conversationId: groupId,
    userId: targetUserId,
    user: {
      id: targetUser.id,
      username: targetUser.username,
      role: 'member'
    }
  };
  for (const uid of participantIds) {
    if (uid !== targetUserId) {
      broadcastToUser(uid, memberAddedPayload);
    }
  }

  res.json({ success: true });
});

// ---- FILE UPLOAD ----
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  // Сначала проверяем, есть ли файл
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  const originalName = req.file.originalname;
  const fixedName = /[Ð-ÿ]/.test(originalName)
    ? Buffer.from(originalName, 'latin1').toString('utf8')
    : originalName;

  console.log('Original filename:', originalName, 'Fixed:', fixedName);

  res.json({
    url: '/uploads/' + encodeURIComponent(req.file.filename),
    name: fixedName,
    type: req.file.mimetype
  });
}, (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Файл слишком большой. Максимум 1 ГБ.' });
    }
    // Другие возможные ошибки Multer
    console.error('Multer error:', error);
    return res.status(400).json({ error: 'File upload failed: ' + error.message });
  }
  // Другие ошибки
  console.error('Upload error:', error);
  res.status(400).json({ error: 'Не удалось загрузить файл.' });
});

// ---- Group moderation endpoints ----

// Повысить до админа (только owner)
app.post('/api/groups/:id/promote', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Требуется корректный ID пользователя' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0 || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец группы может назначать администраторов' });
  }

  await pool.query(`
    UPDATE conversation_participants
    SET role = 'admin'
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  res.json({ success: true });
});

// Замутить (только админы, но админы не могут мутить других админов, только owner)
app.post('/api/groups/:id/mute', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const { userId, minutes } = req.body;
  const targetUserId = parseInt(userId, 10);
  const muteMinutes = parseInt(minutes, 10);
  if (isNaN(targetUserId) || targetUserId <= 0 || isNaN(muteMinutes) || muteMinutes < 1) {
    return res.status(400).json({ error: 'Valid user ID and minutes (>=1) required' });
  }

  const MAX_MUTE_MINUTES = 525600; // 1 год
  if (muteMinutes > MAX_MUTE_MINUTES) {
    return res.status(400).json({ error: `Длительность мута не может превышать ${MAX_MUTE_MINUTES} минут` });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0) {
    return res.status(404).json({ error: 'Not a member' });
  }

  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Только администраторы могут заглушать участников' });
  }

  const target = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  if (target.rows.length === 0) {
    return res.status(404).json({ error: 'User not in group' });
  }

  // Админ не может мутить другого админа (только owner)
  if (target.rows[0].role === 'admin' && requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец может заглушать администраторов' });
  }

  if (target.rows[0].role === 'owner') {
    return res.status(403).json({ error: 'Нельзя заглушить владельца группы' });
  }

  await pool.query(`
    UPDATE conversation_participants
    SET muted_until = NOW() + ($1 * interval '1 minute')
    WHERE conversation_id = $2 AND user_id = $3
  `, [muteMinutes, groupId, targetUserId]);

  res.json({ success: true });
});

// Снять статус админа (только owner)
app.post('/api/groups/:id/demote', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Требуется корректный ID пользователя' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0 || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец группы может снимать администраторов' });
  }

  await pool.query(`
    UPDATE conversation_participants
    SET role = 'member'
    WHERE conversation_id = $1 AND user_id = $2 AND role = 'admin'
  `, [groupId, targetUserId]);

  res.json({ success: true });
});

// Размутить (owner или admin)
app.post('/api/groups/:id/unmute', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Неверный ID группы' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Требуется корректный ID пользователя' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0) {
    return res.status(404).json({ error: 'Not a member' });
  }

  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Только администраторы могут разглушать участников' });
  }

  await pool.query(`
    UPDATE conversation_participants
    SET muted_until = NULL
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  res.json({ success: true });
});

// Кикнуть участника (owner или admin)
app.delete('/api/groups/:id/kick/:userId', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const targetUserId = parseInt(req.params.userId, 10);
  if (isNaN(groupId) || groupId <= 0 || isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Invalid group or user ID' });
  }

  // Запрет на самокик
  if (targetUserId === req.userId) {
    return res.status(400).json({ error: 'Нельзя кикнуть самого себя, используйте /leave' });
  }

  const allParticipants = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [groupId]
  );
  const allUserIds = allParticipants.rows.map(row => row.user_id);

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0) {
    return res.status(404).json({ error: 'Not a member' });
  }

  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Только администраторы могут кикать участников' });
  }

  const target = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  if (target.rows.length === 0) {
    return res.status(404).json({ error: 'User not in group' });
  }

  if (target.rows[0].role === 'owner') {
    return res.status(403).json({ error: 'Нельзя кикнуть владельца группы' });
  }

  // Админ не может кикнуть другого админа (только owner)
  if (target.rows[0].role === 'admin' && requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец может кикать администраторов' });
  }

  await pool.query(`
    DELETE FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  const remaining = await pool.query(
    'SELECT COUNT(*)::int AS c FROM conversation_participants WHERE conversation_id = $1',
    [groupId]
  );

  if (remaining.rows[0].c === 0) {
    const groupDeletedPayload = {
      type: 'group_deleted',
      conversationId: groupId
    };
    for (const uid of allUserIds) {
      broadcastToUser(uid, groupDeletedPayload);
    }
  } else {
    broadcastToUser(targetUserId, {
      type: 'kicked_from_group',
      conversationId: groupId
    });

    const memberRemovedPayload = {
      type: 'member_removed',
      conversationId: groupId,
      userId: targetUserId
    };
    for (const uid of allUserIds) {
      if (uid === targetUserId) continue;
      broadcastToUser(uid, memberRemovedPayload);
    }
  }

  res.json({ success: true });
});

// Раздача файлов
app.use('/uploads', express.static('uploads'));

// ===== Централизованный обработчик ошибок (должен быть после всех маршрутов, но перед catch-all) =====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Catch-all для клиентского приложения
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Не найдено' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  try {
    await initDb();
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()
    `);
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
    `);
    console.log('Database ready');

    // Миграция для добавления полей user1_id и user2_id в таблицу conversations (для DM)
    // Выполняем после инициализации БД, чтобы гарантировать наличие таблиц
    const client = await pool.connect();
    try {
      // Добавляем колонки, если их нет
      await client.query(`
        ALTER TABLE conversations 
        ADD COLUMN IF NOT EXISTS user1_id INTEGER REFERENCES users(id),
        ADD COLUMN IF NOT EXISTS user2_id INTEGER REFERENCES users(id)
      `);
      // Создаём уникальный индекс для DM (только для is_group = false)
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_dm 
        ON conversations (user1_id, user2_id) 
        WHERE is_group = false
      `);
      console.log('DM unique index created/verified');
    } catch (err) {
      console.error('Failed to apply DM migration:', err);
      // Не выходим, так как приложение может работать и без этого (но DM будут не защищены)
    } finally {
      client.release();
    }
    const client2 = await pool.connect();
    try {
      await client2.query(`
        ALTER TABLE conversations 
        ADD COLUMN IF NOT EXISTS is_channel BOOLEAN DEFAULT false
      `);
      console.log('Column is_channel added/verified');
    } catch (err) {
      console.error('Failed to add is_channel column:', err);
    } finally {
      client2.release();
    }
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main();