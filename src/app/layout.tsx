import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Azure Document Translator",
  description:
    "Upload PDFs, Word docs and images, run OCR and translate them with Azure AI.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
