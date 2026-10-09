# Project Hub — Design Doc

Oct 5, 2026 · @Alex Pujol · Status: Draft

## Overview and goals

Project Hub is a personal app where you create a project, add the materials for it (PDFs, screenshots, web pages, links), and later ask questions that come back with an answer and a citation to the exact source. Example: in a "2026 Summer Camps" project, "When is registration for Camp Jeff due?" returns the date and links to page 2 of the Camp Jeff brochure.

**Goals**

- Capturing a document into a project takes under 10 seconds from desktop or phone.
- Every answer cites its source: document, page or region, and capture date for web pages.
- Deadlines, costs and dates are pulled out at ingest, so you can ask "what's due soon?" across all projects and get reminders.
- The app stays cheap and simple enough for one person to run.

**Non-goals for v1**

- General chat or web research outside the project's materials.
- Real-time collaborative editing. Sharing a project with a spouse is a v2 question.
- Mobile apps from the app stores. A responsive web app plus a share target covers v1.

**Why not just use Claude Projects?** It already handles uploading files and asking questions about them. Project Hub has to set itself apart on the gaps: dated snapshots of web pages, page-level citations you can click, a structured view of deadlines across projects with reminders, and quick capture (share sheet, forwarded email).

## User stories and MVP scope

The MVP is just upload, ask, and get a cited answer. Everything else waits until that works well on real camp documents.

| # | As a user, I want to… | Release |
| --- | --- | --- |
| 1 | Create, rename and archive projects | MVP |
| 2 | Upload PDFs and images by dragging them in | MVP |
| 3 | Save a link and have the page captured as it looked that day | MVP |
| 4 | Ask a question in a project and get an answer with clickable citations | MVP |
| 5 | See each document's processing status (queued, processing, ready, failed) | MVP |
| 6 | Open a citation and land on the right page, with the passage highlighted | v1.1 |
| 7 | See extracted deadlines, costs and dates for a project in one list | v1.1 |
| 8 | Ask "what's due in the next two weeks?" across all projects | v1.1 |
| 9 | Get an email or push reminder before a deadline | v1.2 |
| 10 | Forward an email, or use the phone share sheet, to add something to a project | v1.2 |
| 11 | Refresh a saved link and see what changed | v2 |
| 12 | Share a project with a family member | v2 |

## Architecture

A React app on top of Supabase, with two server-side pieces: an ingestion worker that processes uploads, and a chat API that runs the agent loop. Both call the model APIs directly. No LangChain.

&#91;embedded content: System architecture · 2 services on Supabase\]

Uploads go straight to Storage and enqueue a job. The worker writes chunks and facts back to Postgres. Questions go to the Chat API, which queries Postgres and calls the model.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React + TypeScript (Next.js or Vite), Vercel AI SDK for streaming | Your core stack, and streaming chat UI comes built in |
| Auth, DB, files | Supabase: Auth, Postgres with pgvector, Storage, Realtime | One service, with row-level security for per-user isolation |
| Background jobs | Supabase Queues (pgmq) + a Node worker, or Inngest/Trigger.dev | Big PDFs and vision calls run past Edge Function time limits |
| Agent | A plain tool-calling loop in TypeScript | About 50 lines you can debug; LangGraph later only if needed |
| Models | Claude for chat, vision and extraction; a separate embeddings model | Built-in PDF and citation support, and prompt caching |
| Observability | Langfuse or LangSmith tracing | See every tool call and retrieval when an answer is wrong |

## Data model

Seven Postgres tables, each scoped by `user_id`, with row-level security on every one. Original files live in Supabase Storage at `{user_id}/{project_id}/{document_id}/original.*`. Extracted text and page images sit next to them.

