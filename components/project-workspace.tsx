"use client";

import { useCallback, useEffect, useState } from "react";

import { Chat, type ConversationState } from "@/components/chat";
import { DocumentsPanel } from "@/components/documents-panel";
import { createClient } from "@/lib/supabase/client";
import type { DocumentRow } from "@/lib/types";

/** Keeps the project's document list live and shares it with the chat. */
export function ProjectWorkspace({
  projectId,
  userId,
  initialDocuments,
  initialConversation,
}: {
  projectId: string;
  userId: string;
  initialDocuments: DocumentRow[];
  initialConversation: ConversationState | null;
}) {
  const [documents, setDocuments] = useState(initialDocuments);

  const reload = useCallback(async () => {
    const { data } = await createClient()
      .from("documents")
      .select()
      .eq("project_id", projectId)
      .order("created_at")
      .returns<DocumentRow[]>();
    if (data) setDocuments(data);
  }, [projectId]);

  // Processing status changes arrive through Supabase Realtime. Each mount gets
  // its own channel name: channel() returns an existing channel with the same
  // name, and a remount (React Strict Mode in dev) happens before
  // removeChannel() finishes, so a fixed name would reuse the dying channel.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`documents:${projectId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `project_id=eq.${projectId}`,
        },
        () => void reload(),
      )
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`Realtime ${status} for documents`, error);
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [projectId, reload]);

  // Backstop in case a Realtime event is missed: poll while anything is in flight.
  const inFlight = documents.some(
    (d) => d.status === "queued" || d.status === "processing",
  );
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void reload(), 4000);
    return () => clearInterval(timer);
  }, [inFlight, reload]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start">
      <DocumentsPanel
        projectId={projectId}
        userId={userId}
        documents={documents}
        onChange={reload}
      />
      <Chat
        projectId={projectId}
        documents={documents}
        initialConversation={initialConversation}
      />
    </div>
  );
}
