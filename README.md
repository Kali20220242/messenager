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
4. Apply Supabase migrations to the linked hosted project.
5. Run `cargo run -p messenger-backend` for the API.
6. Run `npm run mobile` for the Expo app or `npm run mobile:web` for the web client.

## Environment

- `SUPABASE_URL` - hosted project URL used by the backend for config visibility
- `SUPABASE_DB_URL` - Postgres connection string for SQLx; prefer the Supabase session pooler URL with `sslmode=require`
- `SUPABASE_PUBLISHABLE_KEY` - publishable key used by the backend to validate Bearer tokens against Supabase Auth
- `EXPO_PUBLIC_SUPABASE_URL` - hosted project URL exposed to the Expo client
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - client-safe publishable key for Supabase JS
- `EXPO_PUBLIC_API_URL` - LAN-accessible backend URL for web and real-device testing
- `EXPO_PUBLIC_EAS_PROJECT_ID` - Expo project ID fallback used for push token registration when Expo Constants does not expose it

`supabase/config.toml` is only for local Supabase CLI development. Hosted project auth redirects, realtime, and database settings must be configured in the Supabase dashboard or applied via SQL migrations.

## Product Surface

- Phone OTP auth with Supabase Auth
- Exact phone search plus contacts discovery
- Direct chats powered by Rust + SQLx
- Realtime message stream via Supabase Realtime with polling fallback
- Profile editing with nickname and avatar upload
- Unread counters plus sent / delivered / seen states
- Online / last seen presence
- Expo push token registration and backend push dispatch
- RLS-protected profiles, chats, chat members, messages, devices, and storage objects
- Secure token storage on device

## Local Network Testing

- Set `API_HOST=0.0.0.0` so the Rust backend is reachable from your LAN.
- Set `EXPO_PUBLIC_API_URL` to your Mac's LAN IP, for example `http://192.168.0.10:8080`.
- Keep the phone and the Mac on the same Wi‑Fi network.
- Hosted Supabase phone OTP must be configured in the Supabase dashboard; `supabase/config.toml` does not configure hosted SMS delivery.
- Push notifications require a valid Expo project ID. On SDK 54, remote push notifications are unavailable in Expo Go on Android, so use a development build there. iPhone Expo Go can still be used for LAN testing of the rest of the app.

## Hosted Supabase Checklist

- Run the SQL migrations in `supabase/migrations`, including the avatar bucket / policy migration.
- Enable Phone Auth and the SMS provider in the Supabase dashboard.
- Make sure `public.messages` remains in the `supabase_realtime` publication.
- Leave the `avatars` storage bucket public unless you also update the client URL strategy.
