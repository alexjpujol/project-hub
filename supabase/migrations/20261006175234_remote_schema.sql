CREATE TABLE "public"."projects" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "name"        text                     NOT NULL DEFAULT ''::text,
  "description" text                     DEFAULT ''::text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "projects_pkey" PRIMARY KEY (id),
  "user_id"     uuid                     NOT NULL DEFAULT auth.uid()
);

ALTER TABLE "public"."projects"
  ENABLE ROW LEVEL SECURITY;

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."projects" TO "anon", "authenticated";

REVOKE ALL ON TABLE "public"."projects" FROM "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."projects" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."projects" TO "service_role";

ALTER TABLE "public"."projects"
  ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

