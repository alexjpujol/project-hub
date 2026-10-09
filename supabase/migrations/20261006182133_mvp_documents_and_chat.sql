-- Project Hub MVP: project writes, documents, conversations, messages, and
-- the private storage bucket. Every table is scoped by user_id with RLS.

-- Projects: create, rename, archive ------------------------------------------

create policy "Users can create own projects"
on public.projects for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update own projects"
on public.projects for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Documents -------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_type text not null check (source_type in ('pdf', 'image', 'html', 'link', 'email')),
  title text,
  source_url text,              -- for links
  captured_at timestamptz,      -- when a link was snapshotted
  storage_path text,            -- original file (or HTML snapshot for links)
  media_type text,              -- MIME type of the original
  extracted_path text,          -- normalized markdown, for images and links
  anthropic_file_id text,       -- PDFs are uploaded once to the Files API
  page_count int,
  token_count int,              -- used to choose full-context vs retrieval
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'failed')),
  error text,
  content_hash text,
  created_at timestamptz not null default now()
);

create index documents_project_id_idx on public.documents (project_id, created_at);

alter table public.documents enable row level security;

create policy "Users can read own documents"
on public.documents for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can add documents to own projects"
on public.documents for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.projects p
    where p.id = project_id and p.user_id = (select auth.uid())
  )
);

create policy "Users can update own documents"
on public.documents for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete own documents"
on public.documents for delete
to authenticated
using ((select auth.uid()) = user_id);

-- Processing status updates reach the UI through Realtime.
alter publication supabase_realtime add table public.documents;

-- Conversations and messages ------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id) on delete cascade,  -- null = across all projects
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_ids uuid[] not null default '{}',  -- documents sent with the first question
  created_at timestamptz not null default now()
);

create index conversations_project_id_idx on public.conversations (project_id, created_at desc);

alter table public.conversations enable row level security;

create policy "Users can read own conversations"
on public.conversations for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create conversations in own projects"
on public.conversations for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and (
    project_id is null
    or exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = (select auth.uid())
    )
  )
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,       -- content blocks exactly as sent to / returned by the model
  citations jsonb,              -- resolved citations for display
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

create policy "Users can read own messages"
on public.messages for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can add messages to own conversations"
on public.messages for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = (select auth.uid())
  )
);

-- Storage ---------------------------------------------------------------------------
-- Files live at {user_id}/{project_id}/{document_id}/..., so the first path
-- segment decides ownership.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  33554432,  -- 32 MB, the Claude API's PDF request limit
  array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/html', 'text/markdown'
  ]
);

create policy "Users can read own files"
on storage.objects for select
to authenticated
using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can upload own files"
on storage.objects for insert
to authenticated
with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can update own files"
on storage.objects for update
to authenticated
using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can delete own files"
on storage.objects for delete
to authenticated
using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
