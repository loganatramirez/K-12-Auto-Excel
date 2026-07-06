import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "K-12 Targets Workspace",
  description: "A working MVP for K-12 targets, CCD targets, and FY25-FY26 plans."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
