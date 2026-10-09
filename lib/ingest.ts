import "server-only";

import { toFile } from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import { anthropic, FALLBACK_PARAMS, MODEL } from "@/lib/anthropic";
import {
  BlockedError,
  captureLink,
  captureLinkViaClaude,
  LinkError,
  type CapturedPage,
} from "@/lib/capture-link";
import type { DocumentRow } from "@/lib/types";

export const BUCKET = "documents";
const MAX_ATTEMPTS = 3;

export function documentFolder(doc: Pick<DocumentRow, "user_id" | "project_id" | "id">) {
  return `${doc.user_id}/${doc.project_id}/${doc.id}`;
}

const TRANSCRIBE_PROMPT = `Transcribe all visible text in this image to markdown, preserving its structure (headings, lists, tables). Then add a section titled "## Description" with one paragraph describing the image. Output only the transcription and description.`;

async function download(supabase: SupabaseClient, path: string) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw new Error(`Couldn't read the stored file: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function upload(
  supabase: SupabaseClient,
  path: string,
  body: string,
  contentType: string,
) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Couldn't store the extracted text: ${error.message}`);
}

async function countTextTokens(text: string) {
  const { input_tokens } = await anthropic().messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: text }],
  });
  return input_tokens;
}

async function processPdf(supabase: SupabaseClient, doc: DocumentRow) {
  const bytes = await download(supabase, doc.storage_path!);
  const file = await anthropic().files.upload({
    file: await toFile(bytes, `${doc.title ?? "document"}.pdf`, {
      type: "application/pdf",
    }),
  });
  // Token counting doesn't accept Files API sources, so count the bytes directly.
  const { input_tokens } = await anthropic().messages.countTokens({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: bytes.toString("base64"),
            },
          },
        ],
      },
    ],
  });
  return {
    anthropic_file_id: file.id,
    token_count: input_tokens,
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function processImage(supabase: SupabaseClient, doc: DocumentRow) {
  const bytes = await download(supabase, doc.storage_path!);
  const response = await anthropic().beta.messages.create({
    ...FALLBACK_PARAMS,
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: doc.media_type as "image/png",
              data: bytes.toString("base64"),
            },
          },
          { type: "text", text: TRANSCRIBE_PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to transcribe this image.");
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!text) throw new Error("No text could be read from this image.");

  const extractedPath = `${documentFolder(doc)}/extracted.md`;
  await upload(supabase, extractedPath, text, "text/markdown");
  return {
    extracted_path: extractedPath,
    token_count: await countTextTokens(text),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function processLink(supabase: SupabaseClient, doc: DocumentRow) {
  let page: CapturedPage;
  try {
    page = await captureLink(doc.source_url!);
  } catch (e) {
    if (!(e instanceof BlockedError)) throw e;
    page = await captureLinkViaClaude(doc.source_url!);
  }

  const folder = documentFolder(doc);
  const snapshotPath = page.html ? `${folder}/snapshot.html` : null;
  if (page.html) await upload(supabase, snapshotPath!, page.html, "text/html");
  await upload(supabase, `${folder}/extracted.md`, page.markdown, "text/markdown");
  return {
    title: page.title,
    source_url: page.finalUrl,
    suggested_links: page.links,
    captured_at: new Date().toISOString(),
    storage_path: snapshotPath,
    media_type: page.html ? "text/html" : null,
    extracted_path: `${folder}/extracted.md`,
    token_count: await countTextTokens(page.markdown),
    content_hash: createHash("sha256").update(page.markdown).digest("hex"),
  };
}

/**
 * Normalizes a queued document into something the chat can send to the model,
 * retrying up to three times before marking it failed. Runs with the user's
 * own Supabase client, so RLS applies to the worker too.
 */
export async function ingestDocument(supabase: SupabaseClient, documentId: string) {
  const { data: doc, error } = await supabase
    .from("documents")
    .update({ status: "processing", error: null })
    .eq("id", documentId)
    .select()
    .single<DocumentRow>();
  if (error || !doc) {
    console.error(`ingest ${documentId}: couldn't load document`, error);
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result =
        doc.source_type === "pdf"
          ? await processPdf(supabase, doc)
          : doc.source_type === "image"
            ? await processImage(supabase, doc)
            : await processLink(supabase, doc);

      await supabase
        .from("documents")
        .update({ ...result, status: "ready", error: null })
        .eq("id", doc.id);
      return;
    } catch (e) {
      lastError = e;
      console.error(`ingest ${doc.id}: attempt ${attempt} failed`, e);
      if (e instanceof LinkError) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }

  await supabase
    .from("documents")
    .update({ status: "failed", error: errorMessage(lastError) })
    .eq("id", doc.id);
}

function errorMessage(e: unknown) {
  if (!(e instanceof Error)) return "Processing failed.";
  // fetch() reports network problems as "fetch failed" with the reason in `cause`.
  if (e.cause instanceof Error) return `${e.message}: ${e.cause.message}`;
  return e.message;
}
