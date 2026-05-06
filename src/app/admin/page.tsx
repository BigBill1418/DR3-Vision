import { redirect } from 'next/navigation';

// /admin -> /admin/users. Keeps the route hierarchy clean for any
// future /admin/audit (ADR-0007 §UI) or /admin/sources surfaces.
export default function AdminIndexPage(): never {
  redirect('/admin/users');
}
