create table if not exists public.e2ee_chat_events (
    id uuid primary key default gen_random_uuid(),
    chat_id uuid not null references public.chats(id) on delete cascade,
    sender_user_id uuid not null references public.profiles(id) on delete cascade,
    sender_device_id uuid not null references public.e2ee_devices(id) on delete cascade,
    event_client_message_id uuid not null,
    event_type text not null check (event_type in ('message', 'edit', 'delete', 'receipt')),
    preview_text text,
    target_client_message_id uuid,
    created_at timestamptz not null default timezone('utc', now()),
    unique (sender_device_id, event_client_message_id)
);

create index if not exists idx_e2ee_chat_events_chat_created_at
    on public.e2ee_chat_events (chat_id, created_at desc, id desc);

create index if not exists idx_e2ee_chat_events_chat_sender_created_at
    on public.e2ee_chat_events (chat_id, sender_user_id, created_at desc);

alter table public.e2ee_chat_events enable row level security;
