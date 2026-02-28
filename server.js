require('dotenv').config();
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

// Создаем папку uploads, если её нет
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    // Генерируем уникальное имя файла: время-оригинальноеИмя
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

function generateFriendCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return crypto.randomBytes(8).reduce((s, b) => s + chars[b % chars.length], '');
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

const sseClients = new Map();

function authMiddleware(req, res, next) {
  const token = req.cookies.token || 
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && 
                 req.headers.authorization.slice(7));
  
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

function streamAuthMiddleware(req, res, next) {
  const token = req.query.token || req.cookies.token ||
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && 
                 req.headers.authorization.slice(7));
  
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
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2) {
    return res.status(400).json({ error: 'Username (min 2 chars) and password required' });
  }
  
  const hash = await bcrypt.hash(password, 10);
  let friendCode = generateFriendCode();
  
  for (let tries = 0; tries < 10; tries++) {
    try {
      const r = await pool.query(
        'INSERT INTO users (username, password_hash, friend_code) VALUES ($1, $2, $3) RETURNING id, username, friend_code',
        [username.trim(), hash, friendCode]
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
          continue; 
        }
        return res.status(400).json({ error: 'Username taken' });
      }
      throw e;
    }
  }
  return res.status(500).json({ error: 'Could not generate friend code' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  
  const r = await pool.query('SELECT id, username, password_hash, friend_code FROM users WHERE username = $1', [username.trim()]);
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
  const r = await pool.query('SELECT id, username, friend_code FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'Not found' });
  
  if (!user.friend_code) {
    user.friend_code = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [user.friend_code, user.id]);
  }
  
  res.json({ 
    id: user.id, 
    username: user.username, 
    friend_code: user.friend_code 
  });
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
  
  await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ ok: true });
});

// ---- Friends ----
app.get('/api/friends', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.friend_code
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

// ---- Conversations (DMs & Groups) ----
// FIXED: Returns one row per conversation with proper user data
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
            'username', u.username
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
      // For backward compatibility
      otherUser: !row.is_group && otherUsers.length > 0 ? otherUsers[0] : null,
      lastMessage: lastMessage ? lastMessage.body : null,
      lastMessageData: lastMessage,
      lastAt: row.last_at,
      createdAt: row.created_at
    };
  });

  res.json(convos);
});

// Legacy endpoint
app.get('/api/dms', authMiddleware, async (req, res) => {
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
            'username', u.username
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
      otherUser: !row.is_group && otherUsers.length > 0 ? otherUsers[0] : null,
      otherUsers: otherUsers,
      lastMessage: lastMessage ? lastMessage.body : null,
      lastMessageData: lastMessage,
      lastAt: row.last_at,
      createdAt: row.created_at
    };
  });

  res.json(convos);
});

// Create DM
app.post('/api/dms', authMiddleware, async (req, res) => {
  const { otherUserId } = req.body || {};
  if (!otherUserId || otherUserId === req.userId) {
    return res.status(400).json({ error: 'Valid other user required' });
  }
  
  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, otherUserId]
  );
  
  if (isFriend.rows.length === 0) {
    return res.status(403).json({ error: 'Add this user as a friend first' });
  }
  
  const existing = await pool.query(`
    SELECT c.id 
    FROM conversations c
    WHERE c.is_group = false
    AND EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = c.id AND user_id = $1
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = c.id AND user_id = $2
    )
    AND (
      SELECT COUNT(*) FROM conversation_participants 
      WHERE conversation_id = c.id
    ) = 2
  `, [req.userId, otherUserId]);
  
  if (existing.rows.length > 0) {
    return res.json({ conversationId: existing.rows[0].id });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      'INSERT INTO conversations (is_group) VALUES (false) RETURNING id'
    );
    const cid = ins.rows[0].id;
    await client.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [cid, req.userId, otherUserId]
    );
    await client.query('COMMIT');
    res.json({ conversationId: cid });
  } catch (e) {
    await client.query('ROLLBACK');
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

  const allUserIds = [...new Set([req.userId, ...userIds])];
  
  for (const uid of userIds) {
    if (uid === req.userId) continue;
    
    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
      [req.userId, uid]
    );
    
    if (isFriend.rows.length === 0) {
      return res.status(403).json({ 
        error: `User ${uid} is not your friend` 
      });
    }
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const ins = await client.query(
      'INSERT INTO conversations (is_group, title) VALUES (true, $1) RETURNING id',
      [title]
    );

    const cid = ins.rows[0].id;

    for (const uid of allUserIds) {
      await client.query(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)',
        [cid, uid]
      );
    }

    await client.query('COMMIT');
    
    for (const uid of userIds) {
      const clients = sseClients.get(uid);
      if (clients) {
        const payload = {
          type: 'new_group',
          conversationId: cid,
          groupTitle: title
        };
        clients.forEach(r => {
          try { r.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
        });
      }
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
  
  const group = await pool.query(`
    SELECT c.id, c.title, c.created_at, 
           json_agg(json_build_object('id', u.id, 'username', u.username)) as participants
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
  const { userId } = req.body || {};
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }
  
  const check = await pool.query(`
    SELECT c.is_group FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);
  
  if (check.rows.length === 0 || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Group not found or not a member' });
  }
  
  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
    [req.userId, userId]
  );
  
  if (isFriend.rows.length === 0) {
    return res.status(403).json({ error: 'You can only add friends to groups' });
  }
  
  try {
    await pool.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)',
      [groupId, userId]
    );
    
    const clients = sseClients.get(userId);
    if (clients) {
      const payload = {
        type: 'added_to_group',
        conversationId: groupId
      };
      clients.forEach(r => {
        try { r.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
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

  // Проверяем, что это группа и пользователь в ней
  const check = await pool.query(`
    SELECT c.is_group
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = $1 AND cp.user_id = $2
  `, [groupId, req.userId]);

  if (check.rows.length === 0 || !check.rows[0].is_group) {
    return res.status(404).json({ error: 'Group not found or not a member' });
  }

  // Удаляем пользователя из группы
  await pool.query(
    'DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [groupId, req.userId]
  );

  // Если в группе никого не осталось — удаляем её
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
// FIXED: Returns messages with sender username
app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  
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
  const { body } = req.body || {};
  
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });
  
  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );
  
  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
  
  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not in this conversation' });
  
  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);
  
  // Определяем, является ли сообщение файлом
  let messageBody = String(body).trim();
  let messageType = 'text';

  // Проверяем, не является ли сообщение JSON-строкой от клиента (для файлов)
  try {
    const parsed = JSON.parse(messageBody);
    if (parsed.type === 'file') {
      messageType = 'file';
      // Оставляем как есть, это валидный JSON
    }
  } catch (e) {
    // Это просто текст
  }

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
    
    const clients = sseClients.get(uid);
    if (clients) {
      clients.forEach(r => {
        try { r.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
      });
    }
  }
  
  res.status(201).json(payload.message);
});

