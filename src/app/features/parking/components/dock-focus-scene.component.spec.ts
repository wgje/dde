import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockFocusSceneComponent } from './dock-focus-scene.component';

@Component({
  standalone: true,
  imports: [DockFocusSceneComponent],
  template: `
    <app-dock-focus-scene
      [active]="active"
      [scrimOn]="scrimOn"
      [transitionPhase]="transitionPhase">
      <button
        type="button"
        style="pointer-events: auto;"
        data-testid="projected-focus-control">
        Focus Control
      </button>
    </app-dock-focus-scene>
  `,
})
class DockFocusSceneHostComponent {
  active = true;
  scrimOn = false;
  transitionPhase: 'entering' | 'focused' | 'exiting' | null = null;
}

describe('DockFocusSceneComponent', () => {
  let fixture: ComponentFixture<DockFocusSceneComponent>;
  let component: DockFocusSceneComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DockFocusSceneComponent, DockFocusSceneHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DockFocusSceneComponent);
    component = fixture.componentInstance;
  });

  it('keeps stage shell mounted in transparent focus mode', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('scrimOn', false);
    fixture.detectChanges();

    const stage = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]');
    const backdrop = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-backdrop"]');

    expect(stage).toBeTruthy();
    expect(stage.getAttribute('data-scrim')).toBe('off');
    expect(backdrop.classList.contains('active')).toBe(false);
    expect(component.focusStageStyle()['--stage-shell-opacity']).toBe('0.720');
  });

  it('applies steady stage positioning on the inner shell so enter/exit animation does not overwrite it', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('scrimOn', true);
    fixture.componentRef.setInput('transitionPhase', 'entering');
    fixture.componentRef.setInput('stageTransform', 'translateY(96px)');
    fixture.detectChanges();

    const stage = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]') as HTMLElement | null;
    const stageShell = fixture.nativeElement.querySelector('.console-stage-shell') as HTMLElement | null;

    expect(stage).toBeTruthy();
    expect(stage?.style.transform).toBe('');
    expect(stageShell?.style.transform).toBe('translateY(96px)');
  });

  it('should unmount projected controls when transparent focus mode is idle', () => {
    const hostFixture = TestBed.createComponent(DockFocusSceneHostComponent);
    hostFixture.detectChanges();

    const stage = hostFixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]') as HTMLElement | null;

    expect(stage).toBeTruthy();
    expect(stage?.getAttribute('aria-hidden')).toBe('true');
    expect(stage?.hasAttribute('inert')).toBe(true);
    expect(hostFixture.nativeElement.querySelector('[data-testid="projected-focus-control"]')).toBeNull();

    hostFixture.componentInstance.scrimOn = true;
    hostFixture.detectChanges();

    expect(hostFixture.nativeElement.querySelector('[data-testid="projected-focus-control"]')).toBeTruthy();
  });

  it('keeps the full-screen stage transparent to pointer hits outside real controls', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('scrimOn', true);
    fixture.detectChanges();

    const stage = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]') as HTMLElement | null;

    expect(stage).toBeTruthy();
    expect(stage?.style.pointerEvents).toBe('none');
  });

  it('maps scene mode to attrs and palette tokens', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('scrimOn', true);
    fixture.componentRef.setInput('sceneMode', 'burnout');
    fixture.detectChanges();

    const scene = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-scene"]');
    const stage = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]');

    expect(scene.getAttribute('data-scene')).toBe('burnout');
    expect(stage.getAttribute('data-scene')).toBe('burnout');
    expect(component.focusSceneStyle()['--scene-primary-rgb']).toBe('245 158 11');
    expect(component.focusStageStyle()['--stage-primary-rgb']).toBe('245 158 11');
  });

  it('disables loop motion in T2 and reduced-motion profiles', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('sceneMode', 'decision');
    fixture.componentRef.setInput('performanceTier', 'T2');
    fixture.detectChanges();

    expect(component.focusSceneStyle()['--scene-grain-opacity']).toBe('0.000');
    expect(component.focusSceneStyle()['--scene-drift-duration']).toBe('0s');
    expect(component.focusStageStyle()['--stage-pulse-duration']).toBe('0s');

    fixture.componentRef.setInput('performanceTier', 'T1');
    fixture.componentRef.setInput('reducedMotion', true);
    fixture.detectChanges();

    expect(component.focusSceneStyle()['--scene-drift-duration']).toBe('0s');
    expect(component.focusSceneStyle()['--scene-pulse-duration']).toBe('0s');
    expect(component.focusStageStyle()['--stage-pulse-duration']).toBe('0s');
  });

  it('exposes fragment and zen scene attrs for downstream layers', () => {
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('sceneMode', 'fragment');
    fixture.detectChanges();

    let scene = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-scene"]');
    expect(scene.getAttribute('data-scene')).toBe('fragment');

    fixture.componentRef.setInput('sceneMode', 'zen');
    fixture.detectChanges();

    scene = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-scene"]');
    expect(scene.getAttribute('data-scene')).toBe('zen');
    expect(component.focusSceneStyle()['--scene-primary-rgb']).toBeTruthy();
  });

  it('emits transitionSettled when stage animation completes', () => {
    const settled = vi.fn();
    component.transitionSettled.subscribe(settled);
    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('scrimOn', true);
    fixture.componentRef.setInput('transitionPhase', 'entering');
    fixture.detectChanges();

    component.onStageAnimationEnd({ animationName: 'focusStageEnter' } as AnimationEvent);

    expect(settled).toHaveBeenCalledWith('entering');
  });

  it('keeps projected controls mounted during exit transition even after active state turns false', () => {
    const hostFixture = TestBed.createComponent(DockFocusSceneHostComponent);
    hostFixture.componentInstance.active = false;
    hostFixture.componentInstance.scrimOn = false;
    hostFixture.componentInstance.transitionPhase = 'exiting';
    hostFixture.detectChanges();

    const stage = hostFixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]') as HTMLElement | null;

    expect(stage).toBeTruthy();
    expect(stage?.getAttribute('data-transition')).toBe('exiting');
    expect(hostFixture.nativeElement.querySelector('[data-testid="projected-focus-control"]')).toBeTruthy();
  });

  it('short-circuits transitionSettled in T2 profile without waiting for animation', async () => {
    const settled = vi.fn();
    component.transitionSettled.subscribe(settled);

    fixture.componentRef.setInput('active', true);
    fixture.componentRef.setInput('performanceTier', 'T2');
    fixture.componentRef.setInput('transitionPhase', 'exiting');
    fixture.detectChanges();
    await Promise.resolve();

    expect(settled).toHaveBeenCalledWith('exiting');
  });
});
