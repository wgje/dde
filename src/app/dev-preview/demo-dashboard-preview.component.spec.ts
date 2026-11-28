import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { DashboardModalComponent } from '../shared/modals/dashboard-modal.component';
import { DemoDashboardPreviewComponent } from './demo-dashboard-preview.component';

async function render(state: string) {
  await TestBed.configureTestingModule({ imports: [DemoDashboardPreviewComponent] }).compileComponents();
  const fixture = TestBed.createComponent(DemoDashboardPreviewComponent);
  fixture.componentRef.setInput('state', state);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('DemoDashboardPreviewComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('mounts the real dashboard status tab with local-only normal state', async () => {
    const fixture = await render('status');
    expect(fixture.debugElement.query(By.directive(DashboardModalComponent))).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('系统仪表盘');
    expect(fixture.nativeElement.textContent).toContain('数据保存在本地');
    expect(fixture.componentInstance.memory.currentUserId()).toBeNull();
  });

  it('shows the queue fixture immediately and the real retry button changes only memory', async () => {
    const fixture = await render('queue');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const network = vi.spyOn(globalThis, 'fetch');
    const button = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(item => item.textContent?.includes('立即同步'));
    expect(button).toBeTruthy();
    expect(fixture.componentInstance.memory.queueSize()).toBe(2);
    button!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.memory.queueSize()).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('所有操作已同步完成');
    expect(storageWrite).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    storageWrite.mockRestore(); network.mockRestore();
  });

  it('fresh component instances restore the sample after a local interaction', async () => {
    const first = await render('queue');
    await first.componentInstance.memory.processQueue();
    expect(first.componentInstance.memory.queueSize()).toBe(0);
    first.destroy();
    TestBed.resetTestingModule();
    const second = await render('queue');
    expect(second.componentInstance.memory.queueSize()).toBe(2);
  });
});