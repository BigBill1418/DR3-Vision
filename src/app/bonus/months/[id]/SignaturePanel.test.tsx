// SignaturePanel — slot labels are SITE-aware (CLAUDE.md hard rule #2).
//
// The panel must build its "Sign as …" button + "Sign on behalf of …" copy from
// the chain-resolved signer names passed in as props (facilityAssignee /
// opsAssignee), NEVER from hardcoded Woodland literals. A Woodland period shows
// Janette/Morena; a Eugene period shows Rick/Kelsey — same component, different
// props. Rendered to static markup (same style as vision-tile.test.tsx); the
// only client hook (`useRouter`) is mocked.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { SignaturePanel } from './SignaturePanel';

const WOODLAND = { facilityAssignee: 'Janette Tomas', opsAssignee: 'Morena Gomez' };
const EUGENE = { facilityAssignee: 'Rick Albritton', opsAssignee: 'Kelsey Ruhland' };

describe('SignaturePanel — site-aware slot labels', () => {
  it('Woodland facility signer sees "Sign as Facility Manager (Janette Tomas)"', () => {
    const html = renderToStaticMarkup(
      <SignaturePanel
        monthId="m1"
        viewerSlot="facility"
        {...WOODLAND}
        facilitySigned={false}
        opsSigned={false}
      />,
    );
    expect(html).toContain('Sign as Facility Manager (Janette Tomas)');
    expect(html).not.toMatch(/Rick|Kelsey/);
  });

  it('Eugene facility signer sees "Sign as Facility Manager (Rick Albritton)"', () => {
    const html = renderToStaticMarkup(
      <SignaturePanel
        monthId="m1"
        viewerSlot="facility"
        {...EUGENE}
        facilitySigned={false}
        opsSigned={false}
      />,
    );
    expect(html).toContain('Sign as Facility Manager (Rick Albritton)');
    // No Woodland names leak onto a Eugene period.
    expect(html).not.toMatch(/Janette|Morena/);
  });

  it('Eugene ops signer sees "Sign as Operations Manager (Kelsey Ruhland)"', () => {
    const html = renderToStaticMarkup(
      <SignaturePanel
        monthId="m1"
        viewerSlot="ops"
        {...EUGENE}
        facilitySigned={false}
        opsSigned={false}
      />,
    );
    expect(html).toContain('Sign as Operations Manager (Kelsey Ruhland)');
  });

  it('override link reads "Sign on behalf of <chain name>" for the target slot', () => {
    // Eugene admin (no natural slot) authorized to override the facility slot:
    // the override link must name Rick, not a hardcoded Woodland signer.
    const html = renderToStaticMarkup(
      <SignaturePanel
        monthId="m1"
        viewerSlot={null}
        {...EUGENE}
        facilitySigned={false}
        opsSigned={false}
        overridableSlots={['facility']}
      />,
    );
    expect(html).toContain('Sign on behalf of Rick Albritton');
    expect(html).not.toMatch(/Janette|Morena/);
  });
});
