'use client';

// Vision Dashboard intro overlay (the <3s cinematic eye-logo reveal). Plays
// ONCE per browser session on the login surface, then unmounts and the login
// resolves in. Gated by sessionStorage; never plays for prefers-reduced-motion.
//
// Flash-free handoff: a pre-paint inline script in page.tsx adds
// `html.dr3-intro-playing` for first-visit non-reduced users, which hides the
// login content (.shell) before it can paint. This effect mounts the opaque
// intro, then ~2.0s in removes that class so the login fades in beneath the
// intro's own fade-out (a cross-fade), then unmounts the intro at ~2.8s.

import { useEffect, useState } from 'react';
import styles from './vision-intro.module.css';

const SEEN_KEY = 'dr3-intro-seen';
const PLAYING_CLASS = 'dr3-intro-playing';

export function VisionIntro() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const armedByScript = html.classList.contains(PLAYING_CLASS);
    let firstVisit = true;
    let reduced = false;
    try {
      firstVisit = !sessionStorage.getItem(SEEN_KEY);
      reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      // sessionStorage/matchMedia unavailable → fall back to the script's signal.
    }

    // Play if the pre-paint script armed us, or (defensive) it's a first visit
    // with motion allowed. Otherwise ensure the login content is shown.
    if (!(armedByScript || (firstVisit && !reduced))) {
      html.classList.remove(PLAYING_CLASS);
      return;
    }

    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setShow(true);

    // Reveal the login (cross-fades with the intro's introOut at 2.02s).
    const reveal = window.setTimeout(() => html.classList.remove(PLAYING_CLASS), 2000);
    // Unmount the (fully faded) intro after its introOut completes (~2.64s).
    const end = window.setTimeout(() => setShow(false), 2800);

    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(end);
      html.classList.remove(PLAYING_CLASS);
    };
  }, []);

  if (!show) return null;

  return (
    <div className={styles['intro']} aria-hidden="true" role="presentation">
      <div className={styles['nebula']} />
      <div className={styles['stars']} />
      {/* eslint-disable-next-line @next/next/no-img-element -- animated brand asset, next/image's wrapper fights the mix-blend/transform layering */}
      <img className={styles['logo']} src="/brand/dr3-vision-logo.jpg" alt="" />
      <div className={styles['scanwrap']}>
        <div className={styles['scan']} />
      </div>
      <div className={styles['flash']} />
    </div>
  );
}
