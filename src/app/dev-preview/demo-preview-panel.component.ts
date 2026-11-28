import { DemoTaskArchivePreviewComponent } from './demo-task-archive-preview.component';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { DemoBlackBoxPreviewComponent } from './demo-black-box-preview.component';
import { DemoDockEntryPreviewComponent } from './demo-dock-entry-preview.component';
@Component({
  selector: 'app-demo-preview-panel', standalone: true, imports: [DemoTaskArchivePreviewComponent, DemoFlowPreviewComponent, DemoBlackBoxPreviewComponent, DemoDockEntryPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (widget()) { @case ('task-archive') { <app-demo-task-archive-preview [previewState]="state()" /> } @case ('flow') { <app-demo-flow-preview [state]="state()" /> } @case ('inbox') { <app-demo-black-box-preview [state]="state()" /> } @case ('dock') { <app-demo-dock-entry-preview [state]="state()" /> } }`,
})
export class DemoPreviewPanelComponent {
  readonly widget = input('flow');
  readonly state = input('overview-dense');
}
