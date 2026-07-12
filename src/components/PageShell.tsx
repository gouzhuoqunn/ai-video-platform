import type { ReactNode } from "react";

type PageShellProps = {
  children: ReactNode;
  className?: string;
};

export function PageShell({ children, className = "" }: PageShellProps) {
  return <div className={`mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12 ${className}`}>{children}</div>;
}
