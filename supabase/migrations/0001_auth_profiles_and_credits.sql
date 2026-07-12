-- AI Video Platform
-- 迁移 0001：账号资料与积分账户安全骨架
-- 执行位置：Supabase Dashboard -> SQL Editor
-- 注意：本文件不包含任何密钥，不需要 service_role key。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.credit_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 100 check (balance >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  transaction_type text not null check (
    transaction_type in (
      'signup_bonus',
      'generation_charge',
      'generation_refund',
      'purchase',
      'admin_adjustment'
    )
  ),
  description text,
  reference_id uuid,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists credit_transactions_user_id_created_at_idx
  on public.credit_transactions(user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_credit_accounts_updated_at on public.credit_accounts;
create trigger set_credit_accounts_updated_at
before update on public.credit_accounts
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (id) do nothing;

  insert into public.credit_accounts (user_id, balance)
  values (new.id, 100)
  on conflict (user_id) do nothing;

  insert into public.credit_transactions (
    user_id,
    amount,
    transaction_type,
    description
  )
  select
    new.id,
    100,
    'signup_bonus',
    '新用户注册初始积分'
  where not exists (
    select 1
    from public.credit_transactions existing
    where existing.user_id = new.id
      and existing.transaction_type = 'signup_bonus'
      and existing.reference_id is null
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_transactions enable row level security;

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.credit_accounts from anon, authenticated;
revoke insert, update, delete on public.credit_transactions from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.credit_accounts to authenticated;
grant select on public.credit_transactions to authenticated;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "profiles_update_own_display_name" on public.profiles;
create policy "profiles_update_own_display_name"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "credit_accounts_select_own" on public.credit_accounts;
create policy "credit_accounts_select_own"
on public.credit_accounts
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "credit_transactions_select_own" on public.credit_transactions;
create policy "credit_transactions_select_own"
on public.credit_transactions
for select
to authenticated
using ((select auth.uid()) = user_id);
