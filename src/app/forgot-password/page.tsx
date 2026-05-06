import Image from 'next/image';
import { ForgotForm } from './forgot-form';

export const metadata = { title: 'Forgot password — DR3-Vision' };

export default function ForgotPasswordPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-black px-6">
      <div className="flex w-full max-w-md flex-col items-center gap-8 text-center">
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          className="h-auto w-full"
        />
        <ForgotForm />
      </div>
    </main>
  );
}
