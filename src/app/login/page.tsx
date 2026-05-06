import Image from 'next/image';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

// Auth surface — uses the dark + canonical-logo treatment per ADR-0014.
export const metadata = { title: 'Sign in — DR3-Vision' };

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-black px-6">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          className="h-auto w-full"
        />
        {/* Suspense boundary needed because LoginForm uses useSearchParams */}
        <Suspense fallback={<div className="h-48 w-full" />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
