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
5. Run `npm run mobile` for the Expo app or `npm run mobile:web` for the web client.

## Environment

- `SUPABASE_URL` - hosted project URL used by the backend for config visibility
- `SUPABASE_DB_URL` - Postgres connection string for SQLx; prefer the Supabase session pooler URL with `sslmode=require`
- `SUPABASE_PUBLISHABLE_KEY` - publishable key used by the backend to validate Bearer tokens against Supabase Auth
- `EXPO_PUBLIC_SUPABASE_URL` - hosted project URL exposed to the Expo client
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - client-safe publishable key for Supabase JS
- `EXPO_PUBLIC_API_URL` - LAN-accessible backend URL for web and real-device testing

`supabase/config.toml` is only for local Supabase CLI development. Hosted project auth redirects, realtime, and database settings must be configured in the Supabase dashboard or applied via SQL migrations.

## Product Surface

- Phone OTP auth with Supabase Auth
- Exact user search by E.164 phone number
- Direct chats powered by Rust + SQLx
- Realtime message stream via Supabase Realtime
- RLS-protected profiles, chats, chat members, and messages
- Secure token storage on device

## Local Network Testing

- Set `API_HOST=0.0.0.0` so the Rust backend is reachable from your LAN.
- Set `EXPO_PUBLIC_API_URL` to your Mac's LAN IP, for example `http://192.168.0.10:8080`.
- Keep the phone and the Mac on the same Wi‑Fi network.
- Hosted Supabase phone OTP must be configured in the Supabase dashboard; `supabase/config.toml` does not configure hosted SMS delivery.
