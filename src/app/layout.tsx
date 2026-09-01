import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal Room — AI Interview Coach",
  description: "Practice technical interviews with a realtime, artifact-aware AI coach.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
