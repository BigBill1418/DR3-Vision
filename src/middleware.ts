import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth.config';

// Edge-runtime middleware. Imports `authConfig` (the edge-safe base
// config without Prisma-backed providers) rather than the full
// `auth.ts`, which would pull Prisma into the edge bundle and fail
// the middleware build.

const PUBLIC_PATHS = new Set<string>([
  '/',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/healthz',
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/brand/')) return true;
  return false;
}

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const path = req.nextUrl.pathname;
  if (isPublic(path)) return NextResponse.next();
  if (!req.auth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', path);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
