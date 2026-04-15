alter table public.profiles
    add column if not exists nickname text,
    add column if not exists last_seen_at timestamptz;

update public.profiles
set nickname = coalesce(nickname, display_name, username)
where nickname is null;

alter table public.chat_members
    add column if not exists last_delivered_at timestamptz,
    add column if not exists last_read_at timestamptz;

create table if not exists public.user_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    expo_push_token text not null unique,
    platform text not null check (platform in ('ios', 'android', 'web')),
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_chat_members_user_chat
    on public.chat_members (user_id, chat_id);

create index if not exists idx_profiles_phone_digits
    on public.profiles ((regexp_replace(phone_e164, '\D', '', 'g')));

create index if not exists idx_user_devices_user_id
    on public.user_devices (user_id);

alter table public.user_devices enable row level security;

create or replace function public.handle_user_devices_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists trg_user_devices_updated_at on public.user_devices;
create trigger trg_user_devices_updated_at
before update on public.user_devices
for each row
execute function public.handle_user_devices_updated_at();

create or replace function public.touch_profile_presence(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
    update public.profiles
    set last_seen_at = timezone('utc', now())
    where id = p_user_id;
$$;

create or replace function public.handle_message_receipts_on_insert()
returns trigger
language plpgsql
as $$
begin
    update public.chat_members
    set last_delivered_at = timezone('utc', now()),
        last_read_at = timezone('utc', now()),
        last_read_message_id = new.id
    where chat_id = new.chat_id
      and user_id = new.sender_id;

    return new;
end;
$$;

drop trigger if exists trg_messages_receipts_on_insert on public.messages;
create trigger trg_messages_receipts_on_insert
after insert on public.messages
for each row
execute function public.handle_message_receipts_on_insert();

drop policy if exists "user_devices_select_self" on public.user_devices;
create policy "user_devices_select_self"
on public.user_devices
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "user_devices_insert_self" on public.user_devices;
create policy "user_devices_insert_self"
on public.user_devices
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "user_devices_update_self" on public.user_devices;
create policy "user_devices_update_self"
on public.user_devices
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "user_devices_delete_self" on public.user_devices;
create policy "user_devices_delete_self"
on public.user_devices
for delete
to authenticated
using (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
on storage.objects
for select
to public
using (bucket_id = 'avatars');

drop policy if exists "avatars_upload_own_folder" on storage.objects;
create policy "avatars_upload_own_folder"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "avatars_update_own_folder" on storage.objects;
create policy "avatars_update_own_folder"
on storage.objects
for update
to authenticated
using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "avatars_delete_own_folder" on storage.objects;
create policy "avatars_delete_own_folder"
on storage.objects
for delete
to authenticated
using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
);
