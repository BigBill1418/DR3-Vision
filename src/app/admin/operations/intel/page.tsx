import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { listCampaigns } from '@/lib/survey/campaigns';
import { CampaignList } from './CampaignList';

export const dynamic = 'force-dynamic';

export default async function OperationsIntelPage() {
  const session = await auth();
  if (!session?.user?.is_super_admin) redirect('/');

  const campaigns = await listCampaigns();
  return <CampaignList campaigns={campaigns} />;
}
