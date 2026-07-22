import Link from "next/link";

const navItems = [
  { href: "/", label: "图像工作台" },
  { href: "/generate", label: "创建图像" },
  { href: "/login", label: "登录" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Link href="/" className="text-lg font-bold text-stone-950">AI 图像工作台</Link>
        <nav className="flex flex-wrap gap-2 text-sm text-stone-700">
          {navItems.map((item) => <Link className="rounded-md px-3 py-2 transition hover:bg-indigo-50 hover:text-indigo-800" href={item.href} key={item.href}>{item.label}</Link>)}
        </nav>
      </div>
    </header>
  );
}
