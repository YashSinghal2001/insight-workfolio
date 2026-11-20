import { apiResponse } from "@/lib/api";

/**
 * Downloads an authenticated API file (export) through a short-lived object URL. The filename is
 * passed in: the API's content-disposition header is not readable cross-origin.
 * Resolves to the API's `x-export-rows` count when the header is readable, else null.
 */
export async function downloadFile(path: string, filename: string, init?: { method?: string; body?: unknown }): Promise<number | null> {
  const res = await apiResponse(path, init);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const rows = res.headers.get("x-export-rows");
  return rows === null ? null : Number(rows);
}
