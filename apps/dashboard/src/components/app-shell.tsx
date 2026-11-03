"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Shared app shell for both panels: desktop sidebar, accessible mobile drawer, sticky header,
 * "Skip to content" link and the single <main id="main"> landmark pages render into.
 */

export interface NavItem {
  label: string;
  href: string;
}
export interface NavSection {
  title?: string;
  items: readonly NavItem[];
}
export interface NavProps {
  /** Drawer open (below md). */
  open?: boolean;
  /** Called on link click and on the drawer's close button. */
  onNavigate?: () => void;
}

function isActive(href: string, pathname: string | null, root: string) {
  if (!pathname) return false;
  return href === root ? pathname === root : pathname === href || pathname.startsWith(`${href}/`);
}

function Links({ sections, root, pathname, onNavigate }: { sections: readonly NavSection[]; root: string; pathname: string | null; onNavigate?: () => void }) {
  // Only the most specific matching link is current (e.g. /settings/schedule, not also /settings).
  const current = sections.flatMap((s) => s.items).filter((i) => isActive(i.href, pathname, root)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return sections.map((s, i) => (
    <div key={s.title ?? i} className="flex flex-col gap-0.5">
      {s.title && <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{s.title}</p>}
      {s.items.map(({ label, href }) => {
        const active = href === current;
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active ? "bg-brand/10 font-medium text-brand" : "text-foreground/85 hover:bg-surface-muted hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  ));
}

function ActiveLinks(props: { sections: readonly NavSection[]; root: string; onNavigate?: () => void }) {
  return <Links {...props} pathname={usePathname()} />;
}

/**
 * The navigation landmark. Desktop (md+): sticky sidebar. Mobile: hidden (display: none) unless
 * `open`, then a fixed drawer. Links only inside (suites count `nav a`).
 */
export function ShellNav({ id, label, title, sections, root, open = false, onNavigate }: NavProps & { id: string; label: string; title: string; sections: readonly NavSection[]; root: string }) {
  return (
    <nav
      id={id}
      aria-label={label}
      className={`${
        open ? "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shadow-xl" : "hidden"
      } shrink-0 flex-col overflow-y-auto border-r border-border bg-surface md:sticky md:top-0 md:z-auto md:flex md:h-screen md:w-60 md:max-w-none md:shadow-none`}
    >
      <div className="flex items-center justify-between gap-2 px-5 py-4">
        <div>
          <p className="font-semibold">
            Insight <span className="text-brand">Workfolio</span>
          </p>
          <p className="text-xs tracking-wide text-muted uppercase">{title}</p>
        </div>
        {open && (
          <button type="button" onClick={onNavigate} className="rounded-md border border-border px-2 py-1 text-sm md:hidden">
            Close
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 px-3 pb-6">
        {/* usePathname suspends under dynamic routes (cacheComponents); fall back to unhighlighted links. */}
        <Suspense fallback={<Links sections={sections} root={root} pathname={null} onNavigate={onNavigate} />}>
          <ActiveLinks sections={sections} root={root} onNavigate={onNavigate} />
        </Suspense>
      </div>
    </nav>
  );
}

/** Drawer state with Escape, focus trap, focus return, scroll lock and auto-close at md+. */
function useDrawer(navId: string) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const nav = document.getElementById(navId);
    const focusables = () => [...(nav?.querySelectorAll<HTMLElement>("a[href], button") ?? [])];
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        const target = e.shiftKey && document.activeElement === first ? last
          : !e.shiftKey && document.activeElement === last ? first
          : nav?.contains(document.activeElement) ? null : first;
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    const desktop = window.matchMedia("(min-width: 768px)");
    const onWide = () => desktop.matches && setOpen(false);
    document.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onWide);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onWide);
      document.body.style.overflow = overflow;
    };
  }, [open, navId]);

  return { open, setOpen, close, button };
}

export interface AppShellProps {
  /** id of the nav element the Menu button controls (e.g. "admin-nav", "my-nav"). */
  navId: string;
  /** Renders the nav (Sidebar / MyNav); omit for no navigation. */
  nav?: (props: Required<NavProps>) => ReactNode;
  /** Small label next to the brand on mobile (e.g. "Admin"). */
  context?: string;
  /** Right side of the header: status, identity, role badge, Sign out. */
  actions: ReactNode;
  children: ReactNode;
}

export function AppShell({ navId, nav, context, actions, children }: AppShellProps) {
  const { open, setOpen, close, button } = useDrawer(navId);
  return (
    <>
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-brand px-3 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <div className="flex min-h-screen">
        {nav?.({ open, onNavigate: close })}
        {open && <div aria-hidden className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={close} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur md:px-8">
            <div className="flex items-center gap-3">
              {nav && (
                <button
                  ref={button}
                  type="button"
                  className="rounded-md border border-border px-3 py-1 text-sm md:hidden"
                  aria-expanded={open}
                  aria-controls={navId}
                  onClick={() => setOpen((o) => !o)}
                >
                  {open ? "Close menu" : "Menu"}
                </button>
              )}
              <p className={`text-base font-semibold ${nav ? "md:hidden" : ""}`}>
                Insight <span className="text-brand">Workfolio</span>
                {context && <span className="ml-1 text-sm font-normal text-muted">· {context}</span>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{actions}</div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 focus:outline-none md:px-8">
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
