# Project Hub

Create a project, add its materials (PDFs, screenshots, web pages), and ask questions that come back with answers citing the exact source. See `Project Hub — Design Doc.md` for the full design.

## Setup

1. Add these to `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
   ANTHROPIC_API_KEY=...
   ```

2. Apply the database migrations (tables, RLS policies, the `documents` storage bucket, Realtime):

   ```sh
   npx supabase db push
   ```

3. Run the app:

   ```sh
   yarn dev
   ```

## How it works (v1)

- **Uploads** go from the browser straight to Supabase Storage at `{user_id}/{project_id}/{document_id}/`. A Server Action records the document and processes it with `after()`, retrying up to three times:
  - **PDF:** uploaded once to the Claude Files API, then token-counted.
  - **Image:** transcribed to markdown by Claude's vision.
  - **Link:** fetched with SSRF protection (public addresses only, checked at connect time), main content extracted with Readability. The raw HTML snapshot and the extracted markdown are both stored.
- **Status** updates reach the document list through Supabase Realtime.
- **Questions** (`app/api/chat/route.ts`) send every ready document with citations enabled and a prompt-cache breakpoint (Path A). Answers stream back, and citations link to the source page. A conversation keeps the documents it started with, so documents added later are included when you start a new conversation.
- Projects over 120k tokens are refused for now. Retrieval (Path B) is milestone M2.
