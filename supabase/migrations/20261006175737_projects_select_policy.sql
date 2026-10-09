create policy "Users can read own projects"
on public.projects for select
to authenticated
using ((select auth.uid()) = user_id);
