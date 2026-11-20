"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FiltersSlot } from "@/components/global-filters";
import { ThemeToggle } from "@/components/theme-toggle";

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
  /** Drawer open (below lg = 1024 px). */
  open?: boolean;
  /** Called on link click and on the drawer's close button. */
  onNavigate?: () => void;
}

function isActive(href: string, pathname: string | null, root: string) {
  if (!pathname) return false;
  return href === root ? pathname === root : pathname === href || pathname.startsWith(`${href}/`);
}

/** Only the most specific matching link is current (e.g. /my/team/leave, not also /my/team). */
function currentItem(sections: readonly NavSection[], pathname: string | null, root: string) {
  return sections
    .flatMap((section) => section.items.map((item) => ({ section, item })))
    .filter(({ item }) => isActive(item.href, pathname, root))
    .sort((a, b) => b.item.href.length - a.item.href.length)[0];
}

function Links({ sections, root, pathname, onNavigate }: { sections: readonly NavSection[]; root: string; pathname: string | null; onNavigate?: () => void }) {
  const current = currentItem(sections, pathname, root)?.item.href;
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
            className={`rounded-md border-l-2 px-3 py-1.5 text-sm transition-colors ${
              active ? "border-brand bg-brand/10 font-medium text-brand" : "border-transparent text-foreground/85 hover:bg-surface-muted hover:text-foreground"
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
 * The navigation landmark. Desktop (lg+, 1024 px): sticky sidebar. Mobile: hidden (display: none) unless
 * `open`, then a fixed drawer. Links only inside (suites count `nav a`).
 */
export function ShellNav({ id, label, title, sections, root, open = false, onNavigate }: NavProps & { id: string; label: string; title: string; sections: readonly NavSection[]; root: string }) {
  return (
    <nav
      id={id}
      aria-label={label}
      className={`${
        open ? "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] shadow-xl" : "hidden"
      } shrink-0 flex-col overflow-y-auto border-r border-border bg-surface lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-screen lg:w-56 lg:max-w-none lg:shadow-none`}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div>
          <p className="font-semibold">
            Insight <span className="text-brand">Workfolio</span>
          </p>
          <p className="text-xs tracking-wide text-muted uppercase">{title}</p>
        </div>
        {open && (
          <button type="button" onClick={onNavigate} className="rounded-md border border-border px-2 py-1 text-sm lg:hidden">
            Close
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2 pb-6">
        {/* usePathname suspends under dynamic routes (cacheComponents); fall back to unhighlighted links. */}
        <Suspense fallback={<Links sections={sections} root={root} pathname={null} onNavigate={onNavigate} />}>
          <ActiveLinks sections={sections} root={root} onNavigate={onNavigate} />
        </Suspense>
      </div>
    </nav>
  );
}

/** Drawer state with Escape, focus trap, focus return, scroll lock and auto-close at lg+. */
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
    const desktop = window.matchMedia("(min-width: 1024px)");
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
  /** Nav sections + root: the header names the current page ("Attendance / Timesheets"). */
  sections?: readonly NavSection[];
  root?: string;
  /** Right side of the header after the filters slot and theme toggle: status, role badge, links, Sign out. */
  actions: ReactNode;
  children: ReactNode;
}

function PageContext({ sections, root, pathname }: { sections: readonly NavSection[]; root: string; pathname: string | null }) {
  const c = currentItem(sections, pathname, root);
  if (!c) return null;
  return (
    <p className="hidden min-w-0 truncate text-sm sm:block">
      {c.section.title && <span className="text-muted">{c.section.title} / </span>}
      <span className="font-medium">{c.item.label}</span>
    </p>
  );
}

function ActivePageContext(props: { sections: readonly NavSection[]; root: string }) {
  return <PageContext {...props} pathname={usePathname()} />;
}

export function AppShell({ navId, nav, context, sections, root = "/", actions, children }: AppShellProps) {
  const { open, setOpen, close, button } = useDrawer(navId);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
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
        {open && <div aria-hidden className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={close} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur lg:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {nav && (
                <button
                  ref={button}
                  type="button"
                  className="rounded-md border border-border px-3 py-1 text-sm lg:hidden"
                  aria-expanded={open}
                  aria-controls={navId}
                  onClick={() => setOpen((o) => !o)}
                >
                  {open ? "Close menu" : "Menu"}
                </button>
              )}
              <p className={`shrink-0 text-base font-semibold ${nav ? "lg:hidden" : ""}`}>
                Insight <span className="text-brand">Workfolio</span>
                {context && <span className="ml-1 text-sm font-normal text-muted">· {context}</span>}
              </p>
              {sections && (
                <Suspense fallback={null}>
                  <ActivePageContext sections={sections} root={root} />
                </Suspense>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <div ref={setSlot} data-testid="global-filters-slot" className="contents" />
              <ThemeToggle />
              {actions}
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 px-4 py-5 focus:outline-none lg:px-6">
            <FiltersSlot value={slot}>{children}</FiltersSlot>
          </main>
        </div>
      </div>
    </>
  );
}
