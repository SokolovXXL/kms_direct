require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { pool, initDb } = require('./db');
const path = require('path');

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
<<<<<<< HEAD
// Increased limit for base64 file transfers
app.use(express.json({ limit: '25mb' }));
=======

// FIX: увеличен лимит для JSON и для URL-encoded (для файлов)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients = new Map();
// In-memory call rooms: callId -> { conversationId, initiatorId, participants: Set<userId> }
const activeCalls = new Map();

function sendSSE(userId, payload) {
  const clients = sseClients.get(userId);
  if (clients && clients.length > 0) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    clients.forEach(r => { try { r.write(data); } catch (_) {} });
  }
}

function authMiddleware(req, res, next) {
  const token = req.cookies.token || 
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && 
                 req.headers.authorization.slice(7));
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
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
  if (!username || !password || username.length < 2)
    return res.status(400).json({ error: 'Username (min 2 chars) and password required' });
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
      return res.json({ user: { id: user.id, username: user.username, friend_code: user.friend_code } });
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
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  let friendCode = user.friend_code;
  if (!friendCode) {
    friendCode = generateFriendCode();
    await pool.query('UPDATE users SET friend_code = $1 WHERE id = $2', [friendCode, user.id]);
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  res.cookie('token', token, COOKIE_OPTIONS);
  return res.json({ user: { id: user.id, username: user.username, friend_code: friendCode } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ success: true });
});

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

app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (!password || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Password required to delete account' });
  await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.clearCookie('token', COOKIE_OPTIONS);
  res.json({ ok: true });
});

