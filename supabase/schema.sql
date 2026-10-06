-- =====================================================================
-- CHATBOT COMERCIAL | eunicedesigner
-- Cole este arquivo inteiro no Supabase: SQL Editor > New query > Run
-- Pode ser executado mais de uma vez sem quebrar (idempotente).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 0. ADMINISTRADORES
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 1. CONFIGURACOES DO CHATBOT (uma unica linha)
-- ---------------------------------------------------------------------
create table if not exists public.chatbot_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  bot_name text not null default 'Eunice',
  bot_photo_url text,
  welcome_message text not null default 'Olá! Sou o assistente da Eunice. Me conta o que você precisa e eu mostro as opções disponíveis.',
  fallback_message text not null default 'Desculpe, não tenho essa informação disponível na minha base de atendimento. Essa é uma informação que somente a profissional poderá confirmar.',
  whatsapp_link text,                   -- link completo gerado pela profissional (prioridade)
  whatsapp_number text,                 -- WHATSAPP_NUMBER (somente digitos, com DDI. Ex: 5575988212916)
  whatsapp_message text not null default 'Olá! Estava conversando com o assistente da Eunice e gostaria de falar sobre meu projeto.',
  notify_email text,                    -- privado: nao vai para o site
  silence_seconds int not null default 180 check (silence_seconds between 30 and 3600),
  retention_message text not null default E'Ainda está por aí? 😊\n\nCaso essas opções não sejam exatamente o que você procura, tenho outra condição especial para este tipo de projeto.',
  retention_final_message text not null default E'Ainda está por aí? 😊\n\nCaso essa opção também não seja exatamente o que você procura, posso deixar seu contato registrado para que você receba uma nova condição especial quando houver.',
  no_offer_message text not null default E'Ainda está por aí? 😊\n\nNo momento não tenho uma condição especial disponível para esse tipo de projeto. Se quiser, posso registrar seu contato e avisar caso apareça uma condição especial no futuro.',
  decline_message text not null default 'Que pena, como não tenho condições especiais agora, poderia deixar seu contato? Te contatamos em breve.',
  lead_consent_text text not null default 'Autorizo o contato da profissional pelos dados informados.',
  updated_at timestamptz not null default now()
);
insert into public.chatbot_settings (id) values (1) on conflict (id) do nothing;

-- (A visao publica public_chatbot_settings e criada na secao 4, junto com as permissoes por coluna)

-- ---------------------------------------------------------------------
-- 2. CATALOGO
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.category_terms (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  term text not null,
  is_ambiguous boolean not null default false,
  clarify_question text,
  clarify_options text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (category_id, term)
);
create index if not exists idx_terms_category on public.category_terms(category_id);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(12,2),
  image_url text,
  show_details boolean not null default true,
  related_terms text[] not null default '{}',
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_services_category on public.services(category_id) where active;

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  price numeric(12,2),
  description text,
  items jsonb not null default '[]'::jsonb,
  image_url text,
  show_details boolean not null default true,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_packages_category on public.packages(category_id) where active;

