require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, initDb } = require('./db');
const path = require('path');

function generateFriendCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return crypto.randomBytes(8).reduce((s, b) => s + chars[b % chars.length], '');
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients = new Map();

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function streamAuthMiddleware(req, res, next) {
  const token = req.query.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && req.headers.authorization.slice(7));
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
      return res.json({ user: { id: user.id, username: user.username, friend_code: user.friend_code }, token });
    } catch (e) {
      if (e.code === '23505') {
        if (e.constraint && e.constraint.includes('friend_code')) { friendCode = generateFriendCode(); continue; }
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
  return res.json({ user: { id: user.id, username: user.username, friend_code: friendCode }, token });
});

// ---- Me (profile + friend code) ----
app.get('/api/me', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT id, username, friend_code FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!user.friend_code) {
    user.friend_code = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [user.friend_code, user.id]);
  }
  res.json({ id: user.id, username: user.username, friend_code: user.friend_code });
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
  res.json({ ok: true });
});

// ---- Friends (by friend code) ----
app.get('/api/friends', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.friend_code
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
    WHERE (f.user_id = $1 OR f.friend_id = $1) AND u.id != $1
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

// ---- DMs ----
app.get('/api/dms', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id, c.created_at,
           u.id AS other_user_id, u.username AS other_username,
           (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
           (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_at
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    JOIN users u ON u.id = cp.user_id AND u.id != $1
    WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = $1)
    ORDER BY last_at DESC NULLS LAST, c.id DESC
  `, [req.userId]);
  const convos = r.rows.map(row => ({
    id: row.id,
    otherUser: { id: row.other_user_id, username: row.other_username },
    lastMessage: row.last_message,
    lastAt: row.last_at,
  }));
  res.json(convos);
});

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
    return res.status(403).json({ error: 'Add this user as a friend first (using their friend code)' });
  }
  const existing = await pool.query(`
    SELECT c.id FROM conversations c
    WHERE EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = $1)
    AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = $2)
  `, [req.userId, otherUserId]);
  if (existing.rows.length > 0) {
    return res.json({ conversationId: existing.rows[0].id });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
    const cid = ins.rows[0].id;
    await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [cid, req.userId, otherUserId]);
    await client.query('COMMIT');
    res.json({ conversationId: cid });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// ---- Messages ----
app.get('/api/dms/:id/messages', authMiddleware, async (req, res) => {
  const convId = parseInt(req.params.id, 10);
  const part = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
    [convId, req.userId]
  );
  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
  const r = await pool.query(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.username AS sender_username
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
    messageId: msg.id,
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
  res.status(201).json({ id: msg.id, body: msg.body, created_at: msg.created_at, sender_id: msg.sender_id });
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
