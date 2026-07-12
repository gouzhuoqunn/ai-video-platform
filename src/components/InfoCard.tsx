import type { ReactNode } from "react";

type InfoCardProps = {
  title: string;
  value: string;
  note?: string;
  children?: ReactNode;
};

export function InfoCard({ title, value, note, children }: InfoCardProps) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-stone-500">{title}</p>
      <p className="mt-2 text-2xl font-bold text-stone-950">{value}</p>
      {note ? <p className="mt-2 text-sm text-stone-600">{note}</p> : null}
      {children}
    </section>
  );
}
