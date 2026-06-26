-- Excalidraw Sketsa — AI memory schema (Supabase / Postgres).
--
-- System of record for AI-generated artifacts: each row is ONE generation turn
-- (prompt + response + the scene at that moment). Raw markdown/text lives in
-- text columns; structured data (scene, validation meta) lives in jsonb.
--
-- Apply once: Supabase Dashboard -> SQL Editor -> paste -> Run. Or:
--   psql "$SUPABASE_DB_URL" -f deploy/memory/schema.sql
--
-- SECURITY MODEL: writes happen ONLY from the server-side `memory` container using
-- the Supabase SERVICE ROLE key (which bypasses RLS). The browser NEVER gets that
-- key and NEVER talks to Supabase directly. So we ENABLE RLS with NO public policy:
-- anon/authenticated roles get zero access; the service role still works. This is the
-- safe default — same posture as keeping the codex/claude auth + ai-proxy key
-- server-side.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ── One generation turn ────────────────────────────────────────────────────
create table if not exists public.ai_memory (
    id             uuid primary key default gen_random_uuid(),
    created_at     timestamptz not null default now(),

    backend        text not null check (backend in ('codex', 'claude', 'agy')),
    model          text,                        -- resolved model label, if any

    prompt         text not null,               -- the user's NL request
    response       text not null,               -- generated EA script / raw markdown

    scene_snapshot jsonb,                        -- serialized scene at generation time (optional)
    meta           jsonb not null default '{}'::jsonb,  -- {duration_ms, attempts, valid, error?}

    room_id        text,                         -- collab room id, if generated in a session
    tags           text[] not null default '{}'  -- vault-style labels for later organization
);

comment on table public.ai_memory is
    'One AI generation turn: prompt + response + scene snapshot. Written only by the server-side memory container (service role).';

-- Recent-first listing is the common query.
create index if not exists ai_memory_created_at_idx on public.ai_memory (created_at desc);
create index if not exists ai_memory_backend_idx    on public.ai_memory (backend);
create index if not exists ai_memory_tags_idx        on public.ai_memory using gin (tags);
-- Full-text over prompt + response (Indonesian + simple fallback handled at query time).
create index if not exists ai_memory_fts_idx on public.ai_memory
    using gin (to_tsvector('simple', coalesce(prompt, '') || ' ' || coalesce(response, '')));

-- ── Large binary assets (image / audio / video) ───────────────────────────
-- We DON'T store blobs in Postgres. This table is a POINTER index: the bytes live
-- in Supabase Storage (recommended) or an rclone remote (gdrive). storage_kind says
-- which, storage_path is the key/path within it. Lets you swap blob backends later
-- without touching the memory rows.
create table if not exists public.ai_asset (
    id           uuid primary key default gen_random_uuid(),
    memory_id    uuid references public.ai_memory(id) on delete cascade,
    created_at   timestamptz not null default now(),

    kind         text not null check (kind in ('image', 'audio', 'video')),
    storage_kind text not null default 'supabase' check (storage_kind in ('supabase', 'gdrive')),
    storage_path text not null,                  -- object key (supabase) or remote path (rclone)
    mime         text,
    bytes        bigint
);

create index if not exists ai_asset_memory_id_idx on public.ai_asset (memory_id);

-- ── RLS: lock everyone out except the service role ─────────────────────────
alter table public.ai_memory enable row level security;
alter table public.ai_asset  enable row level security;
-- Intentionally NO policies created -> anon/authenticated = denied; service role bypasses RLS.
