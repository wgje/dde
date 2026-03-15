import { describe, expect, it } from 'vitest';
import { ErrorBoundaryComponent } from './error-boundary.component';

describe('ErrorBoundaryComponent theme contract', () => {
  it('暗色样式应绑定到 data-color-mode，而不是错误的 data-theme', () => {
    const styles = ((ErrorBoundaryComponent as unknown as { ɵcmp?: { styles?: string[] } }).ɵcmp?.styles ?? []).join(' ');

    expect(styles).toContain('[data-color-mode="dark"]');
    expect(styles).not.toContain('[data-theme="dark"]');
  });
});
