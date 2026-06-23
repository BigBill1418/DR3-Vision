import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getCampaignWithInvites } from '@/lib/survey/campaigns';
import { CampaignDetail } from './CampaignDetail';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ campaignId: string }>;
}

export default async function CampaignDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.is_super_admin) redirect('/');

  const { campaignId } = await params;
  const campaign = await getCampaignWithInvites(campaignId);
  if (!campaign) notFound();
  return <CampaignDetail campaign={campaign} />;
}