// ---- Friends ----
app.get('/api/friends', authMiddleware, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.username, u.friend_code FROM friends f
    JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.username
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
function msgPreview(body) {
  if (!body) return null;
  if (body.startsWith('[IMG|')) return '📷 Image';
  if (body.startsWith('[FILE|')) return `📎 ${body.split('|')[1] || 'File'}`;
  return body;
}

const CONV_QUERY = (userId) => pool.query(`
  SELECT c.id, c.created_at, c.is_group, c.title,
    COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'username', u.username)) FILTER (WHERE u.id != $1), '[]'::json) AS participants,
    MAX(m.created_at) AS last_at,
    (SELECT jsonb_build_object('id',m2.id,'body',m2.body,'sender_id',m2.sender_id,'sender_username',u2.username,'created_at',m2.created_at)
     FROM messages m2 JOIN users u2 ON u2.id = m2.sender_id WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) AS last_message
  FROM conversations c
  JOIN conversation_participants cp ON cp.conversation_id = c.id
  JOIN users u ON u.id = cp.user_id
  LEFT JOIN messages m ON m.conversation_id = c.id
  WHERE c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = $1)
  GROUP BY c.id ORDER BY last_at DESC NULLS LAST
`, [userId]);

function mapConvRow(row, userId) {
  const participants = row.participants || [];
  const otherUsers = participants.filter(p => p.id !== userId);
  const lm = row.last_message;
  return {
    id: row.id, isGroup: row.is_group || false, title: row.title,
    participants, otherUsers,
    otherUser: !row.is_group && otherUsers.length > 0 ? otherUsers[0] : null,
    lastMessage: lm ? msgPreview(lm.body) : null,
    lastMessageData: lm, lastAt: row.last_at, createdAt: row.created_at
  };
}

app.get('/api/conversations', authMiddleware, async (req, res) => {
  const r = await CONV_QUERY(req.userId);
  res.json(r.rows.map(row => mapConvRow(row, req.userId)));
});

app.get('/api/dms', authMiddleware, async (req, res) => {
  const r = await CONV_QUERY(req.userId);
  res.json(r.rows.map(row => mapConvRow(row, req.userId)));
});

app.post('/api/dms', authMiddleware, async (req, res) => {
  const { otherUserId } = req.body || {};
  if (!otherUserId || otherUserId === req.userId)
    return res.status(400).json({ error: 'Valid other user required' });
  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
    [req.userId, otherUserId]
  );
  if (isFriend.rows.length === 0) return res.status(403).json({ error: 'Add this user as a friend first' });
  const existing = await pool.query(`
    SELECT c.id FROM conversations c WHERE c.is_group=false
    AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id=c.id AND user_id=$1)
    AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id=c.id AND user_id=$2)
    AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id=c.id)=2
  `, [req.userId, otherUserId]);
  if (existing.rows.length > 0) return res.json({ conversationId: existing.rows[0].id });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query('INSERT INTO conversations (is_group) VALUES (false) RETURNING id');
    const cid = ins.rows[0].id;
    await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2),($1,$3)', [cid, req.userId, otherUserId]);
    await client.query('COMMIT');
    res.json({ conversationId: cid });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ---- Groups ----
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { title, userIds } = req.body || {};
  if (!title || !Array.isArray(userIds) || userIds.length < 1)
    return res.status(400).json({ error: 'Title and at least 1 other user required' });
  const allUserIds = [...new Set([req.userId, ...userIds])];
  for (const uid of userIds) {
    if (uid === req.userId) continue;
    const isFriend = await pool.query(
      'SELECT 1 FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
      [req.userId, uid]
    );
    if (isFriend.rows.length === 0) return res.status(403).json({ error: `User ${uid} is not your friend` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query('INSERT INTO conversations (is_group, title) VALUES (true, $1) RETURNING id', [title]);
    const cid = ins.rows[0].id;
    for (const uid of allUserIds)
      await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [cid, uid]);
    await client.query('COMMIT');
    for (const uid of userIds) sendSSE(uid, { type: 'new_group', conversationId: cid, groupTitle: title });
    res.json({ conversationId: cid });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

app.get('/api/groups/:id', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const group = await pool.query(`
    SELECT c.id, c.title, c.created_at,
      json_agg(json_build_object('id',u.id,'username',u.username)) as participants
    FROM conversations c JOIN conversation_participants cp ON cp.conversation_id=c.id
    JOIN users u ON u.id=cp.user_id WHERE c.id=$1 AND c.is_group=true GROUP BY c.id
  `, [groupId]);
  if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
  if (!group.rows[0].participants.some(p => p.id === req.userId))
    return res.status(403).json({ error: 'Not a member of this group' });
  res.json(group.rows[0]);
});

app.post('/api/groups/:id/members', authMiddleware, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'User ID required' });
  const check = await pool.query(`
    SELECT c.is_group FROM conversations c JOIN conversation_participants cp ON cp.conversation_id=c.id
    WHERE c.id=$1 AND cp.user_id=$2
  `, [groupId, req.userId]);
  if (check.rows.length === 0 || !check.rows[0].is_group)
    return res.status(404).json({ error: 'Group not found or not a member' });
  const isFriend = await pool.query(
    'SELECT 1 FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
    [req.userId, userId]
  );
  if (isFriend.rows.length === 0) return res.status(403).json({ error: 'You can only add friends to groups' });
  try {
    await pool.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2)', [groupId, userId]);
    sendSSE(userId, { type: 'added_to_group', conversationId: groupId });
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'User already in group' });
    throw e;
  }
});

