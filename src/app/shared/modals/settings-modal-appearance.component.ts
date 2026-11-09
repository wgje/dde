import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ThemeType, ColorMode } from '../../../models';

@Component({
  selector: 'app-settings-modal-appearance',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-modal-appearance.component.html',
})
export class SettingsModalAppearanceComponent {
  @Input() theme: ThemeType = 'default';
  @Input() colorMode: ColorMode = 'system';
  @Output() readonly themeChange = new EventEmitter<ThemeType>();
  @Output() readonly colorModeChange = new EventEmitter<ColorMode>();

  updateColorMode(mode: ColorMode): void {
    this.colorModeChange.emit(mode);
  }

  updateTheme(theme: ThemeType): void {
    this.themeChange.emit(theme);
  }
}
