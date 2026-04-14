alter table public.profiles
    add column if not exists phone_e164 text;

update public.profiles profiles
set phone_e164 = users.phone
from auth.users users
where users.id = profiles.id
  and profiles.phone_e164 is null
  and users.phone is not null;

alter table public.profiles
    alter column username drop not null;

create unique index if not exists idx_profiles_phone_e164
    on public.profiles (phone_e164);

alter table public.chats
    add column if not exists dm_key text;

create unique index if not exists idx_chats_dm_key
    on public.chats (dm_key);

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
