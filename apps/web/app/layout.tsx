import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "RetainOS — find the friction, fix the experience, prove the impact",
    template: "%s · RetainOS",
  },
  description:
    "RetainOS connects product analytics, customer feedback and development work so you can find where users " +
    "struggle, turn the evidence into improvements, and measure what actually changed.",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
