import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://770lab.github.io"),
  title: "CRM Vélos Cargo - Artisans Verts",
  description: "Gestion des livraisons de vélos cargo",
  icons: {
    icon: "/crm-velos-cargo/favicon.svg",
    apple: "/crm-velos-cargo/apple-touch-icon.png",
  },
  openGraph: {
    title: "CRM Vélos Cargo - Artisans Verts",
    description: "Gestion des livraisons de vélos cargo",
    images: [{ url: "/crm-velos-cargo/og-image.png", width: 1200, height: 630 }],
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-gray-50">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
