const { Pool } = require('pg');

const isRender = !!process.env.RENDER; // или process.env.DATABASE_URL?.includes('render.com')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});

pool.on('connect', (client) => {
  client.query("SET client_encoding TO 'UTF8'");
});

async function initDb(retries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let client;
    try {
      client = await pool.connect();

      // 1. Таблица users
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(64) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(16) UNIQUE`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(64)`);

      // 2. Таблица conversations (основная)
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT`);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user1_id INTEGER`);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user2_id INTEGER`);
      await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_channel BOOLEAN DEFAULT false`);

      // 3. Таблица conversation_participants
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_participants (
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (conversation_id, user_id)
        );
      `);
      await client.query(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member'`);
      await client.query(`ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ`);

      // 4. Заполнение user1_id, user2_id для существующих DM (если есть данные)
      await client.query(`
        UPDATE conversations c SET
          user1_id = sub.user1,
          user2_id = sub.user2
        FROM (
          SELECT c.id,
                MIN(cp.user_id) as user1,
                MAX(cp.user_id) as user2
          FROM conversations c
          JOIN conversation_participants cp ON cp.conversation_id = c.id
          WHERE c.is_group = false AND (c.user1_id IS NULL OR c.user2_id IS NULL)
          GROUP BY c.id
          HAVING COUNT(cp.user_id) = 2
        ) sub
        WHERE c.id = sub.id
      `);

      // 5. Таблица friends
      await client.query(`
        CREATE TABLE IF NOT EXISTS friends (
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          friend_id INT REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, friend_id),
          CHECK (user_id != friend_id)
        );
      `);

      // 6. Таблица messages
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id INT REFERENCES users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
        );
      `);

      // 7. Таблица reactions
      await client.query(`
        CREATE TABLE IF NOT EXISTS reactions (
          id SERIAL PRIMARY KEY,
          message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          emoji VARCHAR(50) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(message_id, user_id, emoji)
        );
      `);

      // 8. Таблица notifications
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          message_id INT REFERENCES messages(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // 9. Таблица push_subscriptions
      await client.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          keys_p256dh TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, endpoint)
        );
      `);

      // 10. Таблица group_invites
      await client.query(`
        CREATE TABLE IF NOT EXISTS group_invites (
          id SERIAL PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          token VARCHAR(64) UNIQUE NOT NULL,
          created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ,
          max_uses INTEGER DEFAULT 1,
          uses INTEGER DEFAULT 0,
          CHECK (uses <= max_uses)
        );
      `);

      // 11. Индексы
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_group_invites_token ON group_invites(token);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_conversation ON notifications(user_id, conversation_id);`);

      // 12. Уникальный индекс для DM (если используете отдельную таблицу conversations с user1_id, user2_id)
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_dm 
        ON conversations (user1_id, user2_id) 
        WHERE is_group = false
      `);

      console.log(`Database initialized successfully (attempt ${attempt})`);
      return;
    } catch (err) {
      lastError = err;
      console.error(`Database init attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) {
        const delay = 2000 * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    } finally {
      if (client) {
        try { client.release(); } catch (e) {}
      }
    }
  }
  throw lastError;
}

module.exports = { pool, initDb };