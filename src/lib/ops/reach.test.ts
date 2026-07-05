import { describe, expect, it } from 'vitest';
import { canSeeRow, canWriteRow, hasOrgReach, reachWhere, type OpsViewer } from './reach';

const admin: OpsViewer = { role: 'admin', primarySiteId: null, allSites: false };
const allSitesMgr: OpsViewer = { role: 'manager', primarySiteId: 'eugene', allSites: true };
const woodlandMgr: OpsViewer = { role: 'manager', primarySiteId: 'woodland', allSites: false };
const operator: OpsViewer = { role: 'operator', primarySiteId: 'woodland', allSites: false };

describe('reach — hard rule #2 (site reach, not admin powers)', () => {
  it('org reach = admin OR all_sites', () => {
    expect(hasOrgReach(admin)).toBe(true);
    expect(hasOrgReach(allSitesMgr)).toBe(true);
    expect(hasOrgReach(woodlandMgr)).toBe(false);
    expect(hasOrgReach(operator)).toBe(false);
  });

  it('site rows: visible to that site manager, all_sites, admin — not other-site managers', () => {
    expect(canSeeRow(woodlandMgr, 'woodland')).toBe(true);
    expect(canSeeRow(woodlandMgr, 'eugene')).toBe(false);
    expect(canSeeRow(allSitesMgr, 'woodland')).toBe(true);
    expect(canSeeRow(admin, 'eugene')).toBe(true);
  });

  it('org-wide rows (site_id null): only admin / all_sites', () => {
    expect(canSeeRow(admin, null)).toBe(true);
    expect(canSeeRow(allSitesMgr, null)).toBe(true);
    expect(canSeeRow(woodlandMgr, null)).toBe(false);
  });

  it('operators reach nothing', () => {
    expect(canSeeRow(operator, 'woodland')).toBe(false);
    expect(canSeeRow(operator, null)).toBe(false);
    expect(canWriteRow(operator, 'woodland')).toBe(false);
  });

  it('reachWhere adds the org-wide clause only for org-reach viewers', () => {
    expect(reachWhere(woodlandMgr, 'woodland')).toEqual({ OR: [{ site_id: 'woodland' }] });
    expect(reachWhere(admin, 'woodland')).toEqual({ OR: [{ site_id: 'woodland' }, { site_id: null }] });
    expect(reachWhere(allSitesMgr, 'eugene')).toEqual({ OR: [{ site_id: 'eugene' }, { site_id: null }] });
  });
});
