import { NextResponse, type NextRequest } from "next/server";

import { BUCKET } from "@/lib/ingest";
import { createClient } from "@/lib/supabase/server";
import type { DocumentRow } from "@/lib/types";

/**
 * Opens a document's original: the live page for links, otherwise a
 * short-lived signed URL, jumping to ?page=N in PDFs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: doc } = await supabase
    .from("documents")
    .select("source_type, source_url, storage_path")
    .eq("id", id)
    .single<Pick<DocumentRow, "source_type" | "source_url" | "storage_path">>();
  if (!doc) return new NextResponse("Not found", { status: 404 });

  if (doc.source_type === "link" && doc.source_url) {
    return NextResponse.redirect(doc.source_url);
  }
  if (!doc.storage_path) return new NextResponse("Not found", { status: 404 });

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 60 * 10);
  if (error) return new NextResponse(error.message, { status: 500 });

  const page = Number(request.nextUrl.searchParams.get("page"));
  const hash = doc.source_type === "pdf" && page > 0 ? `#page=${page}` : "";
  return NextResponse.redirect(data.signedUrl + hash);
}
