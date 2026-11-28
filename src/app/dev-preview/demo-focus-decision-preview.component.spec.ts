import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoFocusDecisionPreviewComponent } from './demo-focus-decision-preview.component';
import { DockPendingDecisionComponent } from '../features/parking/components/dock-pending-decision.component';
import { DockFragmentCountdownComponent } from '../features/parking/components/dock-fragment-countdown.component';

describe('real Focus decision/countdown preview leaves', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function render(state: string) {
    await TestBed.configureTestingModule({ imports: [DemoFocusDecisionPreviewComponent] }).compileComponents();
    const view = TestBed.createComponent(DemoFocusDecisionPreviewComponent);
    view.componentRef.setInput('state', state); view.detectChanges(); await view.whenStable(); view.detectChanges();
    return view;
  }
  it('renders actual candidate buttons and choosing one updates the in-memory result', async () => {
    const view = await render('decision');
    try {
      expect(view.debugElement.query(By.directive(DockPendingDecisionComponent))).not.toBeNull();
      const button: HTMLButtonElement = view.nativeElement.querySelector('[data-testid="dock-v3-pending-choice-0"]');
      expect(button.textContent).toContain('整理下一步'); button.click(); view.detectChanges();
      expect(view.nativeElement.textContent).toContain('已选择：整理下一步');
      expect(view.nativeElement.querySelector('[data-testid="dock-v3-pending-decision"]')).toBeNull();
    } finally { view.destroy(); }
  });
  it('cancel acts on the same real decision component without storage writes', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem'); const view = await render('decision');
    try {
      view.nativeElement.querySelector('[data-testid="dock-v3-pending-cancel"]').click(); view.detectChanges();
      expect(view.nativeElement.textContent).toContain('已收起推荐'); expect(write).not.toHaveBeenCalled();
    } finally { view.destroy(); }
  });
  it.each([['fragment-countdown-accept', '已进入碎片任务推荐'], ['fragment-countdown-skip', '已跳过碎片任务']])('countdown real action %s is memory-only', async (testId, result) => {
    const write = vi.spyOn(Storage.prototype, 'setItem'); const interval = vi.spyOn(globalThis, 'setInterval');
    const view = await render('countdown');
    try {
      expect(view.debugElement.query(By.directive(DockFragmentCountdownComponent))).not.toBeNull();
      expect(view.nativeElement.querySelector('[data-testid="fragment-countdown-number"]').textContent).toContain('5s');
      view.nativeElement.querySelector(`[data-testid="${testId}"]`).click(); view.detectChanges();
      expect(view.nativeElement.textContent).toContain(result); expect(write).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    } finally { view.destroy(); }
  });
  it('blocked decision leaves reject programmatic actions as well as disabling buttons', async () => {
    const view = await render('decision');
    try {
      const leaf = view.debugElement.query(By.directive(DockPendingDecisionComponent)).componentInstance as DockPendingDecisionComponent;
      const cancel = vi.spyOn(leaf.cancelRecommendation, 'emit'); const choose = vi.spyOn(leaf.chooseCandidate, 'emit');
      view.componentRef.setInput('blocked', true); view.detectChanges(); leaf.cancel(); leaf.choose(leaf.entries[0].taskId);
      expect(cancel).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
      expect(view.nativeElement.querySelector('[data-testid="dock-v3-pending-choice-0"]').disabled).toBe(true);
    } finally { view.destroy(); }
  });
});
