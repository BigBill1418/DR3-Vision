// Server-side helper for the load-detail page's status pill.
//
// `dock-tile.tsx` is a client component (it consumes the i18n context),
// so server components cannot import a label-formatting helper from
// there without crossing the client boundary. Pulling label resolution
// into this small server-only module keeps the detail page synchronous
// and reuses the same `loadStageLabel` dictionary lookup as the client
// tile.
//
// Locale follows the surrounding RSC: the manager dashboard layout
// has already resolved + provided it via I18nProvider, so we read it
// fresh via `getLocale()` (cookie/session/default precedence).

import 'server-only';

import type { LoadStatus } from '@prisma/client';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary } from '@/i18n/dictionary';
import { loadStageLabel } from '@/lib/loads/labels';

export async function stageLabelForCurrentLocale(status: LoadStatus): Promise<string> {
  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  return loadStageLabel(status, dict);
}
