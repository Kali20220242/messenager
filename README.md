# Messenger Monorepo

Monorepo for a mobile messenger with a Rust backend, Supabase/PostgreSQL, and a React Native (Expo) client.

## Stack

- Backend: Rust, Axum, SQLx
- Mobile: React Native, Expo, TypeScript, Zustand, Supabase JS
- Database: Supabase (PostgreSQL, Auth, Realtime, Storage)

## Structure

- `apps/backend` - Rust HTTP API and business logic
- `apps/mobile` - Expo React Native client
- `supabase` - SQL schema and local project config

## Quick Start

1. Copy `.env.example` to `.env` and fill in the Supabase values.
2. Install Node.js 22+ and Rust stable.
3. Install dependencies with `npm install` at the repository root.
4. Run `cargo run -p messenger-backend` for the API.
5. Run `npm run mobile` for the Expo app.

## Planned Product Surface

- Email/password auth with Supabase Auth
- Real-time chat list and message stream
- RLS-protected profiles, chats, chat members, and messages
- Secure token storage on device

