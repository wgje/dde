import { ChangeDetectionStrategy, Component, HostBinding } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

/**
 * WorkspaceOverlaysComponent
 *
 * Overlay 插槽组件（Toast/Offline/PWA Prompt 等），
 * 保持模板语义不变，仅用于组合式壳层拆分。
 */
@Component({
  selector: 'app-workspace-overlays',
  standalone: true,
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceOverlaysComponent {
  @HostBinding('style.display')
  readonly display = FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3 ? 'contents' : 'block';
}
