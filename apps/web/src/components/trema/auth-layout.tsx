import type { ReactNode } from "react";
import { Wordmark } from "#/components/trema/wordmark.tsx";

export function AuthLayout({
  title,
  description,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-col bg-card px-6">
      <div className="flex flex-1 items-center justify-center py-16">
        <div className="w-full max-w-[360px] space-y-6">
          <div className="flex flex-col items-center space-y-6 text-center">
            <Wordmark className="h-6 w-auto text-foreground" />
            <h1 className="text-lg font-semibold">{title}</h1>
            {description && <p className="text-meta text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </div>
      {footer && <footer className="pb-8 text-center">{footer}</footer>}
    </main>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-chrome font-medium text-muted-foreground">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
