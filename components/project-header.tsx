"use client";

import { useActionState, useState, useTransition } from "react";

import { setProjectArchived, updateProject } from "@/app/projects/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Project } from "@/lib/types";

export function ProjectHeader({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [archiving, startArchiving] = useTransition();
  const [state, formAction, saving] = useActionState(
    async (prev: { error?: string }, formData: FormData) => {
      const result = await updateProject(project.id, prev, formData);
      if (!result.error) setEditing(false);
      return result;
    },
    {},
  );
  const archived = project.archived_at !== null;

  return (
    <header className="flex flex-col gap-3">
      {archived && (
        <p className="rounded-md bg-accent px-3 py-2 text-sm">
          This project is archived.
        </p>
      )}
      {editing ? (
        <form action={formAction} className="flex flex-col gap-2 max-w-xl">
          <Input name="name" defaultValue={project.name} required autoFocus />
          <Input
            name="description"
            defaultValue={project.description ?? ""}
            placeholder="Description (optional)"
          />
          {state.error && <p className="text-sm text-red-500">{state.error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-start gap-3 justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold break-words">{project.name}</h1>
            {project.description && (
              <p className="text-muted-foreground">{project.description}</p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Rename
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={archiving}
              onClick={() =>
                startArchiving(() => setProjectArchived(project.id, !archived))
              }
            >
              {archived ? "Unarchive" : "Archive"}
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
