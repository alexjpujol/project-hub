"use client";

import { Loader2, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  AnswerBlock,
  ChatEvent,
  ChatMessage,
  Citation,
  DocumentRow,
} from "@/lib/types";

export type ConversationState = {
  id: string;
  documentIds: string[];
  messages: ChatMessage[];
};

export function Chat({
  projectId,
  documents,
  initialConversation,
}: {
  projectId: string;
  documents: DocumentRow[];
  initialConversation: ConversationState | null;
}) {
  const [conversation, setConversation] = useState(initialConversation);
  const [question, setQuestion] = useState("");
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const messages = conversation?.messages ?? [];
  const pending = streamingText !== null;
  const readyIds = documents.filter((d) => d.status === "ready").map((d) => d.id);
  const newDocumentCount = conversation?.id
    ? readyIds.filter((id) => !conversation.documentIds.includes(id)).length
    : 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, streamingText]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text || pending) return;

    setQuestion("");
    setError(null);
    setStreamingText("");
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text };
    // A new conversation has no ID until the server sends one back.
    setConversation((c) =>
      c
        ? { ...c, messages: [...c.messages, userMessage] }
        : { id: "", documentIds: [], messages: [userMessage] },
    );

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          conversationId: conversation?.id ?? null,
          question: text,
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${response.status}).`);
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ChatEvent;
          if (event.type === "conversation") {
            setConversation((c) =>
              c && { ...c, id: event.conversationId, documentIds: event.documentIds },
            );
          } else if (event.type === "text") {
            setStreamingText((t) => (t ?? "") + event.text);
          } else if (event.type === "done") {
            setConversation((c) =>
              c ? { ...c, messages: [...c.messages, event.message] } : c,
            );
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      // The failed question wasn't saved, so drop it and give it back to edit.
      setConversation((c) => {
        if (!c) return c;
        const rest = c.messages.filter((m) => m.id !== userMessage.id);
        return c.id || rest.length ? { ...c, messages: rest } : null;
      });
      setQuestion(text);
    } finally {
      setStreamingText(null);
    }
  }

  return (
    <section className="flex flex-col rounded-lg border min-h-[28rem] lg:h-[calc(100vh-14rem)]">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="font-semibold">Ask</h2>
        {conversation && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setConversation(null);
              setError(null);
            }}
          >
            New conversation
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
        {messages.length === 0 && !pending && (
          <p className="text-sm text-muted-foreground m-auto text-center max-w-sm">
            {readyIds.length
              ? "Ask a question about this project's documents. Answers cite the exact source."
              : "Add a document and wait for it to be ready, then ask a question here."}
          </p>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <p
              key={message.id}
              className="self-end max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap"
            >
              {message.text}
            </p>
          ) : (
            <Answer key={message.id} blocks={message.blocks} />
          ),
        )}
        {pending && (
          <div className="text-sm whitespace-pre-wrap">
            {streamingText || (
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading your documents…
              </span>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {newDocumentCount > 0 && (
        <p className="mx-4 mb-2 rounded-md bg-accent px-3 py-2 text-xs">
          {newDocumentCount} new {newDocumentCount === 1 ? "document is" : "documents are"}{" "}
          ready since this conversation started. Start a new conversation to include{" "}
          {newDocumentCount === 1 ? "it" : "them"}.
        </p>
      )}
      {error && <p className="mx-4 mb-2 text-sm text-red-500">{error}</p>}

      <form onSubmit={ask} className="flex gap-2 border-t p-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          placeholder="When is registration for Camp Jeff due?"
          className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base md:text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button type="submit" size="icon" disabled={pending || !question.trim()} title="Ask">
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </form>
    </section>
  );
}

function citationKey(c: Citation) {
  return `${c.documentId}:${c.startPage ?? ""}`;
}

function citationLabel(c: Citation) {
  if (c.startPage) {
    const pages = c.endPage && c.endPage - 1 > c.startPage
      ? `pp. ${c.startPage}–${c.endPage - 1}`
      : `p. ${c.startPage}`;
    return `${c.title}, ${pages}`;
  }
  if (c.capturedAt) {
    return `${c.title}, as of ${new Date(c.capturedAt).toLocaleDateString()}`;
  }
  return c.title;
}

function citationHref(c: Citation) {
  const page = c.startPage ? `?page=${c.startPage}` : "";
  return `/api/documents/${c.documentId}/open${page}`;
}

/** An answer with numbered citation markers and a matching source list. */
function Answer({ blocks }: { blocks: AnswerBlock[] }) {
  const sources = useMemo(() => {
    const map = new Map<string, { n: number; citation: Citation; quotes: string[] }>();
    for (const block of blocks) {
      for (const c of block.citations) {
        const key = citationKey(c);
        const entry = map.get(key);
        if (entry) {
          if (!entry.quotes.includes(c.citedText)) entry.quotes.push(c.citedText);
        } else {
          map.set(key, { n: map.size + 1, citation: c, quotes: [c.citedText] });
        }
      }
    }
    return map;
  }, [blocks]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="whitespace-pre-wrap">
        {blocks.map((block, i) => {
          const numbers = [...new Set(block.citations.map((c) => sources.get(citationKey(c))!.n))];
          return (
            <span key={i}>
              {block.text}
              {numbers.map((n) => {
                const { citation, quotes } = [...sources.values()].find((s) => s.n === n)!;
                return (
                  <a
                    key={n}
                    href={citationHref(citation)}
                    target="_blank"
                    rel="noreferrer"
                    title={quotes.join("\n\n")}
                    className="ml-0.5 align-super text-[0.7em] font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    [{n}]
                  </a>
                );
              })}
            </span>
          );
        })}
      </p>
      {sources.size > 0 && (
        <ol className="flex flex-col gap-1 border-t pt-2 text-xs">
          {[...sources.values()].map(({ n, citation, quotes }) => (
            <li key={n} className="flex gap-2">
              <span className="text-muted-foreground">[{n}]</span>
              <div className="min-w-0">
                <a
                  href={citationHref(citation)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {citationLabel(citation)}
                </a>
                <p className="text-muted-foreground line-clamp-2">“{quotes[0].trim()}”</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
