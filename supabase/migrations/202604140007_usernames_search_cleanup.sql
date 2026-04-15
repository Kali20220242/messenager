update public.profiles
set username = null
where username is not null
  and (
    trim(username) = ''
    or username = phone_e164
  );

update public.profiles
set username = lower(trim(username))
where username is not null;

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, phone_e164, display_name)
    values (
        new.id,
        case
            when new.phone is null then null
            else '+' || regexp_replace(new.phone, '\D', '', 'g')
        end,
        null
    )
    on conflict (id) do update
    set phone_e164 = excluded.phone_e164;

    return new;
end;
$$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
after insert on auth.users
for each row
execute function public.handle_auth_user_created();
