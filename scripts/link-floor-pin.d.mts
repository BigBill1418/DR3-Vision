// Type surface for scripts/link-floor-pin.mjs (ADR-0072 Am.2), so the vitest suite
// can import the parser and the injectable linker under allowJs:false.
export const ACTOR_LABEL: string;
export interface LinkOpts {
  apply: boolean;
  clear: boolean;
  actor: string;
  manager: string;
  operator: string;
}
export interface LinkedAccount {
  id: string;
  name: string;
  role: string;
  site: string | null;
}
export class LinkRefused extends Error {}
export function parseArgs(argv: string[]): LinkOpts;
export function linkFloorPin(
  prisma: unknown,
  opts: LinkOpts,
): Promise<{
  action: 'link' | 'clear' | 'none';
  applied?: boolean;
  reason?: string;
  manager: LinkedAccount;
  operator?: LinkedAccount;
  previous?: string;
}>;
