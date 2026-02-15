import { ChangeDetectionStrategy, Component, HostBinding } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

/**
 * WorkspaceSidebarComponent
 *
 * 侧栏插槽组件，便于壳层编排拆分与后续独立 lazy 化。
 */
@Component({
  selector: 'app-workspace-sidebar',
  standalone: true,
  template: '<ng-content></ng-content>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceSidebarComponent {
  @HostBinding('style.display')
  readonly display = FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3 ? 'contents' : 'block';
}
