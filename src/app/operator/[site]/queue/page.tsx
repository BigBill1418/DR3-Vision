import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Image from 'next/image';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

// Operator queue placeholder. T-005 ships the real
// expected-loads queue UI; T-004 just needs the post-PIN landing
// surface that proves the auth round-trip + acceptance criteria
// ("Test operator with PIN 4738 can log in, perform a no-op session,
// logout").

type Props = { params: Promise<{ site: string }> };

export default async function OperatorQueuePage({ params }: Props) {
  const { site: siteCode } = await params;
  const session = await auth();
  if (!session?.user) redirect(`/operator/${siteCode}`);
  if (session.user.role !== 'operator') redirect('/dashboard');

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();
  if (session.user.primary_site_id !== site.id) {
    // Operator is signed in but their primary site doesn't match the
    // URL — happens if someone hand-edits the URL after signing in at
    // a different site iPad. Send them back to their own picker.
    redirect('/operator');
  }

  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4">
          <Image
            src="/brand/dr3-vision-logo.jpg"
            alt="DR3-Vision"
            width={1168}
            height={784}
            priority
            className="h-16 w-auto"
          />
          <span className="rounded-md bg-white/10 px-3 py-1 text-sm font-medium uppercase tracking-wide text-white/80">
            {site.name}
          </span>
        </header>

        <div className="rounded-lg bg-white/5 p-6">
          <p className="text-lg">
            Welcome, <span className="font-semibold">{session.user.name}</span>.
          </p>
          <p className="mt-2 text-sm text-white/70">
            The expected-loads queue lands in T-005. For now this is the T-004 acceptance checkpoint
            — successful PIN sign-in.
          </p>
        </div>

        <SignOutButton siteCode={site.code} />
      </div>
    </main>
  );
}
