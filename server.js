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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/ogg',
      'audio/mpeg', 'audio/ogg', 'audio/wav',
      'application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images, documents, videos and audio are allowed.'));
    }
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
  message: { error: 'Too many SSE connections, please try again later.' },
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
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
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

// ---- Auth ----
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || trimmedUsername.length < 2 || trimmedUsername.length > 50) {
    return res.status(400).json({ error: 'Username must be 2-50 characters' });
  }
  if (!password || password.length < 6 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 6-72 characters' });
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
        return res.status(400).json({ error: 'Username taken' });
      }
      throw e; // будет перехвачено express-async-errors
    }
  }
  return res.status(500).json({ error: 'Could not generate unique friend code' });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const trimmedUsername = username?.trim();
  if (!trimmedUsername || !password) return res.status(400).json({ error: 'Username and password required' });

  const r = await pool.query('SELECT id, username, password_hash, friend_code FROM users WHERE username = $1', [trimmedUsername]);
  const user = r.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
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
  if (!user) return res.status(404).json({ error: 'Not found' });

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

// ---- Delete account ----
app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];

  if (!user) return res.status(404).json({ error: 'Not found' });

  if (!password || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Password required to delete account' });
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
    res.status(500).json({ error: 'Failed to delete account' });
  } finally {
    client.release();
  }
});

// ---- Friends ----
app.get('/api/friends', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.friend_code,
           COALESCE(u.display_name, u.username) AS name
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = $1
    ORDER BY u.username
  `, [req.userId]);
  res.json(r.rows);
});

app.post('/api/friends', authMiddleware, async (req, res) => {
  const { friendCode } = req.body || {};
  const code = String(friendCode || '').trim().toUpperCase();

  if (!code) return res.status(400).json({ error: 'Friend code required' });

  const other = await pool.query('SELECT id, username FROM users WHERE UPPER(friend_code) = $1', [code]);
  const friend = other.rows[0];

  if (!friend) return res.status(404).json({ error: 'No user with this friend code' });
  if (friend.id === req.userId) return res.status(400).json({ error: 'Cannot add yourself' });

  try {
    await pool.query(
      'INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT (user_id, friend_id) DO NOTHING',
      [req.userId, friend.id]
    );
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Invalid user' });
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
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'display_name', u.display_name,
            'name', COALESCE(u.display_name, u.username)
          )
        ) FILTER (WHERE u.id != $1),
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
    const otherUsers = participants.filter(p => p.id !== req.userId);
    const lastMessage = row.last_message;

    return {
      id: row.id,
      isGroup: row.is_group || false,
      title: row.title,
      participants: participants,
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
    return res.status(400).json({ error: 'Valid other user required' });
  }

  const otherId = parseInt(otherUserId, 10);
  if (isNaN(otherId) || otherId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, otherId]
  );

  if (isFriend.rows.length === 0) {
    return res.status(403).json({ error: 'Add this user as a friend first' });
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
      return res.status(500).json({ error: 'Concurrent creation, please retry' });
    }
    throw e;
  } finally {
    client.release();
  }
});

// ---- Groups ----
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};

  if (!title || !Array.isArray(userIds) || userIds.length < 1) {
    return res.status(400).json({ error: 'Title and at least 1 other user required' });
  }

  const otherUserIds = userIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && id !== req.userId);
  if (otherUserIds.length === 0) {
    return res.status(400).json({ error: 'At least one valid other user ID required' });
  }

  for (const uid of otherUserIds) {
    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (userExists.rows.length === 0) {
      return res.status(404).json({ error: `User with ID ${uid} does not exist` });
    }

    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    if (isFriend.rows.length === 0) {
      return res.status(403).json({ error: `User ${uid} is not your friend` });
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
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const group = await pool.query(`
    SELECT c.id, c.title, c.created_at, 
           json_agg(json_build_object(
              'id', u.id, 
              'username', u.username,
              'display_name', u.display_name,
              'name', COALESCE(u.display_name, u.username),
              'role', cp.role, 
              'muted_until', cp.muted_until
            )) as participants
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id
    WHERE c.id = $1 AND c.is_group = true
    GROUP BY c.id
  `, [groupId]);

  if (group.rows.length === 0) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const isMember = group.rows[0].participants.some(p => p.id === req.userId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  res.json(group.rows[0]);
});

app.post('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const { userId } = req.body || {};
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Valid user ID required' });
  }

  const check = await pool.query(`
    SELECT c.is_group, cp.role
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);

  if (check.rows.length === 0 || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Group not found or not a member' });
  }

  if (check.rows[0].role !== 'owner' && check.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can add members' });
  }

  const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [targetUserId]);
  if (userExists.rows.length === 0) {
    return res.status(404).json({ error: 'User does not exist' });
  }

  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, targetUserId]
  );

  if (isFriend.rows.length === 0) {
    return res.status(403).json({ error: 'You can only add friends to groups' });
  }

  try {
    await pool.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)',
      [groupId, targetUserId]
    );

    // Уведомляем добавляемого
    broadcastToUser(targetUserId, {
      type: 'added_to_group',
      conversationId: groupId
    });

    // Уведомляем остальных участников
    const participants = await pool.query(
      'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
      [groupId, targetUserId]
    );
    for (const row of participants.rows) {
      broadcastToUser(row.user_id, {
        type: 'member_added',
        conversationId: groupId,
        userId: targetUserId
      });
    }

    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(400).json({ error: 'User already in group' });
    }
    throw e;
  }
});

