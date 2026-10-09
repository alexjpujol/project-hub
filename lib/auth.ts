import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

/** Returns the logged-in user's ID, or redirects to the login page. */
export async function requireUserId(supabase: SupabaseClient) {
  const { data: auth, error: authError } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;

  if (authError || !userId) {
    redirect("/auth/login");
  }
  return userId;
}
