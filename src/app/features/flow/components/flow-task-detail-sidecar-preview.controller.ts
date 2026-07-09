import type { TaskSidecarBadge } from '../../../../utils/task-sidecar';

const SIDECAR_BADGE_PREVIEW_WIDTH_PX = 180;
const SIDECAR_BADGE_PREVIEW_MARGIN_PX = 8;
const SIDECAR_BADGE_PREVIEW_GAP_PX = 8;

export class FlowTaskDetailSidecarPreviewController {
  private element: HTMLElement | null = null;

  show(event: Event, badge: TaskSidecarBadge): void {
    const text = badge.tooltipText || badge.label;
    if (!text) return;

    const target = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : event.target instanceof HTMLElement
        ? event.target
        : null;
    if (!target) return;

    const preview = this.getOrCreateElement();
    this.render(preview, badge.label, text);
    this.prepareForMeasure(preview);

    const rect = target.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    const previewWidth = previewRect.width || SIDECAR_BADGE_PREVIEW_WIDTH_PX;
    const previewHeight = previewRect.height || 48;
    let left = rect.right + SIDECAR_BADGE_PREVIEW_GAP_PX;
    if (left + previewWidth > window.innerWidth - SIDECAR_BADGE_PREVIEW_MARGIN_PX) {
      left = Math.max(
        SIDECAR_BADGE_PREVIEW_MARGIN_PX,
        rect.left - SIDECAR_BADGE_PREVIEW_GAP_PX - previewWidth,
      );
    }
    const top = Math.min(
      window.innerHeight - previewHeight - SIDECAR_BADGE_PREVIEW_MARGIN_PX,
      Math.max(SIDECAR_BADGE_PREVIEW_MARGIN_PX, rect.top + rect.height / 2 - previewHeight / 2),
    );

    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
    preview.style.visibility = 'visible';
    preview.style.opacity = '1';
  }

  hide(): void {
    this.element?.remove();
    this.element = null;
  }

  private getOrCreateElement(): HTMLElement {
    if (this.element) return this.element;

    const element = document.createElement('div');
    element.dataset['testid'] = 'flow-task-sidecar-badge-preview';
    element.setAttribute('aria-hidden', 'true');
    this.applyFrameStyle(element);
    document.body.appendChild(element);
    this.element = element;
    return element;
  }

  private render(element: HTMLElement, label: string, text: string): void {
    element.replaceChildren();

    const header = document.createElement('div');
    this.applyHeaderStyle(header);
    const dot = document.createElement('span');
    this.applyDotStyle(dot);
    const title = document.createElement('span');
    title.textContent = label;
    header.append(dot, title);

    const content = document.createElement('div');
    content.textContent = text;
    content.style.overflowWrap = 'anywhere';

    element.append(header, content);
  }

  private prepareForMeasure(element: HTMLElement): void {
    element.style.visibility = 'hidden';
    element.style.opacity = '0';
    element.style.left = '0px';
    element.style.top = '0px';
  }

  private applyFrameStyle(element: HTMLElement): void {
    Object.assign(element.style, {
      position: 'fixed',
      zIndex: '90',
      width: `${SIDECAR_BADGE_PREVIEW_WIDTH_PX}px`,
      maxWidth: 'calc(100vw - 16px)',
      pointerEvents: 'none',
      borderRadius: '8px',
      border: '1px solid color-mix(in srgb, var(--theme-border, #57534e) 70%, transparent)',
      background: 'color-mix(in srgb, var(--theme-card-bg, #292524) 96%, transparent)',
      color: 'var(--theme-text, #e7e5e4)',
      boxShadow: '0 10px 24px rgba(28, 25, 23, 0.22)',
      padding: '6px 8px',
      fontSize: '10px',
      lineHeight: '1.35',
      backdropFilter: 'blur(8px)',
      transition: 'opacity 120ms ease',
    });
  }

  private applyHeaderStyle(header: HTMLElement): void {
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      marginBottom: '2px',
      color: 'var(--theme-muted, #a8a29e)',
      fontSize: '9px',
      fontWeight: '600',
    });
  }

  private applyDotStyle(dot: HTMLElement): void {
    Object.assign(dot.style, {
      width: '6px',
      height: '6px',
      borderRadius: '9999px',
      background: '#f59e0b',
      opacity: '0.78',
      flexShrink: '0',
    });
  }
}
