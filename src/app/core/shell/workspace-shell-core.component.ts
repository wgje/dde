import { ChangeDetectionStrategy, Component, HostBinding } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

/**
 * WorkspaceShellCoreComponent
 *
 * 仅承载主壳层布局插槽，语义保持在 WorkspaceShellComponent。
 * 使用 display: contents 避免引入额外布局层级和 CLS。
 */
@Component({
  selector: 'app-workspace-shell-core',
  standalone: true,
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceShellCoreComponent {
  @HostBinding('style.display')
  readonly display = FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3 ? 'contents' : 'block';
}
