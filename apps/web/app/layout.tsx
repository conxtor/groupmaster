import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { AppLocaleProvider } from "./app-locale";
import SiteFooter from "./site-footer";

export const metadata: Metadata = {
  title: "CONXTOR - Messaging Group Intelligence",
  description: "CONXTOR verarbeitet Nachrichten aus verbundenen Messaging-Gruppen.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body><AppLocaleProvider>{children}<SiteFooter /></AppLocaleProvider></body></html>;
}
