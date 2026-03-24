import "./globals.css";

export const metadata = {
  title: "Second Brain AI",
  description: "A personal knowledge engine for saved internet content"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
