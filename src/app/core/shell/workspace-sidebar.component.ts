import { Directive, HostBinding } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

/**
 * WorkspaceSidebarComponent
 *
 * 侧栏插槽指令，便于壳层编排拆分与后续独立 lazy 化。
 */
@Directive({
  selector: 'app-workspace-sidebar',
  standalone: true,
})
export class WorkspaceSidebarComponent {
  @HostBinding('style.display')
  readonly display = FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3 ? 'contents' : 'block';
}
