import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ProjectHeader } from "@/components/project-header";
import { ProjectWorkspace } from "@/components/project-workspace";
import { requireUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AnswerBlock, ChatMessage, DocumentRow, Project } from "@/lib/types";

// Document processing runs after the upload action responds, within this limit.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading project…</p>}>
      <ProjectContent params={params} />
    </Suspense>
  );
}

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: { type: string; text?: string }[];
  citations: AnswerBlock[] | null;
};

async function ProjectContent({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!UUID.test(projectId)) notFound();

  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, description, archived_at, created_at")
    .eq("id", projectId)
    .maybeSingle<Project>();
  if (!project) notFound();

  const [{ data: documents }, { data: conversation }] = await Promise.all([
    supabase
      .from("documents")
      .select()
      .eq("project_id", projectId)
      .order("created_at")
      .returns<DocumentRow[]>(),
    supabase
      .from("conversations")
      .select("id, document_ids")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; document_ids: string[] }>(),
  ]);

  let messages: ChatMessage[] = [];
  if (conversation) {
    const { data: rows } = await supabase
      .from("messages")
      .select("id, role, content, citations")
      .eq("conversation_id", conversation.id)
      .order("created_at")
      .returns<MessageRow[]>();
    messages = (rows ?? []).map((row) =>
      row.role === "user"
        ? { id: row.id, role: "user", text: row.content.at(-1)?.text ?? "" }
        : { id: row.id, role: "assistant", blocks: row.citations ?? [] },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ProjectHeader project={project} />
      <ProjectWorkspace
        projectId={project.id}
        userId={userId}
        initialDocuments={documents ?? []}
        initialConversation={
          conversation
            ? {
                id: conversation.id,
                documentIds: conversation.document_ids,
                messages,
              }
            : null
        }
      />
    </div>
  );
}
