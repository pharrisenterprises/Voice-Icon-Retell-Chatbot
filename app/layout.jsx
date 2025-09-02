// app/layout.jsx
export const metadata = {
  title: 'Voice Widget',
  description: 'Retell voice-only widget',
};

/**
 * This is the required root layout for every Next.js App Router project.
 * It wraps ALL pages (including / and /embed).
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0b0f19', color: '#e6e8ee' }}>
        {children}
      </body>
    </html>
  );
}
