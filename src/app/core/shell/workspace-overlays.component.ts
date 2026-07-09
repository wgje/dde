import { Directive, HostBinding } from '@angular/core';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

/**
 * WorkspaceOverlaysComponent
 *
 * Overlay 插槽指令（Toast/Offline/PWA Prompt 等），
 * 保持宿主语义不变，仅用于组合式壳层拆分。
 */
@Directive({
  selector: 'app-workspace-overlays',
  standalone: true,
})
export class WorkspaceOverlaysComponent {
  @HostBinding('style.display')
  readonly display = FEATURE_FLAGS.WORKSPACE_SHELL_COMPOSITION_V3 ? 'contents' : 'block';
}
