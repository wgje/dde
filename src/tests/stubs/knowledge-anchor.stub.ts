import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-knowledge-anchor',
  standalone: true,
  template: '',
})
export class KnowledgeAnchorStubComponent {
  @Input() taskId: string | null = null;
  @Input() isMobile = false;
  @Input() editable = false;
  @Input() manageable = false;
  @Input() compact = false;
  @Input() previewMode: 'full' | 'deep-link-only' = 'full';
}
