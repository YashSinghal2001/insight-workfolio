# W1-UI — UI foundation, theme, shell, navigation, global filters

Branch `agent/w1-ui-foundation`. Contracts: `docs/IMPLEMENTATION-CONTRACTS.md` §2, §6, §7.

## Scope
1. Theme: light default, explicit Light/Dark toggle, stored per browser (`localStorage["iw-theme"]`), applied as
   `data-theme` on `<html>` before first paint by a tiny inline script in the root layout. No CSP `script-src`
   exists (next.config only sets `frame-ancestors 'none'`; deploy/caddy sets none), so the inline script is compliant.
   `prefers-color-scheme` block → `:root[data-theme="dark"]`; Tailwind `dark:` variant follows `data-theme`.
2. Tokens/density (roadmap Part 5): page `#f6f7f9`, cards `#fff`, borders `#e5e7eb`, card shadow
   `0 1px 2px rgb(0 0 0/.04)`; 14 px body, 12 px table meta, 20 px page title, 12 px card padding, 36 px rows;
   brand blue unchanged. `--chart-1…8` (light + dark), exposed in `@theme` as `--color-chart-n`.
3. Shell: sidebar regrouped REALTIME / ATTENDANCE / MONITORING / WORK / REPORTS / PEOPLE / ADMIN, existing routes
   only; Settings sub-pages move into a Settings `<SubNav>`; active = brand text + brand-soft bg + left bar; drawer
   below 1024 px (was 768). Top bar: page context left; right: global-filters slot, theme toggle, API status, role
   badge, My workspace, Sign out. `nav#admin-nav[aria-label="Main"]`, `nav#my-nav` ids/labels unchanged.
4. `components/global-filters.tsx`: `useGlobalFilters()` + `<GlobalFilters date? team? />` (portals into the
   top-bar slot; one line per page to opt in). Pure parse/serialise in `src/lib/global-filters.ts`.
5. `components/sub-nav.tsx`: `<SubNav items label? />`.
6. kit.tsx: `PageHeader about?` (closed `<details>` "About this page"); `DataTable` optional sortable columns
   (`columns` prop with `sortKey`, aria-sort, buttons = keyboard operable) + pure `sortRows` in `src/lib/sort-rows.ts`;
   `StatCard tone?` + compact styling. All existing props unchanged.
7. Pages I own: long explanatory descriptions → `about` (verbatim); no data/permission/API change.
8. Browser suites: nav/responsive assertions for the new breakpoint and widths 1440/1024/768/375.

## Files
Modify: `app/{layout.tsx,globals.css}`, `app/(admin)/layout.tsx`, `app/my/layout.tsx`, `components/{app-shell,sidebar,kit,ui}.tsx`,
owned `app/**/page.tsx` (about moves), `scripts/verify-web-app.mjs` (responsive breakpoint/widths).
New: `components/{theme-toggle,global-filters,sub-nav}.tsx`, `app/(admin)/settings/layout.tsx` (Settings sub-menu),
`src/lib/{theme,global-filters,sort-rows}.ts` + `*.test.ts`.

## Dependencies
None new. `localDate`/`addDays` from `@workfolio/shared`. Teams from `GET /api/v1/teams` (admins only).

## UI behaviour / permissions
- Toggle is a button with `aria-pressed` and a text label; storage failures are swallowed (theme still switches).
- Filters: URL `?date=YYYY-MM-DD&team=<uuid>`; invalid date → today (viewer zone); non-uuid / unknown team → All teams;
  "Today" shortcut clears `date`; team select only for admins. `router.replace`, other params preserved.
- Roles link still Super Admin only. No route, API, or permission change.

## Test cases (node --test, JSX-free)
- theme: stored "dark"/"light" → same; null / garbage / storage throws → "light".
- filters: valid date kept; bad format, impossible date (2026-02-30), empty → today; uuid team kept; non-uuid → null;
  unknown team (known list given) → null; serialise drops defaults (today, null team), keeps other params.
- sortRows: numbers asc/desc, strings (locale, case-insensitive), nulls/undefined last both directions, stable ties,
  input not mutated.
- Browser: smoke, verify:web-app (nav, responsive 1440/1024/768/375/360), verify:my-panel.

## Acceptance
Every existing page reachable from the nav (Settings sub-pages via Settings sub-menu), same permissions, no API
change; light default without flash; dark persists across reloads; no page-level horizontal scroll at
1440/1024/768/375; typecheck + lint + unit + smoke + both suites green.
