alter table public.chat_members
    add column if not exists cleared_at timestamptz;

create index if not exists idx_chat_members_user_cleared_at
    on public.chat_members (user_id, cleared_at);
