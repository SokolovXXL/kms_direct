# Messenger – Web App

A simple messenger with **accounts**, **direct messages**, and **notifications** when the other person receives a message. Runs on [Render.com](https://render.com).

## Features

- **Accounts** – Register and sign in (username + password).
- **Direct messages** – Start a conversation with any user and send messages.
- **Notifications** – When someone sends you a message, you get:
  - A **toast** at the bottom: “New message”.
  - An **unread badge** in the header and per-conversation in the sidebar.
  - Messages in the open chat update in real time (SSE).

## Run locally

1. **PostgreSQL** – Create a database and set its URL:
   ```bash
   cp .env.example .env
   # Edit .env: set DATABASE_URL and JWT_SECRET
   ```

2. **Install and start**:
   ```bash
   npm install
   npm start
   ```
   Open http://localhost:3000 (or the port in `.env`).

## Deploy on Render.com

1. **New Web Service** – Connect this repo. Render will use `package.json` and run `npm start`.
2. **PostgreSQL** – In the Render dashboard, create a **PostgreSQL** database. Copy its **Internal Database URL** (or External if your app is public).
3. **Environment variables** on the Web Service:
   - `DATABASE_URL` = (paste the PostgreSQL URL from step 2)
   - `JWT_SECRET` = a long random string (e.g. generate with `openssl rand -hex 32`)
4. Deploy. The app will create tables on first run.

**Optional – Blueprint:** You can use `render.yaml` for a one-click deploy that creates both the web service and a PostgreSQL database and links them. In the Render dashboard, choose “New” → “Blueprint” and connect the repo; select `render.yaml`.

## Tech

- **Backend:** Node.js, Express, PostgreSQL, JWT auth, Server-Sent Events (SSE) for live notifications.
- **Frontend:** Vanilla HTML, CSS, JavaScript (no framework).