// ---- LEAVE GROUP ----
app.post('/api/groups/:id/leave', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const check = await pool.query(`
    SELECT c.is_group, cp.role
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);

  if (check.rows.length === 0 || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Group not found or not a member' });
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
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

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

app.post('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  const { body } = req.body || {};
  const messageBody = String(body || '').trim();
  if (!messageBody) return res.status(400).json({ error: 'Message body required' });
  if (messageBody.length > 5000) return res.status(400).json({ error: 'Message too long (max 5000 characters)' });

  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not in this conversation' });

  const muteCheck = await pool.query(`
    SELECT muted_until FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [convId, req.userId]);

  if (muteCheck.rows[0]?.muted_until &&
      new Date(muteCheck.rows[0].muted_until) > new Date()) {
    return res.status(403).json({ error: 'You are muted' });
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

// Legacy DM endpoints (совместимость)
app.get('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

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
  if (isNaN(convId) || convId <= 0) return res.status(400).json({ error: 'Invalid conversation ID' });

  const { body } = req.body || {};
  const messageBody = String(body || '').trim();
  if (!messageBody) return res.status(400).json({ error: 'Message body required' });
  if (messageBody.length > 5000) return res.status(400).json({ error: 'Message too long (max 5000 characters)' });

  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );

  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not in this conversation' });

  const muteCheck = await pool.query(`
    SELECT muted_until FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [convId, req.userId]);

  if (muteCheck.rows[0]?.muted_until &&
      new Date(muteCheck.rows[0].muted_until) > new Date()) {
    return res.status(403).json({ error: 'You are muted' });
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
    return res.status(404).json({ error: 'Message not found' });
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
      return res.status(403).json({ error: 'No permission to delete this message' });
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

  // Проверяем лимит одновременных соединений для пользователя
  if (sseClients.has(userId) && sseClients.get(userId).length >= MAX_SSE_PER_USER) {
    res.status(429).end('Too many SSE connections');
    return;
  }

  if (!sseClients.has(userId)) sseClients.set(userId, []);
  sseClients.get(userId).push(res);

  res.on('close', () => {
    const list = sseClients.get(userId);
    if (list) {
      const i = list.indexOf(res);
      if (i !== -1) {
        list.splice(i, 1);
        // Закрываем ответ, если он ещё не закрыт
        res.end();
      }
      if (list.length === 0) sseClients.delete(userId);
    }
  });
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  const { conversationId } = req.body || {};

  if (conversationId != null) {
    await pool.query(
      'DELETE FROM notifications WHERE user_id = $1 AND conversation_id = $2',
      [req.userId, conversationId]
    );
  } else {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [req.userId]);
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
    res.status(429).end('Too many signaling connections');
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
    return res.status(400).json({ error: 'Type and targetUserId required' });
  }

  // Валидация в зависимости от типа
  if (type === 'offer' && !offer) {
    return res.status(400).json({ error: 'Offer required' });
  }
  if (type === 'answer' && !answer) {
    return res.status(400).json({ error: 'Answer required' });
  }
  if (type === 'ice-candidate' && !candidate) {
    return res.status(400).json({ error: 'Candidate required' });
  }

  const targetId = parseInt(targetUserId, 10);
  if (isNaN(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid target user ID' });
  }

  // Проверяем, что целевой пользователь существует
  const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
  if (userExists.rows.length === 0) {
    return res.status(404).json({ error: 'Target user does not exist' });
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
      return res.status(403).json({ error: 'You are not friends and have no common conversation' });
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
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const r = await pool.query(`
    SELECT u.id, u.username, u.display_name, cp.role
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = $1
  `, [groupId]);

  res.json(r.rows);
});

// ---- FILE UPLOAD ----
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    url: '/uploads/' + encodeURIComponent(req.file.filename),
    name: req.file.originalname,
    type: req.file.mimetype
  });
}, (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 10MB.' });
    }
  }
  // Не раскрываем детали ошибки
  res.status(400).json({ error: 'File upload failed.' });
});

// ---- Group moderation endpoints ----

// Повысить до админа (только owner)
app.post('/api/groups/:id/promote', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Valid user ID required' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0 || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Only the group owner can promote admins' });
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
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const { userId, minutes } = req.body;
  const targetUserId = parseInt(userId, 10);
  const muteMinutes = parseInt(minutes, 10);
  if (isNaN(targetUserId) || targetUserId <= 0 || isNaN(muteMinutes) || muteMinutes < 1) {
    return res.status(400).json({ error: 'Valid user ID and minutes (>=1) required' });
  }

  const MAX_MUTE_MINUTES = 525600; // 1 год
  if (muteMinutes > MAX_MUTE_MINUTES) {
    return res.status(400).json({ error: `Mute duration cannot exceed ${MAX_MUTE_MINUTES} minutes` });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0) {
    return res.status(404).json({ error: 'Not a member' });
  }

  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can mute members' });
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
    return res.status(403).json({ error: 'Only owner can mute admins' });
  }

  if (target.rows[0].role === 'owner') {
    return res.status(403).json({ error: 'Cannot mute the group owner' });
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
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Valid user ID required' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0 || requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Only the group owner can demote admins' });
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
  if (isNaN(groupId) || groupId <= 0) return res.status(400).json({ error: 'Invalid group ID' });

  const { userId } = req.body;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Valid user ID required' });
  }

  const requester = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, req.userId]);

  if (requester.rows.length === 0) {
    return res.status(404).json({ error: 'Not a member' });
  }

  if (requester.rows[0].role !== 'owner' && requester.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can unmute members' });
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
    return res.status(400).json({ error: 'Cannot kick yourself, use /leave instead' });
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
    return res.status(403).json({ error: 'Only admins can kick members' });
  }

  const target = await pool.query(`
    SELECT role FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `, [groupId, targetUserId]);

  if (target.rows.length === 0) {
    return res.status(404).json({ error: 'User not in group' });
  }

  if (target.rows[0].role === 'owner') {
    return res.status(403).json({ error: 'Cannot kick the group owner' });
  }

  // Админ не может кикнуть другого админа (только owner)
  if (target.rows[0].role === 'admin' && requester.rows[0].role !== 'owner') {
    return res.status(403).json({ error: 'Only owner can kick admins' });
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
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  try {
    await initDb();
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
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main();