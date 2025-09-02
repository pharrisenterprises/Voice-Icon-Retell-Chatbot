// app/page.jsx
import { redirect } from 'next/navigation';

/**
 * This makes visiting "/" jump straight to "/embed"
 * so Vercel never shows a 404 at the root.
 */
export default function Home() {
  redirect('/embed');
  // Returning null is fine; redirect already ends the response.
  return null;
}
