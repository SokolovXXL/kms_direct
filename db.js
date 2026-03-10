const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(16) UNIQUE;
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
    await pool.query(`
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);`);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };