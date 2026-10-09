"use client";

import {
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";

import {
  addLink,
  addSuggestedLink,
  addUploadedDocument,
  deleteDocument,
  retryDocument,
  type ActionResult,
} from "@/app/projects/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeUrl, type SuggestedLink } from "@/lib/links";
import { createClient } from "@/lib/supabase/client";
import type { DocumentRow, DocumentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCEPTED: Record<string, { sourceType: "pdf" | "image"; ext: string }> = {
  "application/pdf": { sourceType: "pdf", ext: "pdf" },
  "image/png": { sourceType: "image", ext: "png" },
  "image/jpeg": { sourceType: "image", ext: "jpg" },
  "image/gif": { sourceType: "image", ext: "gif" },
  "image/webp": { sourceType: "image", ext: "webp" },
};
const MAX_BYTES = 32 * 1024 * 1024;

type Upload = { key: string; name: string; error?: string };

const STATUS_STYLES: Record<DocumentStatus, string> = {
  queued: "bg-secondary text-secondary-foreground",
  processing: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  ready: "bg-green-500/15 text-green-700 dark:text-green-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function DocumentsPanel({
  projectId,
  userId,
  documents,
  onChange,
}: {
  projectId: string;
  userId: string;
  documents: DocumentRow[];
  onChange: () => Promise<void>;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  // Pages already in the project, so suggestions for them can be hidden.
  const savedUrls = new Set(
    documents.flatMap((d) => (d.source_url ? [normalizeUrl(d.source_url)] : [])),
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const linkForm = useRef<HTMLFormElement>(null);

  const [linkState, linkAction, savingLink] = useActionState(
    async (prev: ActionResult, formData: FormData) => {
      const result = await addLink(projectId, prev, formData);
      if (!result.error) {
        linkForm.current?.reset();
        await onChange();
      }
      return result;
    },
    {},
  );

  async function uploadFile(file: File) {
    const key = crypto.randomUUID();
    const accepted = ACCEPTED[file.type];
    const fail = (error: string) =>
      setUploads((u) => [...u.filter((x) => x.key !== key), { key, name: file.name, error }]);

    if (!accepted) return fail("Only PDFs and PNG, JPEG, GIF or WebP images are supported.");
    if (file.size > MAX_BYTES) return fail("Files must be 32 MB or smaller.");

    setUploads((u) => [...u, { key, name: file.name }]);
    const id = crypto.randomUUID();
    const storagePath = `${userId}/${projectId}/${id}/original.${accepted.ext}`;

    const { error } = await createClient()
      .storage.from("documents")
      .upload(storagePath, file, { contentType: file.type });
    if (error) return fail(error.message);

    const result = await addUploadedDocument({
      id,
      projectId,
      title: file.name,
      sourceType: accepted.sourceType,
      mediaType: file.type,
      storagePath,
    });
    if (result.error) return fail(result.error);

    setUploads((u) => u.filter((x) => x.key !== key));
    await onChange();
  }

  function uploadFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) void uploadFile(file);
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 className="font-semibold">Documents</h2>

      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          uploadFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-md border-2 border-dashed p-6 text-sm text-muted-foreground transition-colors",
          dragging ? "border-primary bg-accent" : "hover:bg-accent/50",
        )}
      >
        <Upload className="h-5 w-5" />
        <span>Drop PDFs or images here, or click to choose</span>
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={Object.keys(ACCEPTED).join(",")}
        className="hidden"
        onChange={(e) => {
          uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <form ref={linkForm} action={linkAction} className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Input name="url" type="url" placeholder="https://… save a web page" required />
          <Button type="submit" variant="outline" disabled={savingLink}>
            {savingLink ? "Saving…" : "Save link"}
          </Button>
        </div>
        {linkState.error && <p className="text-sm text-red-500">{linkState.error}</p>}
      </form>

      <ul className="flex flex-col divide-y">
        {uploads.map((upload) => (
          <li key={upload.key} className="py-3 flex items-start gap-3 text-sm">
            {upload.error ? (
              <FileText className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
            ) : (
              <Loader2 className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate">{upload.name}</p>
              <p className={cn("text-xs", upload.error ? "text-red-500" : "text-muted-foreground")}>
                {upload.error ?? "Uploading…"}
              </p>
            </div>
            {upload.error && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setUploads((u) => u.filter((x) => x.key !== upload.key))}
              >
                Dismiss
              </Button>
            )}
          </li>
        ))}
        {documents.map((doc) => (
          <DocumentItem
            key={doc.id}
            doc={doc}
            projectId={projectId}
            savedUrls={savedUrls}
            onChange={onChange}
          />
        ))}
      </ul>

      {documents.length === 0 && uploads.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No documents yet. Add brochures, screenshots or links to start asking questions.
        </p>
      )}
    </section>
  );
}

function DocumentItem({
  doc,
  projectId,
  savedUrls,
  onChange,
}: {
  doc: DocumentRow;
  projectId: string;
  savedUrls: Set<string>;
  onChange: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const Icon =
    doc.source_type === "link" ? Globe : doc.source_type === "image" ? ImageIcon : FileText;

  return (
    <li className="py-3 flex items-start gap-3 text-sm">
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <a
          href={`/api/documents/${doc.id}/open`}
          target="_blank"
          rel="noreferrer"
          className="truncate font-medium hover:underline"
        >
          {doc.title ?? "Untitled"}
        </a>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge className={cn("border-transparent shadow-none", STATUS_STYLES[doc.status])}>
            {doc.status}
          </Badge>
          {doc.captured_at && (
            <span>Captured {new Date(doc.captured_at).toLocaleDateString()}</span>
          )}
        </div>
        {doc.status === "failed" && doc.error && (
          <p className="text-xs text-red-500">{doc.error}</p>
        )}
        <RelatedPages
          links={(doc.suggested_links ?? []).filter(
            (link) => !savedUrls.has(normalizeUrl(link.url)),
          )}
          projectId={projectId}
          onChange={onChange}
        />
      </div>
      <div className="flex shrink-0">
        {doc.status === "failed" && (
          <Button
            size="icon"
            variant="ghost"
            title="Retry"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await retryDocument(doc.id);
                await onChange();
              })
            }
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          title="Delete"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Delete "${doc.title ?? "this document"}"?`)) return;
            startTransition(async () => {
              await deleteDocument(doc.id);
              await onChange();
            });
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

/** One-click suggestions for related pages on the same site (fees, dates...). */
function RelatedPages({
  links,
  projectId,
  onChange,
}: {
  links: SuggestedLink[];
  projectId: string;
  onChange: () => Promise<void>;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (links.length === 0) return null;

  async function add(link: SuggestedLink) {
    setAdding(link.url);
    setError(null);
    const result = await addSuggestedLink(projectId, link);
    if (result.error) setError(result.error);
    await onChange();
    setAdding(null);
  }

  return (
    <div className="flex flex-col gap-1 pt-1">
      <p className="text-xs text-muted-foreground">Related pages on this site:</p>
      <div className="flex flex-wrap gap-1">
        {links.map((link) => (
          <button
            key={link.url}
            type="button"
            title={link.url}
            disabled={adding !== null}
            onClick={() => void add(link)}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            {adding === link.url ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            {link.text}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
