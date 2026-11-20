"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SubNavItem {
  label: string;
  href: string;
}

function Items({ items, pathname }: { items: readonly SubNavItem[]; pathname: string | null }) {
  // Exact match first; otherwise the longest prefix (a detail page under an item).
  const current =
    items.find((i) => i.href === pathname)?.href ??
    items.filter((i) => pathname?.startsWith(`${i.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return items.map(({ label, href }) => {
    const active = href === current;
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={`shrink-0 rounded-md border-l-2 px-3 py-1.5 text-sm whitespace-nowrap ${
          active ? "border-brand bg-brand/10 font-medium text-brand" : "border-transparent text-foreground/85 hover:bg-surface-muted"
        }`}
      >
        {label}
      </Link>
    );
  });
}

function ActiveItems({ items }: { items: readonly SubNavItem[] }) {
  return <Items items={items} pathname={usePathname()} />;
}

/**
 * Secondary navigation (Reports, Settings): a horizontally scrolling row on small screens, an inner column
 * at >= 1024 px. Place it beside the content: `<div className="lg:flex lg:gap-6"><SubNav …/><div className="min-w-0 flex-1">…`.
 */
export function SubNav({ items, label = "Section" }: { items: readonly SubNavItem[]; label?: string }) {
  return (
    <nav
      aria-label={label}
      className="mb-4 flex max-w-full gap-1 overflow-x-auto border-b border-border pb-2 lg:mb-0 lg:w-48 lg:shrink-0 lg:flex-col lg:self-start lg:overflow-visible lg:border-0 lg:pb-0"
    >
      {/* usePathname suspends under dynamic routes (cacheComponents); fall back to unhighlighted links. */}
      <Suspense fallback={<Items items={items} pathname={null} />}>
        <ActiveItems items={items} />
      </Suspense>
    </nav>
  );
}