```sql
create extension if not exists vector;

create table projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  name text not null,
  description text,            -- also used as context for the agent
  archived_at timestamptz,
  created_at timestamptz default now()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null,
  source_type text not null check (source_type in ('pdf','image','html','link','email')),
  title text,
  source_url text,              -- for links
  captured_at timestamptz,      -- when a link was snapshotted
  storage_path text,            -- original file
  extracted_path text,          -- normalized markdown
  page_count int,
  token_count int,              -- used to choose full-context vs retrieval
  status text not null default 'queued', -- queued|processing|ready|failed
  error text,
  content_hash text,            -- dedupe and change detection on refresh
  created_at timestamptz default now()
);

create table chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents on delete cascade,
  project_id uuid not null,
  user_id uuid not null,
  ordinal int not null,
  page int,                     -- 1-based page for PDFs
  locator jsonb,                -- bbox, css selector or char range for highlighting
  content text not null,
  embedding vector(1024),
  fts tsvector generated always as (to_tsvector('english', content)) stored
);
create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks using gin (fts);

create table facts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  document_id uuid references documents on delete cascade,
  chunk_id uuid references chunks on delete set null,
  kind text not null,           -- deadline|event|cost|contact|requirement
  subject text,                 -- "Camp Jeff"
  label text not null,          -- "Registration due"
  date_value date,
  amount_cents int,
  quote text,                   -- source passage, shown with the fact
  confidence real,
  confirmed boolean default false
);

create table conversations (id uuid primary key default gen_random_uuid(), project_id uuid, user_id uuid not null, created_at timestamptz default now());
create table messages (id uuid primary key default gen_random_uuid(), conversation_id uuid references conversations on delete cascade, role text, content jsonb, citations jsonb, created_at timestamptz default now());
create table reminders (id uuid primary key default gen_random_uuid(), fact_id uuid references facts on delete cascade, user_id uuid not null, remind_at timestamptz not null, sent_at timestamptz);
```

A nullable `project_id` on `conversations` covers questions asked across all projects.

## Ingestion pipeline

Every source type ends up in the same shape: markdown text plus a locator for each passage, so the query layer never has to care where a document came from. Ingestion runs as a background job. An upload writes the `documents` row with status `queued` and enqueues a job, and the worker takes it from there.

1. **Normalize** by source type:
   - **PDF:** extract text page by page (`pdfjs` or `unpdf`). If a page has little text or a lot of layout (flyers, tables), render it to an image and have a vision model transcribe it to markdown.
   - **Image or screenshot:** a vision model returns a transcription of all visible text plus a one-paragraph description. Keep the original for display.
   - **Link:** fetch the page with a headless browser, extract the main content (Readability), and store the cleaned markdown, the raw HTML and a full-page screenshot. Set `captured_at`.
   - **HTML file:** same as a link, minus the fetch.
2. **Chunk** about 500–800 tokens with overlap, never across a page boundary. Each chunk keeps its page and locator.
3. **Embed** chunks in batches and write them to `chunks`. The full-text column fills itself.
4. **Extract facts:** one model call per document with a strict JSON schema (see Fact extraction).
5. **Finish:** set `token_count` and status `ready`, and notify the UI through Supabase Realtime.

**Failures:** each step can be retried on its own. After three failures the document goes to `failed` with the error shown in the UI and a Retry button. A `content_hash` match skips reprocessing duplicates.

## Query and agent layer

Small projects send their full contents to the model. Large projects go through an agent that has search tools. Both paths return citations in the same format.

**Path A: full context** (project total `token_count` under about 120k tokens, which is most personal projects)

- Send every ready document as a document block with citations turned on, behind a prompt-cache breakpoint. Follow-up questions in the same project then cost a fraction of the first one.
- The model returns cited passages, which map back to `document_id` and page.

**Path B: agentic retrieval** (larger projects, or any question across all projects)

A plain tool-calling loop with a cap of 6 tool calls, no framework. Tools:

| Tool | Purpose |
| --- | --- |
| `list_documents(project_id)` | Titles, types, capture dates, page counts |
| `search(project_id?, query, k=8)` | Hybrid search: pgvector and full-text results merged with reciprocal rank fusion |
| `read_document(document_id, pages?)` | The full text of the pages around a hit, so the agent doesn't answer from a fragment |
| `get_facts(project_id?, kind?, from?, to?)` | Structured deadlines, costs and dates |

**Answer rules** (in the system prompt)

