"use client";

import { PageHeader } from "@/components/kit";
import { OneDriveStorage, Storage } from "../_parts/sections";

/** Where screenshots are stored: the configured provider's health and, when configured, the OneDrive connection. */
export default function StorageSettingsPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader title="Storage" about="The storage provider is chosen in the API's server configuration. Connecting or disconnecting OneDrive is for a Super Admin only." />
      <Storage />
      <OneDriveStorage />
    </div>
  );
}
