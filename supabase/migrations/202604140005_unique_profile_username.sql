update public.profiles
set username = nullif(lower(trim(username)), '')
where username is not null;

create unique index if not exists idx_profiles_username_lower_unique
    on public.profiles (lower(username))
    where username is not null;
