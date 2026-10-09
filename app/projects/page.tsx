import Link from "next/link";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUserId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Project } from "@/lib/types";

import { createProject, setProjectArchived } from "./actions";

export default function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold">Projects</h1>

      <form
        action={createProject}
        className="flex flex-col sm:flex-row gap-2 sm:items-end rounded-lg border p-4"
      >
        <div className="flex-1 flex flex-col gap-2">
          <label htmlFor="name" className="text-sm font-medium">
            New project
          </label>
          <Input id="name" name="name" placeholder="2026 Summer Camps" required />
        </div>
        <Input
          name="description"
          placeholder="Description (optional)"
          className="sm:flex-1"
        />
        <Button type="submit">Create</Button>
      </form>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading projects…</p>}>
        <ProjectList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

type ProjectWithCount = Project & { documents: { count: number }[] };

async function ProjectList({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const showArchived = (await searchParams).archived === "1";
  const supabase = await createClient();
  const userId = await requireUserId(supabase);

  let query = supabase
    .from("projects")
    .select("id, name, description, archived_at, created_at, documents(count)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  query = showArchived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null);

  const { data: projects, error } = await query.returns<ProjectWithCount[]>();

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">
          {showArchived ? "Archived projects" : "Active projects"}
        </h2>
        <Link
          href={showArchived ? "/projects" : "/projects?archived=1"}
          className="text-sm text-muted-foreground hover:underline"
        >
          {showArchived ? "Show active" : "Show archived"}
        </Link>
      </div>

      {error ? (
        <p className="text-sm text-red-500">
          Failed to load projects: {error.message}
        </p>
      ) : !projects.length ? (
        <p className="text-sm text-muted-foreground">
          {showArchived ? "No archived projects." : "No projects yet. Create one above."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const count = project.documents[0]?.count ?? 0;
            return (
              <li
                key={project.id}
                className="rounded-lg border p-4 flex flex-col gap-2 hover:bg-accent/50 transition-colors"
              >
                <Link href={`/projects/${project.id}`} className="flex flex-col gap-1">
                  <span className="font-medium">{project.name}</span>
                  {project.description && (
                    <span className="text-sm text-muted-foreground line-clamp-2">
                      {project.description}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {count} {count === 1 ? "document" : "documents"}
                  </span>
                </Link>
                {showArchived && (
                  <form action={setProjectArchived.bind(null, project.id, false)}>
                    <Button type="submit" size="sm" variant="outline">
                      Unarchive
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
