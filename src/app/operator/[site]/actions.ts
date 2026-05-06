'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth, signOut } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import * as svc from '@/lib/load-service';
import type { CountMode, ConcernCategory, RejectionCategory } from '@prisma/client';

// Server-action wrappers for the operator workflow. Every action
// re-derives operator + site from the active session (no client-trusted
// site or operator ids) and then dispatches to `load-service` which
// owns the state-machine guards.

async function ctx(siteCode: string) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'operator') {
    throw new Error('not authenticated as operator');
  }
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true },
  });
  if (!site) throw new Error('unknown site');
  if (session.user.primary_site_id !== site.id) {
    throw new Error('operator not assigned to this site');
  }
  return { operatorUserId: session.user.id, siteId: site.id, siteCode };
}

export async function startLoadAction(siteCode: string, expectedLoadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  const created = await svc.startInboundLoad({
    expectedLoadId,
    siteId,
    operatorUserId,
  });
  revalidatePath(`/operator/${siteCode}/queue`);
  redirect(`/operator/${siteCode}/load/${created.id}`);
}

export async function bolCapturedAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordBolCapture({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function weightSkipAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordWeightSkip({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function weightCapturedAction(
  siteCode: string,
  loadId: string,
  weightLbs: number,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordWeightCapture({ loadId, operatorUserId, siteId, weightLbs });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function doorOpenCapturedAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordDoorOpenCapture({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function beginUnloadAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.beginUnload({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function addStackAction(
  siteCode: string,
  loadId: string,
  stackIndex: number,
  unitCount: number,
  countMode: CountMode,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.addStack({ loadId, operatorUserId, siteId, stackIndex, unitCount, countMode });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function finishUnloadAction(
  siteCode: string,
  loadId: string,
  countMode: CountMode,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.finishUnload({ loadId, operatorUserId, siteId, countMode });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function addConcernAction(
  siteCode: string,
  loadId: string,
  category: ConcernCategory,
  note: string | null,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.addConcern({ loadId, operatorUserId, siteId, category, note });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function submitLoadAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.submitLoad({ loadId, operatorUserId, siteId });
  await signOut({ redirect: false });
  revalidatePath(`/operator/${siteCode}/queue`);
  redirect(`/operator/${siteCode}`);
}

export async function rejectLoadAction(
  siteCode: string,
  loadId: string,
  category: RejectionCategory,
  note: string | null,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.rejectLoad({ loadId, operatorUserId, siteId, category, note });
  await signOut({ redirect: false });
  revalidatePath(`/operator/${siteCode}/queue`);
  redirect(`/operator/${siteCode}`);
}
