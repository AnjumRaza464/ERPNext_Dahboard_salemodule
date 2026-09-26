import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sindh Bakery · Sales Analytics",
  description: "Live sales analytics dashboard fed by ERPNext",
};

const themeInit = `
try {
  var q = new URLSearchParams(location.search).get('theme');
  var t = (q === 'dark' || q === 'light') ? q : localStorage.getItem('sb-theme');
  var dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