// ---- Messages ----
async function getMessages(convId, userId, res) {
  const part = await pool.query('SELECT 1 FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2', [convId, userId]);
  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
  const r = await pool.query(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.username AS sender_username
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.conversation_id=$1 ORDER BY m.created_at ASC
  `, [convId]);
  res.json(r.rows);
}

async function postMessage(convId, userId, body, res) {
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body required' });
  const part = await pool.query('SELECT user_id FROM conversation_participants WHERE conversation_id=$1', [convId]);
  if (part.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
  if (!part.rows.some(p => p.user_id === userId)) return res.status(403).json({ error: 'Not in this conversation' });
  const otherIds = part.rows.filter(p => p.user_id !== userId).map(p => p.user_id);
  const ins = await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at, sender_id',
    [convId, userId, String(body).trim()]
  );
  const msg = ins.rows[0];
  const sender = await pool.query('SELECT username FROM users WHERE id=$1', [userId]);
  const preview = msgPreview(msg.body);
  const payload = {
    type: 'new_message', conversationId: convId, previewBody: preview,
    message: { id: msg.id, body: msg.body, created_at: msg.created_at, sender_id: msg.sender_id, sender_username: sender.rows[0]?.username || '' }
  };
  for (const uid of otherIds) {
    await pool.query('INSERT INTO notifications (user_id, conversation_id, message_id) VALUES ($1,$2,$3)', [uid, convId, msg.id]);
    sendSSE(uid, payload);
  }
  res.status(201).json(payload.message);
}

app.get('/api/conversations/:id/messages', authMiddleware, (req, res) => getMessages(parseInt(req.params.id,10), req.userId, res));
app.post('/api/conversations/:id/messages', authMiddleware, (req, res) => postMessage(parseInt(req.params.id,10), req.userId, (req.body||{}).body, res));
app.get('/api/dms/:id/messages', authMiddleware, (req, res) => getMessages(parseInt(req.params.id,10), req.userId, res));
app.post('/api/dms/:id/messages', authMiddleware, (req, res) => postMessage(parseInt(req.params.id,10), req.userId, (req.body||{}).body, res));

// ---- WebRTC Call Signaling ----

app.post('/api/calls/start', authMiddleware, async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
  const part = await pool.query('SELECT user_id FROM conversation_participants WHERE conversation_id=$1', [conversationId]);
  if (!part.rows.some(r => r.user_id === req.userId)) return res.status(403).json({ error: 'Not in this conversation' });
  const callerInfo = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  const callerName = callerInfo.rows[0]?.username || 'Someone';
  const callId = crypto.randomBytes(8).toString('hex');
  activeCalls.set(callId, { conversationId, initiatorId: req.userId, participants: new Set([req.userId]) });
  const otherIds = part.rows.filter(r => r.user_id !== req.userId).map(r => r.user_id);
  for (const uid of otherIds) sendSSE(uid, { type: 'call_invite', callId, conversationId, callerId: req.userId, callerName });
  res.json({ callId });
});

app.post('/api/calls/:callId/accept', authMiddleware, async (req, res) => {
  const { callId } = req.params;
  const call = activeCalls.get(callId);
  if (!call) return res.status(404).json({ error: 'Call not found or ended' });
  const existingIds = [...call.participants];
  call.participants.add(req.userId);
  const selfInfo = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  const selfName = selfInfo.rows[0]?.username || 'Unknown';
  const existingRows = existingIds.length > 0
    ? (await pool.query('SELECT id, username FROM users WHERE id = ANY($1::int[])', [existingIds])).rows : [];
  for (const uid of existingIds) sendSSE(uid, { type: 'call_user_joined', callId, userId: req.userId, username: selfName });
  res.json({ callId, existingParticipants: existingRows });
});

app.post('/api/calls/:callId/reject', authMiddleware, async (req, res) => {
  const { callId } = req.params;
  const call = activeCalls.get(callId);
  if (!call) return res.json({ ok: true });
  const selfInfo = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  const selfName = selfInfo.rows[0]?.username || 'Someone';
  for (const uid of call.participants) sendSSE(uid, { type: 'call_rejected', callId, userId: req.userId, username: selfName });
  res.json({ ok: true });
});

app.post('/api/calls/:callId/end', authMiddleware, async (req, res) => {
  const { callId } = req.params;
  const call = activeCalls.get(callId);
  if (!call) return res.json({ ok: true });
  const selfInfo = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
  const selfName = selfInfo.rows[0]?.username || 'Someone';
  call.participants.delete(req.userId);
  for (const uid of call.participants) sendSSE(uid, { type: 'call_user_left', callId, userId: req.userId, username: selfName });
  if (call.participants.size === 0) activeCalls.delete(callId);
  res.json({ ok: true });
});

// Relay WebRTC signaling (offer/answer/ICE)
app.post('/api/signal', authMiddleware, (req, res) => {
  const { targetUserId, payload } = req.body || {};
  if (!targetUserId || !payload) return res.status(400).json({ error: 'targetUserId and payload required' });
  sendSSE(targetUserId, { ...payload, fromUserId: req.userId });
  res.json({ ok: true });
});

// ---- Notifications ----
app.get('/api/notifications/count', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1', [req.userId]);
  res.json({ count: r.rows[0].c });
});

app.get('/api/notifications', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT conversation_id, COUNT(*)::int AS c FROM notifications WHERE user_id=$1 GROUP BY conversation_id', [req.userId]);
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
    await pool.query('DELETE FROM notifications WHERE user_id=$1 AND conversation_id=$2', [req.userId, conversationId]);
  } else {
    await pool.query('DELETE FROM notifications WHERE user_id=$1', [req.userId]);
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
<<<<<<< HEAD
=======

module.exports = { pool, initDb };
>>>>>>> 326a1f8e0c439a51972a405d20a1f0bb6db37cd0
