create table if not exists public.e2ee_devices (
    id uuid primary key,
    user_id uuid not null references public.profiles(id) on delete cascade,
    registration_id integer not null,
    identity_key text not null,
    signed_prekey_id integer not null,
    signed_prekey_public text not null,
    signed_prekey_signature text not null,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.e2ee_one_time_prekeys (
    device_id uuid not null references public.e2ee_devices(id) on delete cascade,
    key_id integer not null,
    public_key text not null,
    created_at timestamptz not null default timezone('utc', now()),
    claimed_at timestamptz,
    primary key (device_id, key_id)
);

create table if not exists public.e2ee_pending_messages (
    id uuid primary key default gen_random_uuid(),
    receiver_device_id uuid not null references public.e2ee_devices(id) on delete cascade,
    sender_user_id uuid not null references public.profiles(id) on delete cascade,
    sender_device_id uuid not null references public.e2ee_devices(id) on delete cascade,
    message_type smallint not null check (message_type in (1, 3)),
    ciphertext text not null,
    client_message_id uuid,
    created_at timestamptz not null default timezone('utc', now()),
    delivered_at timestamptz,
    acked_at timestamptz
);

create index if not exists idx_e2ee_devices_user_id
    on public.e2ee_devices (user_id, created_at asc);

create index if not exists idx_e2ee_one_time_prekeys_device_claimed
    on public.e2ee_one_time_prekeys (device_id, claimed_at, created_at asc, key_id asc);

create index if not exists idx_e2ee_pending_messages_receiver_ack
    on public.e2ee_pending_messages (receiver_device_id, acked_at, created_at asc);

create unique index if not exists idx_e2ee_pending_messages_sender_client_message
    on public.e2ee_pending_messages (sender_device_id, client_message_id)
    where client_message_id is not null;

alter table public.e2ee_devices enable row level security;
alter table public.e2ee_one_time_prekeys enable row level security;
alter table public.e2ee_pending_messages enable row level security;

create or replace function public.handle_e2ee_devices_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists trg_e2ee_devices_updated_at on public.e2ee_devices;
create trigger trg_e2ee_devices_updated_at
before update on public.e2ee_devices
for each row
execute function public.handle_e2ee_devices_updated_at();

drop policy if exists "e2ee_devices_select_authenticated" on public.e2ee_devices;
create policy "e2ee_devices_select_authenticated"
on public.e2ee_devices
for select
to authenticated
using (true);

drop policy if exists "e2ee_devices_insert_self" on public.e2ee_devices;
create policy "e2ee_devices_insert_self"
on public.e2ee_devices
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "e2ee_devices_update_self" on public.e2ee_devices;
create policy "e2ee_devices_update_self"
on public.e2ee_devices
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "e2ee_devices_delete_self" on public.e2ee_devices;
create policy "e2ee_devices_delete_self"
on public.e2ee_devices
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "e2ee_one_time_prekeys_select_self" on public.e2ee_one_time_prekeys;
create policy "e2ee_one_time_prekeys_select_self"
on public.e2ee_one_time_prekeys
for select
to authenticated
using (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_one_time_prekeys.device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_one_time_prekeys_insert_self" on public.e2ee_one_time_prekeys;
create policy "e2ee_one_time_prekeys_insert_self"
on public.e2ee_one_time_prekeys
for insert
to authenticated
with check (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_one_time_prekeys.device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_one_time_prekeys_update_self" on public.e2ee_one_time_prekeys;
create policy "e2ee_one_time_prekeys_update_self"
on public.e2ee_one_time_prekeys
for update
to authenticated
using (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_one_time_prekeys.device_id
          and d.user_id = auth.uid()
    )
)
with check (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_one_time_prekeys.device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_one_time_prekeys_delete_self" on public.e2ee_one_time_prekeys;
create policy "e2ee_one_time_prekeys_delete_self"
on public.e2ee_one_time_prekeys
for delete
to authenticated
using (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_one_time_prekeys.device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_pending_messages_select_receiver" on public.e2ee_pending_messages;
create policy "e2ee_pending_messages_select_receiver"
on public.e2ee_pending_messages
for select
to authenticated
using (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_pending_messages.receiver_device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_pending_messages_insert_sender" on public.e2ee_pending_messages;
create policy "e2ee_pending_messages_insert_sender"
on public.e2ee_pending_messages
for insert
to authenticated
with check (
    sender_user_id = auth.uid()
    and exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_pending_messages.sender_device_id
          and d.user_id = auth.uid()
    )
);

drop policy if exists "e2ee_pending_messages_update_receiver" on public.e2ee_pending_messages;
create policy "e2ee_pending_messages_update_receiver"
on public.e2ee_pending_messages
for update
to authenticated
using (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_pending_messages.receiver_device_id
          and d.user_id = auth.uid()
    )
)
with check (
    exists (
        select 1
        from public.e2ee_devices d
        where d.id = e2ee_pending_messages.receiver_device_id
          and d.user_id = auth.uid()
    )
);
