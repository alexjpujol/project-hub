"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { anthropic } from "@/lib/anthropic";
import { requireUserId } from "@/lib/auth";
import { parsePublicUrl } from "@/lib/capture-link";
import { BUCKET, documentFolder, ingestDocument } from "@/lib/ingest";
import type { SuggestedLink } from "@/lib/links";
import { createClient } from "@/lib/supabase/server";
import type { DocumentRow, SourceType } from "@/lib/types";

export type ActionResult = { error?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Projects ---------------------------------------------------------------------

export async function createProject(formData: FormData) {
  const supabase = await createClient();
  await requireUserId(supabase);

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!name) return;

  const { data, error } = await supabase
    .from("projects")
    .insert({ name, description })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  redirect(`/projects/${data.id}`);
}

export async function updateProject(
  projectId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient();
  await requireUserId(supabase);

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!name) return { error: "A project needs a name." };

  const { error } = await supabase
    .from("projects")
    .update({ name, description })
    .eq("id", projectId);
  if (error) return { error: error.message };

  refresh();
  return {};
}

export async function setProjectArchived(projectId: string, archived: boolean) {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { error } = await supabase
    .from("projects")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", projectId);
  if (error) throw new Error(error.message);

  refresh();
}

// Documents ------------------------------------------------------------------------

/** Records a file the browser already uploaded to Storage and starts processing it. */
export async function addUploadedDocument(input: {
  id: string;
  projectId: string;
  title: string;
  sourceType: Extract<SourceType, "pdf" | "image">;
  mediaType: string;
  storagePath: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const folder = documentFolder({
    user_id: userId,
    project_id: input.projectId,
    id: input.id,
  });
  if (
    !UUID.test(input.id) ||
    !UUID.test(input.projectId) ||
    !input.storagePath.startsWith(`${folder}/original.`) ||
    !["pdf", "image"].includes(input.sourceType)
  ) {
    return { error: "Invalid upload." };
  }

  const { error } = await supabase.from("documents").insert({
    id: input.id,
    project_id: input.projectId,
    source_type: input.sourceType,
    title: input.title,
    media_type: input.mediaType,
    storage_path: input.storagePath,
  });
  if (error) return { error: error.message };

  after(() => ingestDocument(supabase, input.id));
  return {};
}

export async function addLink(
  projectId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  return saveLink(projectId, String(formData.get("url") ?? ""));
}

/** Adds one of a captured page's suggested related pages. */
export async function addSuggestedLink(
  projectId: string,
  link: SuggestedLink,
): Promise<ActionResult> {
  return saveLink(projectId, link.url, link.text);
}

async function saveLink(
  projectId: string,
  input: string,
  title?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  await requireUserId(supabase);

  let url: URL;
  try {
    url = parsePublicUrl(input);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      project_id: projectId,
      source_type: "link",
      source_url: url.toString(),
      title: title?.slice(0, 200) || url.hostname,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  after(() => ingestDocument(supabase, data.id));
  return {};
}

export async function retryDocument(documentId: string) {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { error } = await supabase
    .from("documents")
    .update({ status: "queued", error: null })
    .eq("id", documentId);
  if (error) throw new Error(error.message);

  after(() => ingestDocument(supabase, documentId));
}

/** Deletes a document, its stored files, and its copy in the Files API. */
export async function deleteDocument(documentId: string) {
  const supabase = await createClient();
  await requireUserId(supabase);

  const { data: doc, error } = await supabase
    .from("documents")
    .select()
    .eq("id", documentId)
    .single<DocumentRow>();
  if (error || !doc) throw new Error(error?.message ?? "Document not found.");

  const folder = documentFolder(doc);
  const { data: files } = await supabase.storage.from(BUCKET).list(folder);
  if (files?.length) {
    await supabase.storage
      .from(BUCKET)
      .remove(files.map((f) => `${folder}/${f.name}`));
  }
  if (doc.anthropic_file_id) {
    await anthropic()
      .files.delete(doc.anthropic_file_id)
      .catch((e) => console.error(`delete file ${doc.anthropic_file_id}`, e));
  }

  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);
  if (deleteError) throw new Error(deleteError.message);
}