create table if not exists public.special_offers (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  show_details boolean not null default true,
  normal_price numeric(12,2),
  special_price numeric(12,2),
  valid_until date,
  condition_text text,
  display_text text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_offers_category on public.special_offers(category_id) where active;

create table if not exists public.knowledge_base (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  keywords text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.chatbot_settings add column if not exists whatsapp_link text;
alter table public.chatbot_settings add column if not exists decline_message text not null default 'Que pena, como não tenho condições especiais agora, poderia deixar seu contato? Te contatamos em breve.';
alter table public.packages       add column if not exists show_details boolean not null default true;
alter table public.services       add column if not exists show_details boolean not null default true;
alter table public.special_offers add column if not exists show_details boolean not null default true;

-- ---------------------------------------------------------------------
-- 3. ATENDIMENTO
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  session_token uuid not null default gen_random_uuid(),   -- segredo da sessao do visitante
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE','WAITING_USER','OFFER_SHOWN','RETENTION','LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED')),
  category_id uuid references public.categories(id) on delete set null,
  shown_items text,                    -- pacotes/servicos ja apresentados
  packages_shown_at timestamptz,
  offer_id uuid references public.special_offers(id) on delete set null,
  offer_shown_at timestamptz,
  retention_stage int not null default 0 check (retention_stage between 0 and 2), -- 0 nada, 1 oferta enviada, 2 encerrado
  last_retention_at timestamptz,
  last_user_message_at timestamptz,
  last_activity_at timestamptz not null default now(),
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_conv_status on public.conversations(status, retention_stage);
create index if not exists idx_conv_activity on public.conversations(last_activity_at desc);

create table if not exists public.messages (
  seq bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user','bot')),
  content text not null check (char_length(content) <= 4000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_conv on public.messages(conversation_id, seq);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  name text not null,
  phone text,
  email text,
  note text,
  category_id uuid references public.categories(id) on delete set null,
  category_name text,
  package_seen text,
  offer_shown text,
  origin text not null default 'chatbot',
  reason text not null default 'Interesse em oferta futura',
  consent boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_leads_category on public.leads(category_id, created_at desc);

create table if not exists public.uploaded_files (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_seq bigint,
  customer_name text,
  category_name text,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_files_conv on public.uploaded_files(conversation_id);

-- Fila de eventos para notificacao por e-mail (opcional, 100% gratuito)
create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create or replace function public.trg_notify() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_events(type, payload) values (tg_argv[0], to_jsonb(new));
  return new;
end $$;

drop trigger if exists trg_leads_notify on public.leads;
create trigger trg_leads_notify after insert on public.leads for each row execute function public.trg_notify('NEW_LEAD');
drop trigger if exists trg_files_notify on public.uploaded_files;
create trigger trg_files_notify after insert on public.uploaded_files for each row execute function public.trg_notify('NEW_FILE');

-- ---------------------------------------------------------------------
-- 4. RLS (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.admins              enable row level security;
alter table public.chatbot_settings    enable row level security;
alter table public.categories          enable row level security;
alter table public.category_terms      enable row level security;
alter table public.services            enable row level security;
alter table public.packages            enable row level security;
alter table public.special_offers      enable row level security;
alter table public.knowledge_base      enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.leads               enable row level security;
alter table public.uploaded_files      enable row level security;
alter table public.notification_events enable row level security;

-- Limpa policies antigas (permite reexecutar)
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname='public' and policyname like 'cb\_%' escape '\' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- Admin: acesso total em todas as tabelas
do $$ declare t text; begin
  foreach t in array array['chatbot_settings','categories','category_terms','services','packages',
    'special_offers','knowledge_base','conversations','messages','leads','uploaded_files','notification_events']
  loop
    execute format('create policy cb_admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

create policy cb_admins_self on public.admins for select to authenticated using (user_id = auth.uid());

-- Publico (visitantes): leitura apenas do catalogo ATIVO
create policy cb_public_categories on public.categories for select to anon, authenticated using (active);
create policy cb_public_terms      on public.category_terms for select to anon, authenticated using (true);
create policy cb_public_services   on public.services for select to anon, authenticated using (active);
create policy cb_public_packages   on public.packages for select to anon, authenticated using (active);
create policy cb_public_offers     on public.special_offers for select to anon, authenticated
  using (active and (valid_until is null or valid_until >= current_date));
create policy cb_public_kb         on public.knowledge_base for select to anon, authenticated using (active);

-- Conversas, mensagens, leads, arquivos: SEM policy para anon.
-- Visitantes so acessam via funcoes RPC abaixo, protegidas pelo session_token.
revoke all on public.chatbot_settings, public.conversations, public.messages, public.leads,
  public.uploaded_files, public.notification_events, public.admins from anon;
-- Visitante le SOMENTE estas colunas da configuracao (notify_email fica privado)
grant select (id, enabled, bot_name, bot_photo_url, welcome_message, fallback_message,
              whatsapp_number, whatsapp_link, whatsapp_message, silence_seconds, lead_consent_text, decline_message)
  on public.chatbot_settings to anon;
create policy cb_public_settings on public.chatbot_settings for select to anon using (true);
drop view if exists public.public_chatbot_settings;
create view public.public_chatbot_settings with (security_invoker = true) as
  select id, enabled, bot_name, bot_photo_url, welcome_message, fallback_message,
         whatsapp_number, whatsapp_link, whatsapp_message, silence_seconds, lead_consent_text, decline_message
  from public.chatbot_settings;
grant select on public.public_chatbot_settings to anon, authenticated;
revoke all on function public.trg_notify() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. FUNCOES (RPC) DO ATENDIMENTO
-- ---------------------------------------------------------------------
create or replace function public._lock_conv(p_id uuid, p_token uuid)
returns public.conversations language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  select * into c from public.conversations where id = p_id and session_token = p_token for update;
  if not found then raise exception 'conversa invalida' using errcode = '28000'; end if;
  return c;
end $$;

create or replace function public.chat_start(p_ua text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  insert into public.conversations(user_agent) values (left(p_ua, 300)) returning * into c;
  return jsonb_build_object('id', c.id, 'token', c.session_token);
end $$;

create or replace function public.chat_post(
  p_id uuid, p_token uuid, p_role text, p_content text, p_meta jsonb default '{}'::jsonb,
  p_category_id uuid default null, p_shown_items text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare c public.conversations; v_seq bigint; v_status text;
begin
  if p_role not in ('user','bot') then raise exception 'role invalido'; end if;
  if p_content is null or char_length(trim(p_content)) = 0 then raise exception 'mensagem vazia'; end if;
  c := public._lock_conv(p_id, p_token);

  insert into public.messages(conversation_id, role, content, meta)
  values (p_id, p_role, left(p_content, 4000), coalesce(p_meta, '{}'::jsonb))
  returning seq into v_seq;

  v_status := c.status;
  if p_role = 'user' then
    if v_status not in ('LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED') then v_status := 'ACTIVE'; end if;
    update public.conversations set last_user_message_at = now(), last_activity_at = now(), status = v_status,
      category_id = coalesce(p_category_id, category_id) where id = p_id;
  else
    if p_shown_items is not null then
      if v_status not in ('LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED','OFFER_SHOWN','RETENTION') then v_status := 'WAITING_USER'; end if;
      update public.conversations set packages_shown_at = now(), shown_items = left(p_shown_items, 500),
        status = v_status, last_activity_at = now(), category_id = coalesce(p_category_id, category_id) where id = p_id;
    else
      update public.conversations set last_activity_at = now() where id = p_id;
    end if;
  end if;
  return v_seq;
end $$;

-- Nucleo da retencao. Chamada sempre com a linha da conversa TRAVADA (sem duplicar mensagens).
create or replace function public._apply_retention(c public.conversations, p_force boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare s public.chatbot_settings; o public.special_offers; v_btn jsonb;
begin
  if c.status in ('LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED') or c.retention_stage >= 2 then return false; end if;
  select * into s from public.chatbot_settings where id = 1;

  if not p_force then
    if c.packages_shown_at is null then return false; end if;
    if now() - greatest(coalesce(c.last_user_message_at, c.created_at), c.packages_shown_at, c.last_retention_at)
       < make_interval(secs => s.silence_seconds) then return false; end if;
  end if;

  v_btn := jsonb_build_array(
    jsonb_build_object('label','Falar com a profissional','action','whatsapp'),
    jsonb_build_object('label','Deixar meu contato','action','lead'));

  if c.retention_stage = 0 then
    select * into o from public.special_offers
      where active and category_id = c.category_id and c.category_id is not null
        and (valid_until is null or valid_until >= current_date)
      order by created_at desc limit 1;
    if found then
      insert into public.messages(conversation_id, role, content, meta) values (c.id, 'bot', s.retention_message,
        jsonb_build_object('type','retention','buttons', v_btn,
          'cards', jsonb_build_array(jsonb_build_object('kind','offer','name',o.name,'description',o.description,
            'image_url',o.image_url,'show_details',o.show_details,'normal_price',o.normal_price,'special_price',o.special_price,
            'condition_text',o.condition_text,'display_text',o.display_text,'valid_until',o.valid_until))));
      update public.conversations set retention_stage = 1, offer_id = o.id, offer_shown_at = now(),
        last_retention_at = now(), status = 'OFFER_SHOWN', last_activity_at = now() where id = c.id;
    else
      insert into public.messages(conversation_id, role, content, meta)
        values (c.id, 'bot', s.no_offer_message, jsonb_build_object('type','retention','buttons', v_btn));
      update public.conversations set retention_stage = 2, last_retention_at = now(),
        status = 'RETENTION', last_activity_at = now() where id = c.id;
    end if;
  else
    insert into public.messages(conversation_id, role, content, meta)
      values (c.id, 'bot', s.retention_final_message, jsonb_build_object('type','retention','buttons', v_btn));
    update public.conversations set retention_stage = 2, last_retention_at = now(),
      status = 'RETENTION', last_activity_at = now() where id = c.id;
  end if;
  return true;
end $$;

-- Desistencia explicita ("achei caro", "vou pensar"...)
create or replace function public.chat_retention(p_id uuid, p_token uuid, p_force boolean default true)
returns boolean language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  c := public._lock_conv(p_id, p_token);
  return public._apply_retention(c, p_force);
end $$;

-- Sincroniza: aplica abandono por silencio (se for o caso) e devolve mensagens novas
create or replace function public.chat_poll(p_id uuid, p_token uuid, p_since bigint default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.conversations; v_msgs jsonb;
begin
  c := public._lock_conv(p_id, p_token);
  perform public._apply_retention(c, false);
  select * into c from public.conversations where id = p_id;
  select coalesce(jsonb_agg(jsonb_build_object('seq', seq, 'role', role, 'content', content, 'meta', meta, 'created_at', created_at) order by seq), '[]'::jsonb)
    into v_msgs from public.messages where conversation_id = p_id and seq > p_since;
  return jsonb_build_object('status', c.status, 'stage', c.retention_stage, 'category_id', c.category_id,
    'packages_shown', c.packages_shown_at is not null, 'messages', v_msgs);
end $$;

create or replace function public.chat_set_status(p_id uuid, p_token uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  if p_status not in ('WHATSAPP_REDIRECTED','CLOSED') then raise exception 'status nao permitido'; end if;
  c := public._lock_conv(p_id, p_token);
  update public.conversations set status = p_status, last_activity_at = now() where id = p_id;
end $$;

create or replace function public.chat_save_lead(
  p_id uuid, p_token uuid, p_name text, p_phone text, p_email text, p_note text, p_consent boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.conversations; v_cat text; v_offer text; v_id uuid; v_digits text;
begin
  c := public._lock_conv(p_id, p_token);
  if p_consent is not true then raise exception 'consentimento obrigatorio'; end if;
  if p_name is null or char_length(trim(p_name)) < 2 then raise exception 'nome invalido'; end if;
  v_digits := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if char_length(v_digits) < 10 then raise exception 'whatsapp invalido'; end if;
  if p_email is not null and p_email <> '' and p_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email invalido'; end if;

  select name into v_cat from public.categories where id = c.category_id;
  select name into v_offer from public.special_offers where id = c.offer_id;

  insert into public.leads(conversation_id, name, phone, email, note, category_id, category_name, package_seen, offer_shown, consent)
  values (p_id, left(trim(p_name),120), left(v_digits,20), nullif(left(trim(coalesce(p_email,'')),160),''),
          nullif(left(trim(coalesce(p_note,'')),1000),''), c.category_id, v_cat, c.shown_items, v_offer, true)
  returning id into v_id;

  update public.conversations set status = 'LEAD_CAPTURED', last_activity_at = now() where id = p_id;
  return v_id;
end $$;

create or replace function public.chat_register_file(
  p_id uuid, p_token uuid, p_name text, p_mime text, p_size bigint, p_path text)
returns bigint language plpgsql security definer set search_path = public as $$
declare c public.conversations; v_cat text; v_lead text; v_seq bigint;
begin
  c := public._lock_conv(p_id, p_token);
  if left(p_path, 37) <> p_id::text || '/' then raise exception 'caminho invalido'; end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then raise exception 'tamanho invalido'; end if;
  select name into v_cat from public.categories where id = c.category_id;
  select name into v_lead from public.leads where conversation_id = p_id order by created_at desc limit 1;

  insert into public.messages(conversation_id, role, content, meta)
  values (p_id, 'user', '📎 ' || left(p_name, 200), jsonb_build_object('type','file'))
  returning seq into v_seq;

  insert into public.uploaded_files(conversation_id, message_seq, customer_name, category_name, file_name, mime_type, size_bytes, storage_path)
  values (p_id, v_seq, v_lead, v_cat, left(p_name, 200), left(p_mime, 120), p_size, p_path);

  update public.conversations set last_user_message_at = now(), last_activity_at = now() where id = p_id;
  return v_seq;
end $$;

-- Varredura global (opcional, usada pelo pg_cron). Atualiza conversas abandonadas
-- mesmo que o visitante tenha fechado a pagina.
create or replace function public.chat_mark_declined(p_id uuid, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  c := public._lock_conv(p_id, p_token);
  update public.conversations
     set retention_stage = 2,
         status = case when status in ('LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED') then status else 'RETENTION' end,
         last_retention_at = now(), last_activity_at = now()
   where id = p_id;
end $$;
revoke all on function public.chat_mark_declined(uuid, uuid) from public;
grant execute on function public.chat_mark_declined(uuid, uuid) to anon, authenticated;

create or replace function public.chat_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare c public.conversations; n int := 0;
begin
  for c in select * from public.conversations
           where status not in ('LEAD_CAPTURED','WHATSAPP_REDIRECTED','CLOSED') and retention_stage < 2
             and packages_shown_at is not null and last_activity_at > now() - interval '2 days'
           for update skip locked
  loop
    if public._apply_retention(c, false) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Verifica se a pasta do upload pertence a uma conversa real e recente
create or replace function public.conversation_exists(p_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations where id::text = p_id and created_at > now() - interval '3 days');
$$;

-- Permissoes das funcoes
revoke all on function public._lock_conv(uuid, uuid) from public, anon, authenticated;
revoke all on function public._apply_retention(public.conversations, boolean) from public, anon, authenticated;
revoke all on function public.chat_sweep() from public, anon, authenticated;
grant execute on function public.chat_start(text) to anon, authenticated;
grant execute on function public.chat_post(uuid, uuid, text, text, jsonb, uuid, text) to anon, authenticated;
grant execute on function public.chat_retention(uuid, uuid, boolean) to anon, authenticated;
grant execute on function public.chat_poll(uuid, uuid, bigint) to anon, authenticated;
grant execute on function public.chat_set_status(uuid, uuid, text) to anon, authenticated;
grant execute on function public.chat_save_lead(uuid, uuid, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.chat_register_file(uuid, uuid, text, text, bigint, text) to anon, authenticated;
grant execute on function public.conversation_exists(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. STORAGE
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('briefings', 'briefings', false, 10485760, array[
     'application/pdf','image/jpeg','image/png','image/webp','application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']),
  ('site-assets', 'site-assets', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists cb_briefings_insert on storage.objects;
drop policy if exists cb_briefings_admin_read on storage.objects;
drop policy if exists cb_briefings_admin_delete on storage.objects;
drop policy if exists cb_assets_admin_write on storage.objects;
drop policy if exists cb_assets_public_read on storage.objects;

-- Visitante: apenas ENVIA (nao lista, nao le) dentro da pasta da propria conversa
create policy cb_briefings_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'briefings' and public.conversation_exists((storage.foldername(name))[1]));
-- Somente admin le/baixa/apaga arquivos privados
create policy cb_briefings_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'briefings' and public.is_admin());
create policy cb_briefings_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'briefings' and public.is_admin());
-- Imagens do catalogo (publicas) so o admin altera
create policy cb_assets_public_read on storage.objects for select to anon, authenticated using (bucket_id = 'site-assets');
create policy cb_assets_admin_write on storage.objects for all to authenticated
  using (bucket_id = 'site-assets' and public.is_admin()) with check (bucket_id = 'site-assets' and public.is_admin());

-- ---------------------------------------------------------------------
-- 7. DADOS INICIAIS (somente categorias e termos; NENHUM preco)
-- ---------------------------------------------------------------------
insert into public.categories (name, slug, sort) values
  ('Identidade Visual', 'identidade-visual', 1),
  ('Anúncios / Peças Gráficas', 'anuncios-pecas-graficas', 2),
  ('Web / Landing Page', 'web-landing-page', 3),
  ('Automação / Soluções Digitais', 'automacao-solucoes-digitais', 4)
on conflict (slug) do nothing;

insert into public.category_terms (category_id, term)
select c.id, t.term from public.categories c
join (values
  ('identidade-visual','logo'),('identidade-visual','logos'),('identidade-visual','logotipo'),('identidade-visual','logomarca'),
  ('identidade-visual','identidade'),('identidade-visual','identidade visual'),('identidade-visual','brand'),
  ('identidade-visual','branding'),('identidade-visual','criar uma marca'),('identidade-visual','criar logo'),
  ('identidade-visual','fazer logo'),('identidade-visual','preciso de uma identidade'),
  ('anuncios-pecas-graficas','arte'),('anuncios-pecas-graficas','artes'),('anuncios-pecas-graficas','card'),
  ('anuncios-pecas-graficas','cards'),('anuncios-pecas-graficas','post'),('anuncios-pecas-graficas','posts'),
  ('anuncios-pecas-graficas','postagem'),('anuncios-pecas-graficas','banner'),('anuncios-pecas-graficas','anuncio'),
  ('anuncios-pecas-graficas','anuncios'),('anuncios-pecas-graficas','social media'),
  ('anuncios-pecas-graficas','arte para instagram'),('anuncios-pecas-graficas','arte para facebook'),
  ('anuncios-pecas-graficas','redes sociais'),('anuncios-pecas-graficas','imagem para anuncio'),
  ('web-landing-page','site'),('web-landing-page','sites'),('web-landing-page','pagina'),
  ('web-landing-page','landing'),('web-landing-page','landing page'),('web-landing-page','pagina de vendas'),
  ('web-landing-page','pagina de captura'),('web-landing-page','site de uma pagina'),
  ('web-landing-page','pagina para anuncio'),('web-landing-page','colocar meu site no ar'),
  ('automacao-solucoes-digitais','automacao'),('automacao-solucoes-digitais','automatizar'),
  ('automacao-solucoes-digitais','chatbot'),('automacao-solucoes-digitais','sistema'),
  ('automacao-solucoes-digitais','formulario automatico'),('automacao-solucoes-digitais','agendamento'),
  ('automacao-solucoes-digitais','integracao'),('automacao-solucoes-digitais','ferramenta'),
  ('automacao-solucoes-digitais','aplicativo'),('automacao-solucoes-digitais','app'),('automacao-solucoes-digitais','painel')
) as t(slug, term) on t.slug = c.slug
on conflict do nothing;

-- Termo ambiguo de exemplo: "marca" pergunta se e logotipo ou identidade visual
insert into public.category_terms (category_id, term, is_ambiguous, clarify_question, clarify_options)
select id, 'marca', true, 'Você está procurando apenas a criação do logotipo ou uma Identidade Visual completa?',
       array['Logotipo','Identidade Visual']
from public.categories where slug = 'identidade-visual'
on conflict (category_id, term) do nothing;

-- ---------------------------------------------------------------------
-- 8. (OPCIONAL) ABANDONO POR SILENCIO MESMO COM A PAGINA FECHADA
-- Ative em Database > Extensions > pg_cron e rode a linha abaixo:
--   select cron.schedule('chat-sweep', '* * * * *', 'select public.chat_sweep()');
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 9. DEPOIS DE CRIAR SEU USUARIO EM Authentication > Users, rode (troque o e-mail):
--   insert into public.admins(user_id) select id from auth.users where email = 'SEU-EMAIL@exemplo.com';
-- ---------------------------------------------------------------------
