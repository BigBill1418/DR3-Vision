// ADR-0064 — the new /admin route-group layout must give every admin page an
// in-app path back to the Vision Dashboard (/). Admin is English-only (ADR-0017)
// so it renders the bar directly with no I18nProvider.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AdminLayout from './layout';

describe('AdminLayout (ADR-0064)', () => {
  it('renders a link back to the dashboard (/) and its children', () => {
    const html = renderToStaticMarkup(
      <AdminLayout>
        <div data-testid="child">admin page</div>
      </AdminLayout>,
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('Back to dashboard');
    expect(html).toContain('admin page');
  });
});
