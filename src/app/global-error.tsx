'use client';

// Top-level App Router error boundary (ADR-0022 §2). React rendering errors that
// escape every nested boundary land here; we report them to GlitchTip before
// showing a minimal fallback. Sentry no-ops when no DSN is configured (fail-open).
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#00524C',
          color: '#FCFFD7',
          fontFamily: 'Inter, system-ui, sans-serif',
          textAlign: 'center',
          padding: '1.5rem',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ marginTop: '0.5rem', opacity: 0.8 }}>
          The error has been reported. Please refresh, or contact your administrator if it
          persists.
        </p>
      </body>
    </html>
  );
}
