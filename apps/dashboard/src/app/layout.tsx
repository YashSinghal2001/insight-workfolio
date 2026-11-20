import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth-provider";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insight Workfolio",
  description: "Insight Workfolio: admin dashboard and employee workspace",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme: light by default; the head script switches to a stored dark choice before first paint.
    <html lang="en" data-theme="light" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
