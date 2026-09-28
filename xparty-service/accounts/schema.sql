-- Run once in your own Supabase project's SQL editor. No email/phone data is copied here.
create table if not exists public.xparty_profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null check (length(display_name) between 1 and 24)
);
create table if not exists public.xparty_friends (
 id uuid primary key default gen_random_uuid(), requester uuid not null references public.xparty_profiles(id) on delete cascade,
 addressee uuid not null references public.xparty_profiles(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','accepted','declined')),
 created_at timestamptz not null default now(), check(requester<>addressee)
);
create unique index if not exists xparty_friend_pair on public.xparty_friends(least(requester,addressee),greatest(requester,addressee));
create table if not exists public.xparty_messages (
 id uuid primary key default gen_random_uuid(), sender uuid not null references public.xparty_profiles(id) on delete cascade,
 recipient uuid not null references public.xparty_profiles(id) on delete cascade,
 body text not null check(length(body) between 1 and 1500), created_at timestamptz not null default now()
);
create index if not exists xparty_message_pair on public.xparty_messages(sender,recipient,created_at);
create table if not exists public.xparty_calls (
 id uuid primary key default gen_random_uuid(), caller uuid not null references public.xparty_profiles(id) on delete cascade,
 callee uuid not null references public.xparty_profiles(id) on delete cascade,
 status text not null default 'ringing' check(status in ('ringing','accepted','ended')), created_at timestamptz not null default now(),check(caller<>callee)
);
create table if not exists public.xparty_signals (
 id bigint generated always as identity primary key, call_id uuid not null references public.xparty_calls(id) on delete cascade,
 sender uuid not null references public.xparty_profiles(id) on delete cascade,
 recipient uuid not null references public.xparty_profiles(id) on delete cascade,
 payload jsonb not null check(octet_length(payload::text)<65536),created_at timestamptz not null default now()
);
alter table public.xparty_profiles enable row level security;
alter table public.xparty_friends enable row level security;
alter table public.xparty_messages enable row level security;
alter table public.xparty_calls enable row level security;
alter table public.xparty_signals enable row level security;
create policy profile_read on public.xparty_profiles for select to authenticated using(id=auth.uid() or exists(select 1 from public.xparty_friends f where (f.requester=auth.uid() and f.addressee=xparty_profiles.id) or (f.addressee=auth.uid() and f.requester=xparty_profiles.id)));
create policy profile_insert on public.xparty_profiles for insert to authenticated with check(id=auth.uid());
create policy profile_update on public.xparty_profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy friend_read on public.xparty_friends for select to authenticated using(auth.uid() in(requester,addressee));
create policy friend_request on public.xparty_friends for insert to authenticated with check(requester=auth.uid() and status='pending');
create policy friend_answer on public.xparty_friends for update to authenticated using(addressee=auth.uid() and status='pending') with check(addressee=auth.uid() and status in('accepted','declined'));
create policy friend_delete on public.xparty_friends for delete to authenticated using(auth.uid() in(requester,addressee));
create policy message_read on public.xparty_messages for select to authenticated using(auth.uid() in(sender,recipient));
create policy message_send on public.xparty_messages for insert to authenticated with check(sender=auth.uid() and exists(select 1 from public.xparty_friends f where f.status='accepted' and ((f.requester=sender and f.addressee=recipient) or (f.requester=recipient and f.addressee=sender))));
create policy call_read on public.xparty_calls for select to authenticated using(auth.uid() in(caller,callee));
create policy call_start on public.xparty_calls for insert to authenticated with check(caller=auth.uid() and status='ringing' and exists(select 1 from public.xparty_friends f where f.status='accepted' and ((f.requester=caller and f.addressee=callee) or (f.requester=callee and f.addressee=caller))));
create policy call_change on public.xparty_calls for update to authenticated using(auth.uid() in(caller,callee)) with check((status='accepted' and callee=auth.uid()) or status='ended');
create policy signal_read on public.xparty_signals for select to authenticated using(recipient=auth.uid() and exists(select 1 from public.xparty_calls c where c.id=call_id and auth.uid() in(c.caller,c.callee)));
create policy signal_send on public.xparty_signals for insert to authenticated with check(sender=auth.uid() and exists(select 1 from public.xparty_calls c where c.id=call_id and c.status='accepted' and ((c.caller=sender and c.callee=recipient) or (c.callee=sender and c.caller=recipient))));
revoke all on public.xparty_profiles,public.xparty_friends,public.xparty_messages,public.xparty_calls,public.xparty_signals from anon,authenticated;
grant select,insert on public.xparty_profiles to authenticated;
grant update(display_name) on public.xparty_profiles to authenticated;
grant select,insert,delete on public.xparty_friends to authenticated;
grant update(status) on public.xparty_friends to authenticated;
grant select,insert on public.xparty_messages,public.xparty_signals to authenticated;
grant select,insert on public.xparty_calls to authenticated;
grant update(status) on public.xparty_calls to authenticated;
grant usage on sequence public.xparty_signals_id_seq to authenticated;
-- Schedule cleanup of xparty_signals older than one day in Supabase Cron before production.
-- OTP abuse limits, CAPTCHA, SMS/email quotas and backups are configured in the auth provider.

-- Revision 0.5 profile fields and self-service account deletion.
alter table public.xparty_profiles add column if not exists photo_data text
 check(photo_data is null or (length(photo_data)<100000 and photo_data like 'data:image/jpeg;base64,%'));
create table if not exists public.xparty_private_profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 age integer check(age between 18 and 120)
);
alter table public.xparty_private_profiles enable row level security;
create policy private_profile_owner on public.xparty_private_profiles for all to authenticated
 using(id=auth.uid()) with check(id=auth.uid());
grant select,insert,update,delete on public.xparty_private_profiles to authenticated;
grant update(photo_data) on public.xparty_profiles to authenticated;
create or replace function public.xparty_delete_my_account() returns void
 language plpgsql security definer set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 delete from auth.users where id=auth.uid();
end;
$$;
revoke all on function public.xparty_delete_my_account() from public,anon;
grant execute on function public.xparty_delete_my_account() to authenticated;
