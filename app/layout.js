import './globals.css';

export const metadata = {
  title: 'Berpal — AI bookkeeping bot',
  description: 'WhatsApp-first bookkeeping for small businesses.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased font-sans">{children}</body>
    </html>
  );
}
