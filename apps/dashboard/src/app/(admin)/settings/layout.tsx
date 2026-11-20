"use client";

import { SETTINGS_NAV } from "@/components/sidebar";
import { SubNav } from "@/components/sub-nav";

/** Settings sub-menu beside every settings page (an inner column from 1024 px). */
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="lg:flex lg:gap-6">
      <SubNav label="Settings" items={SETTINGS_NAV} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
