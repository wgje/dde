import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundaryComponent } from './error-boundary.component';
import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import { LoggerService } from '../../../services/logger.service';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
};

describe('ErrorBoundaryComponent theme contract', () => {
  it('暗色样式应绑定到 data-color-mode，而不是错误的 data-theme', () => {
    const styles = ((ErrorBoundaryComponent as unknown as { ɵcmp?: { styles?: string[] } }).ɵcmp?.styles ?? []).join(' ');

    expect(styles).toContain('[data-color-mode="dark"]');
    expect(styles).not.toContain('[data-theme="dark"]');
  });
});

describe('ErrorBoundaryComponent retry handling', () => {
  async function render(): Promise<ComponentFixture<ErrorBoundaryComponent>> {
    await TestBed.configureTestingModule({
      imports: [ErrorBoundaryComponent],
      providers: [
        { provide: GlobalErrorHandler, useValue: { handleError: vi.fn() } },
        { provide: LoggerService, useValue: { category: () => logger } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(ErrorBoundaryComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('captures asynchronous retry failures back into the boundary state', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.setError(new Error('initial failure'));
    component.onRetry = () => Promise.reject(new Error('retry failed')) as unknown as void;

    component.retry();
    await Promise.resolve();

    expect(component.hasError()).toBe(true);
    expect(component.errorDetails()).toContain('retry failed');
  });
});
