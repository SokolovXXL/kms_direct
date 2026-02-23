require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { pool, initDb } = require('./db');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

function generateFriendCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return crypto.randomBytes(8).reduce((s, b) => s + chars[b % chars.length], '');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients = new Map();
const rooms = new Map(); // roomId -> { users: Map<userId, { ws, nickname, avatar }> }
const peerConnections = new Map(); // Для WebRTC

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

// ---- WebSocket для комнат и WebRTC ----
wss.on('connection', (ws, req) => {
  let userId = null;
  let currentRoom = null;
  let userNickname = null;
  let userAvatar = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'join':
          // Аутентификация через токен
          try {
            const payload = jwt.verify(data.token, JWT_SECRET);
            userId = payload.userId;
            
            // Получаем данные пользователя из БД
            const user = await pool.query(
              'SELECT id, username, friend_code FROM users WHERE id = $1',
              [userId]
            );
            
            if (user.rows.length === 0) {
              ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
              return;
            }
            
            userNickname = user.rows[0].username;
            userAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(userNickname)}&background=5865f2&color=fff&size=128`;
            
            const roomId = data.roomId;
            const maxUsers = data.maxUsers || 2;
            
            // Проверяем комнату
            if (!rooms.has(roomId)) {
              rooms.set(roomId, {
                users: new Map(),
                maxUsers: maxUsers,
                createdBy: userId
              });
            }
            
            const room = rooms.get(roomId);
            
            if (room.users.size >= room.maxUsers) {
              ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
              return;
            }
            
            // Добавляем пользователя в комнату
            room.users.set(userId, {
              ws: ws,
              nickname: userNickname,
              avatar: userAvatar
            });
            
            currentRoom = roomId;
            
            // Отправляем подтверждение
            ws.send(JSON.stringify({
              type: 'joined',
              userId: userId,
              users: Array.from(room.users.keys()),
              nicknames: Object.fromEntries(
                Array.from(room.users.entries()).map(([id, u]) => [id, u.nickname])
              ),
              avatars: Object.fromEntries(
                Array.from(room.users.entries()).map(([id, u]) => [id, u.avatar])
              )
            }));
            
            // Уведомляем остальных
            broadcastToRoom(roomId, {
              type: 'user_joined',
              userId: userId,
              nickname: userNickname,
              avatar: userAvatar
            }, userId);
            
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
          }
          break;
          
        case 'leave':
          if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            room.users.delete(userId);
            
            broadcastToRoom(currentRoom, {
              type: 'user_left',
              userId: userId,
              users: Array.from(room.users.keys())
            });
            
            if (room.users.size === 0) {
              rooms.delete(currentRoom);
            }
          }
          break;
          
        case 'message':
          if (currentRoom) {
            // Сохраняем сообщение в БД
            const result = await pool.query(
              `INSERT INTO room_messages (room_id, user_id, content, file_data, file_name, file_type, file_size, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
              [
                currentRoom,
                userId,
                data.content || null,
                data.fileData || null,
                data.fileName || null,
                data.fileType || null,
                data.fileSize || null
              ]
            );
            
            const messageId = result.rows[0].id;
            
            // Рассылаем всем в комнате
            broadcastToRoom(currentRoom, {
              type: 'message',
              messageId: messageId,
              senderId: userId,
              senderNickname: userNickname,
              senderAvatar: userAvatar,
              content: data.content,
              fileData: data.fileData,
              fileName: data.fileName,
              fileType: data.fileType,
              fileSize: data.fileSize,
              createdAt: new Date().toISOString()
            });
          }
          break;
          
        case 'offer':
        case 'answer':
        case 'candidate':
          if (currentRoom && data.targetUserId) {
            // Пересылаем WebRTC сигналы целевому пользователю
            const room = rooms.get(currentRoom);
            const target = room?.users.get(data.targetUserId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
              target.ws.send(JSON.stringify({
                ...data,
                senderId: userId
              }));
            }
          }
          break;
          
        case 'mute_toggle':
          if (currentRoom) {
            broadcastToRoom(currentRoom, {
              type: 'user_muted',
              userId: userId,
              muted: data.muted
            }, userId);
          }
          break;
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });
  
  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(userId);
      
      broadcastToRoom(currentRoom, {
        type: 'user_left',
        userId: userId,
        users: Array.from(room.users.keys())
      });
      
      if (room.users.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

function broadcastToRoom(roomId, message, excludeUserId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const messageStr = JSON.stringify(message);
  
  room.users.forEach((user, userId) => {
    if (excludeUserId !== userId && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(messageStr);
    }
  });
}

// ---- Auth (ваш существующий код) ----
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

// ---- Friends (ваш существующий код) ----
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

// ---- Room messages history ----
app.get('/api/rooms/:roomId/messages', authMiddleware, async (req, res) => {
  const { roomId } = req.params;
  
  const messages = await pool.query(
    `SELECT id, user_id as "senderId", content, file_data as "fileData", 
            file_name as "fileName", file_type as "fileType", file_size as "fileSize",
            created_at as "createdAt"
     FROM room_messages 
     WHERE room_id = $1 
     ORDER BY created_at ASC 
     LIMIT 100`,
    [roomId]
  );
  
  res.json(messages.rows);
});

// ---- Notifications (ваш существующий код) ----
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

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  try {
    await initDb();
    
    // Добавляем таблицу для сообщений комнат
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS room_messages (
          id SERIAL PRIMARY KEY,
          room_id VARCHAR(255) NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          content TEXT,
          file_data TEXT,
          file_name VARCHAR(255),
          file_type VARCHAR(100),
          file_size INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id)`);
    } finally {
      client.release();
    }
    
    console.log('Database ready');
  } catch (e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
  
  server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

main();