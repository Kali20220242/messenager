alter table public.e2ee_pending_messages
add column if not exists chat_id uuid references public.chats(id) on delete set null;

create index if not exists idx_e2ee_pending_messages_chat_id
    on public.e2ee_pending_messages (chat_id, created_at asc);
