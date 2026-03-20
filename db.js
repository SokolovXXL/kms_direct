const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
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
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(64) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()
      `);
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(16) UNIQUE;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reactions (
          id SERIAL PRIMARY KEY,
          message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          emoji VARCHAR(50) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(message_id, user_id, emoji)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS friends (
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          friend_id INT REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, friend_id),
          CHECK (user_id != friend_id)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_participants (
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (conversation_id, user_id)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id INT REFERENCES users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          message_id INT REFERENCES messages(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE conversations 
        ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS title TEXT
      `);
      await client.query(`
        ALTER TABLE conversation_participants
        ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'member'
      `);
      await client.query(`
        ALTER TABLE conversation_participants
        ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ
      `);
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(64);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          keys_p256dh TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, endpoint)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);`);

      console.log(`Database initialized successfully (attempt ${attempt})`);
      return; // успех
    } catch (err) {
      lastError = err;
      console.error(`Database init attempt ${attempt}/${retries} failed:`, err.message);
      if (client) {
        try { client.release(); } catch (e) {}
      }
      if (attempt < retries) {
        const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s...
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError; // все попытки исчерпаны
}

module.exports = { pool, initDb };