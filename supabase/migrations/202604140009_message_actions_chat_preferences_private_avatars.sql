alter table public.chat_members
    add column if not exists archived_at timestamptz,
    add column if not exists pinned_at timestamptz,
    add column if not exists muted_until timestamptz;

alter table public.messages
    add column if not exists reply_to_message_id uuid references public.messages(id) on delete set null,
    add column if not exists forwarded_from_message_id uuid references public.messages(id) on delete set null,
    add column if not exists edited_at timestamptz,
    add column if not exists deleted_at timestamptz;

create table if not exists public.message_hidden_for_users (
    message_id uuid not null references public.messages(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    chat_id uuid not null references public.chats(id) on delete cascade,
    hidden_at timestamptz not null default timezone('utc', now()),
    primary key (message_id, user_id)
);

create index if not exists idx_chat_members_user_archived_at
    on public.chat_members (user_id, archived_at);

create index if not exists idx_chat_members_user_pinned_at
    on public.chat_members (user_id, pinned_at desc);

create index if not exists idx_chat_members_user_muted_until
    on public.chat_members (user_id, muted_until);

create index if not exists idx_messages_chat_reply_to
    on public.messages (chat_id, reply_to_message_id)
    where reply_to_message_id is not null;

create index if not exists idx_messages_chat_forwarded_from
    on public.messages (chat_id, forwarded_from_message_id)
    where forwarded_from_message_id is not null;

create index if not exists idx_messages_chat_deleted_at
    on public.messages (chat_id, deleted_at);

create index if not exists idx_message_hidden_for_users_chat_user
    on public.message_hidden_for_users (chat_id, user_id, hidden_at desc);

alter table public.message_hidden_for_users enable row level security;

drop policy if exists "message_hidden_for_users_select_self" on public.message_hidden_for_users;
create policy "message_hidden_for_users_select_self"
on public.message_hidden_for_users
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "message_hidden_for_users_insert_self" on public.message_hidden_for_users;
create policy "message_hidden_for_users_insert_self"
on public.message_hidden_for_users
for insert
to authenticated
with check (
    user_id = auth.uid()
    and exists (
        select 1
        from public.chat_members cm
        where cm.chat_id = message_hidden_for_users.chat_id
          and cm.user_id = auth.uid()
    )
);

drop policy if exists "message_hidden_for_users_delete_self" on public.message_hidden_for_users;
create policy "message_hidden_for_users_delete_self"
on public.message_hidden_for_users
for delete
to authenticated
using (user_id = auth.uid());

update storage.buckets
set public = false
where id = 'avatars';

drop policy if exists "avatars_public_read" on storage.objects;

drop policy if exists "avatars_authenticated_read" on storage.objects;
create policy "avatars_authenticated_read"
on storage.objects
for select
to authenticated
using (bucket_id = 'avatars');
