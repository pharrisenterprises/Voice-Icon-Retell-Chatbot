// app/page.jsx
import { redirect } from 'next/navigation';

export default function Home() {
  // Send the root to the actual UI your iframe loads
  redirect('/embed');
}
