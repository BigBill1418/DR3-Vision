// ADR-0141 — submit an invoice the team received directly.
//
// Multipart: the invoice file(s) are required. AUTHORIZATION is
// `teamSubmitAccess`: a manager only at their own primary site, an admin at any
// site, and only admins while `ui/ap_team_submit` is pilot for the site. The
// submitter and the site come from the SESSION and the URL, never the body.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  TeamSubmitError,
  parseAmountCents,
  submitTeamInvoice,
  teamSubmitAccess,
  type TeamSubmitFile,
} from '@/lib/ap/team-submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORBIDDEN: Record<string, string> = {
  forbidden_role: 'Only managers and admins can submit invoices.',
  forbidden_site: 'You can submit invoices only for your own site.',
  pilot: 'Invoice submission is not open at this site yet.',
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ site: string }> },
): Promise<Response> {
  const { site: siteCode } = await ctx.params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const site = await prisma.site.findUnique({ where: { code: siteCode }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'site_not_found' }, { status: 404 });

  const access = await teamSubmitAccess(
    { role: session.user.role, primarySiteId: session.user.primary_site_id ?? null },
    site.id,
  );
  if (access !== 'ok') {
    return NextResponse.json({ error: access, message: FORBIDDEN[access] }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const str = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v.trim() : '';
  };

  const amountCents = parseAmountCents(str('amount'));
  if (amountCents === null) {
    return NextResponse.json(
      { error: 'invalid_amount', message: 'Enter the invoice amount, for example 1,240.50.' },
      { status: 400 },
    );
  }

  const files: TeamSubmitFile[] = [];
  for (const entry of form.getAll('files')) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    files.push({
      name: entry.name || 'invoice',
      contentType: entry.type || 'application/octet-stream',
      bytes: new Uint8Array(await entry.arrayBuffer()),
    });
  }

  try {
    const result = await submitTeamInvoice({
      prisma,
      submitter: { userId: session.user.id, email: session.user.email ?? null },
      siteId: site.id,
      accountantId: str('accountantId'),
      vendor: str('vendor'),
      invoiceNumber: str('invoiceNumber'),
      amountCents,
      purpose: str('purpose'),
      files,
    });
    return NextResponse.json({ ok: true, id: result.requestId });
  } catch (e) {
    if (e instanceof TeamSubmitError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
