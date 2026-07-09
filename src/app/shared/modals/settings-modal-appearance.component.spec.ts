import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { SettingsModalAppearanceComponent } from './settings-modal-appearance.component';
import type { ColorMode, ThemeType } from '../../../models';

describe('SettingsModalAppearanceComponent', () => {
  let fixture: ComponentFixture<SettingsModalAppearanceComponent>;
  let component: SettingsModalAppearanceComponent;

  const theme = signal<ThemeType>('default');
  const colorMode = signal<ColorMode>('system');

  beforeEach(async () => {
    theme.set('default');
    colorMode.set('system');

    await TestBed.configureTestingModule({
      imports: [SettingsModalAppearanceComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsModalAppearanceComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('theme', theme());
    fixture.componentRef.setInput('colorMode', colorMode());
    fixture.detectChanges();
  });

  it('renders color mode and theme options', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('外观风格');
    expect(text).toContain('颜色模式');
    expect(text).toContain('浅色');
    expect(text).toContain('自动');
    expect(text).toContain('深色');
    expect(text).toContain('默认');
    expect(text).toContain('海洋');
    expect(text).toContain('森林');
    expect(text).toContain('日落');
    expect(text).toContain('薰衣草');
  });

  it('emits selected color mode and theme', () => {
    const colorModeSpy = vi.fn();
    const themeSpy = vi.fn();
    component.colorModeChange.subscribe(colorModeSpy);
    component.themeChange.subscribe(themeSpy);

    findButtonByText('深色').click();
    findButtonByText('海洋').click();

    expect(colorModeSpy).toHaveBeenCalledWith('dark');
    expect(themeSpy).toHaveBeenCalledWith('ocean');
  });

  function findButtonByText(text: string): HTMLButtonElement {
    const buttons = fixture.debugElement.queryAll(By.css('button'));
    const match = buttons.find(button => (button.nativeElement.textContent as string).includes(text));
    if (!match) {
      throw new Error(`Button not found: ${text}`);
    }
    return match.nativeElement as HTMLButtonElement;
  }
});
