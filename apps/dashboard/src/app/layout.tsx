import type { Metadata } from "next";
import { AuthProvider } from "@/components/auth-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insight Workfolio — Admin",
  description: "Insight Workfolio admin dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