- Answer only from the project's materials. If the answer isn't there, say so and name the closest documents.
- Every factual claim needs a citation. For web pages, say "as of {captured\_at}".
- When sources disagree (say, an old and a new brochure), show both and prefer the newer one.

**Hybrid search** is a single Postgres function (`match_chunks`) that runs vector and keyword search in one statement and merges the results. Keyword search matters because people search by proper names ("Camp Jeff"), which embeddings handle poorly.

## Fact extraction and reminders

Structured facts are what set Project Hub apart from chat over documents. Every deadline in every project becomes something you can query and get reminded about.

- **Extraction:** after chunking, one model call per document returns JSON that must match a schema: `[{kind, subject, label, date, amount, quote, confidence}]`. The `quote` has to appear word for word in the source text, or the fact is dropped. That check is the main defense against made-up facts.
- **Review:** new facts show up in a per-project "Key dates" list, unconfirmed. One tap confirms, edits or dismisses a fact. Only confirmed facts, or facts with confidence of 0.8 or higher, create reminders.
- **Reminders:** a scheduled job (`pg_cron`, daily at 7am) creates `reminders` rows for confirmed deadlines at 7 days and 1 day before, then sends the due ones by email (Resend) and, later, web push.
- **Questions across projects:** "What's due in the next two weeks?" goes to `get_facts`, which is a SQL query rather than a search, so it's exact and cheap.
- **Relative dates** ("two weeks before the session starts") are resolved during extraction when the anchor date is in the same document. Otherwise they're stored with no date and flagged for review.

## Security, privacy and cost

The documents will include family information (children's names, medical forms for camps), so per-user isolation is enforced in the database, not in application code.

- **Isolation:** RLS on every table (`user_id = auth.uid()`), plus storage policies keyed on the path prefix. The worker uses the service role, but every query it runs filters by the job's `user_id`.
- **Model providers:** use API terms that don't train on your data. Keep API keys server-side only, in Edge Functions or the worker, never in the client.
- **Prompt injection:** captured web pages and documents are data, not instructions. The system prompt says so, and the tools are read-only, so a malicious page can't trigger any action.
- **Link fetching:** block private IP ranges and `file://` URLs to prevent server-side request forgery, and cap page size and timeouts.
- **Deletion:** deleting a document cascades to its chunks and facts and removes its files from storage.

**Cost** (rough, single user): Supabase's free tier, then $25/month on Pro once storage or usage grows. Model and embedding usage is a few dollars a month for a personal workload. Prompt caching on Path A keeps follow-up questions cheap. Set a monthly spending cap with the model provider.

## Milestones, open questions and risks

Build in four milestones. Each one ends with real use on actual camp documents before the next one starts.

1. **M1: Ask with citations.** Auth, projects, PDF and image upload, the ingestion worker, Path A (full context) with citations, and the chat UI. Exit test: 20 real questions about camps, at least 18 answered correctly with the right citation.
2. **M2: Links and scale.** Link capture with snapshots, chunking and embeddings, hybrid search, Path B (the agent loop), and a citation viewer that highlights the passage.
3. **M3: Facts and reminders.** Fact extraction, the Key dates view, questions across projects, and email reminders.
4. **M4: Capture.** Forwarding email to an inbound address, a PWA share target, and refreshing links with a diff.

**Open questions**

- [ ] Next.js on Vercel, or Vite plus Supabase Edge Functions only? This decides where the agent loop runs.
- [ ] Worker host: Inngest/Trigger.dev, or a small Node service (Fly.io or Railway) that reads from Supabase Queues?
- [ ] Embedding model and dimension: decide before M2, because changing it later means re-embedding everything.
- [ ] Should projects be shareable with a spouse in v2? If so, use a `project_members` table now instead of a `user_id` on every row.

**Risks**

- **Answer quality on messy flyers:** mitigate by sending layout-heavy pages to a vision model, and track it with the M1 exit test as a regression set.
- **Wrong extracted dates:** mitigated by requiring an exact quote and confirming before any reminder is created.
- **Scope creep into a general notes app:** hold to the non-goals, and test each feature against "does this help answer or remind?"