// Legacy endpoints
app.get('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  
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
  const { body } = req.body || {};
  
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });
  
  const part = await pool.query(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
    [convId]
  );
  
  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
  
  const isMember = part.rows.some(p => p.user_id === req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not in this conversation' });
  
  const otherUserIds = part.rows.filter(p => p.user_id !== req.userId).map(p => p.user_id);
  
  const ins = await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at, sender_id',
    [convId, req.userId, String(body).trim()]
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
    
    const clients = sseClients.get(uid);
    if (clients) {
      clients.forEach(r => {
        try { r.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
      });
    }
  }
  
  res.status(201).json(payload.message);
});


// ---- DELETE MESSAGE ----
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);

  // Получаем сообщение
  const r = await pool.query(
    'SELECT id, sender_id, conversation_id FROM messages WHERE id = $1',
    [messageId]
  );

  if (r.rows.length === 0) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const message = r.rows[0];

  // Проверяем, что пользователь — автор
  if (message.sender_id !== req.userId) {
    return res.status(403).json({ error: 'You can delete only your messages' });
  }

  // Удаляем уведомления по этому сообщению
  await pool.query(
    'DELETE FROM notifications WHERE message_id = $1',
    [messageId]
  );

  // Удаляем сообщение
  await pool.query(
    'DELETE FROM messages WHERE id = $1',
    [messageId]
  );

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

app.get('/api/notifications/stream', streamAuthMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const userId = req.userId;
  
  if (!sseClients.has(userId)) sseClients.set(userId, []);
  sseClients.get(userId).push(res);
  
  res.on('close', () => {
    const list = sseClients.get(userId);
    if (list) {
      const i = list.indexOf(res);
      if (i !== -1) list.splice(i, 1);
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

app.get('/api/signaling', streamAuthMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const userId = req.userId;
  
  if (!signalingChannels.has(userId)) signalingChannels.set(userId, new Set());
  signalingChannels.get(userId).add(res);
  
  res.on('close', () => {
    const set = signalingChannels.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) signalingChannels.delete(userId);
    }
  });
});

app.post('/api/signaling', authMiddleware, async (req, res) => {
  const { type, targetUserId, offer, answer, candidate } = req.body || {};
  
  if (!type || !targetUserId) {
    return res.status(400).json({ error: 'Type and targetUserId required' });
  }
  
  const payload = {
    type,
    fromUserId: req.userId,
    [type === 'ice-candidate' ? 'candidate' : type]: type === 'ice-candidate' ? candidate : (type === 'offer' ? offer : answer)
  };
  
  // Send to target user
  const channels = signalingChannels.get(targetUserId);
  if (channels) {
    const eventName = type === 'ice-candidate' ? 'ice-candidate' : type;
    channels.forEach(res => {
      try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (e) {
        channels.delete(res);
      }
    });
  }
  
  res.json({ ok: true });
});

// ---- GROUP MEMBERS ----
app.get('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  
  const r = await pool.query(`
    SELECT u.id, u.username
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
  // Возвращаем данные о файле
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    type: req.file.mimetype
  });
});

// Раздаем файлы из папки uploads
app.use('/uploads', express.static('uploads'));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  try {
    await initDb();
    console.log('Database ready');
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main();