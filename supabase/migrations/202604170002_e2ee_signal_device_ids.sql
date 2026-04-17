create sequence if not exists public.e2ee_signal_device_id_seq;

alter table public.e2ee_devices
add column if not exists signal_device_id integer;

alter table public.e2ee_devices
alter column signal_device_id set default nextval('public.e2ee_signal_device_id_seq');

update public.e2ee_devices
set signal_device_id = nextval('public.e2ee_signal_device_id_seq')
where signal_device_id is null;

alter table public.e2ee_devices
alter column signal_device_id set not null;

create unique index if not exists idx_e2ee_devices_signal_device_id
    on public.e2ee_devices (signal_device_id);
