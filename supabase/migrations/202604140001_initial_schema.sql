create extension if not exists "pgcrypto";

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text unique,
    phone_e164 text unique not null,
    display_name text,
    avatar_path text,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.chats (
    id uuid primary key default gen_random_uuid(),
    title text,
    is_group boolean not null default false,
    dm_key text unique,
    created_by uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.chat_members (
    chat_id uuid not null references public.chats(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    joined_at timestamptz not null default timezone('utc', now()),
    last_read_message_id uuid,
    primary key (chat_id, user_id)
);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    chat_id uuid not null references public.chats(id) on delete cascade,
    sender_id uuid not null references public.profiles(id) on delete cascade,
    body text not null check (char_length(body) <= 4000),
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_messages_chat_created_at
    on public.messages (chat_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;

create or replace function public.handle_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.handle_profile_updated_at();

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, username, phone_e164, display_name)
    values (
        new.id,
        case
            when new.phone is null then null
            else '+' || regexp_replace(new.phone, '\D', '', 'g')
        end,
        case
            when new.phone is null then null
            else '+' || regexp_replace(new.phone, '\D', '', 'g')
        end,
        null
    )
    on conflict (id) do update
    set username = excluded.username,
        phone_e164 = excluded.phone_e164;

    return new;
end;
$$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
after insert on auth.users
for each row
execute function public.handle_auth_user_created();

drop trigger if exists trg_messages_updated_at on public.messages;
create trigger trg_messages_updated_at
before update on public.messages
for each row
execute function public.handle_profile_updated_at();

create policy "profiles_select_own_or_member"
on public.profiles
for select
to authenticated
using (
    id = auth.uid()
    or exists (
        select 1
        from public.chat_members cm_self
        join public.chat_members cm_other
            on cm_self.chat_id = cm_other.chat_id
        where cm_self.user_id = auth.uid()
          and cm_other.user_id = profiles.id
    )
);

create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "chats_select_members"
on public.chats
for select
to authenticated
using (
    exists (
        select 1
        from public.chat_members cm
        where cm.chat_id = chats.id
          and cm.user_id = auth.uid()
    )
);

create policy "chats_insert_creator"
on public.chats
for insert
to authenticated
with check (created_by = auth.uid());

create policy "chat_members_select_members"
on public.chat_members
for select
to authenticated
using (
    exists (
        select 1
        from public.chat_members cm
        where cm.chat_id = chat_members.chat_id
          and cm.user_id = auth.uid()
    )
);

create policy "chat_members_insert_self_or_creator"
on public.chat_members
for insert
to authenticated
with check (
    user_id = auth.uid()
    or exists (
        select 1
        from public.chats c
        where c.id = chat_members.chat_id
          and c.created_by = auth.uid()
    )
);

create policy "messages_select_members"
on public.messages
for select
to authenticated
using (
    exists (
        select 1
        from public.chat_members cm
        where cm.chat_id = messages.chat_id
          and cm.user_id = auth.uid()
    )
);

create policy "messages_insert_sender_member"
on public.messages
for insert
to authenticated
with check (
    sender_id = auth.uid()
    and exists (
        select 1
        from public.chat_members cm
        where cm.chat_id = messages.chat_id
          and cm.user_id = auth.uid()
    )
);

create policy "messages_update_sender"
on public.messages
for update
to authenticated
using (sender_id = auth.uid())
with check (sender_id = auth.uid());
