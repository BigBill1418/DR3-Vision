import Image from 'next/image';
import { Suspense } from 'react';
import { LocalePicker } from './locale-picker';
import { LoginForm } from './login-form';
import { VisionIntro } from './vision-intro';
import styles from './vision-intro.module.css';

// Auth surface — uses the dark + canonical-logo treatment per ADR-0014.
export const metadata = { title: 'Sign in — DR3-Vision' };

// Pre-paint guard: for a first-visit user with motion allowed, hide the login
// content (.shell) BEFORE it can paint, so the cinematic intro (VisionIntro)
// covers it with no flash. Runs synchronously during body parse, ahead of the
// content below it. The intro effect clears the class to reveal the login.
const INTRO_GUARD = `(function(){try{
if(sessionStorage.getItem('dr3-intro-seen'))return;
if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
document.documentElement.classList.add('dr3-intro-playing');
}catch(e){}})();`;

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6">
      <script dangerouslySetInnerHTML={{ __html: INTRO_GUARD }} />
      <div className={`flex w-full max-w-md flex-col items-center gap-8 ${styles['shell']}`}>
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          // Screen-blend drops the logo's near-black field so the cyan eye +
          // wordmark float on the deep-space page — and it matches the intro's
          // treatment, so the cinematic logo hands off seamlessly to this one.
          className="h-auto w-full mix-blend-screen drop-shadow-[0_0_22px_rgba(80,240,224,0.28)]"
        />
        {/* Locale picker sits above the form so a non-English-speaking
            operator can switch languages BEFORE attempting credentials. */}
        <LocalePicker />
        {/* Suspense boundary needed because LoginForm uses useSearchParams */}
        <Suspense fallback={<div className="h-48 w-full" />}>
          <LoginForm />
        </Suspense>
      </div>
      <VisionIntro />
    </main>
  );
}
