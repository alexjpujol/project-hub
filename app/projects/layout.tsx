import { AuthButton } from "@/components/auth-button";
import { ThemeSwitcher } from "@/components/theme-switcher";
import Link from "next/link";
import { Suspense } from "react";

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="w-full border-b border-b-foreground/10 h-14">
        <div className="mx-auto max-w-6xl h-full flex justify-between items-center px-4 text-sm">
          <Link href="/projects" className="font-semibold">
            Project Hub
          </Link>
          <div className="flex items-center gap-3">
            <Suspense>
              <AuthButton />
            </Suspense>
            <ThemeSwitcher />
          </div>
        </div>
      </nav>
      <main className="flex-1 w-full mx-auto max-w-6xl px-4 py-8">
        {children}
      </main>
    </div>
  );
}
