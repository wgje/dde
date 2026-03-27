import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { LaunchSnapshot } from './services/launch-snapshot.service';
import type { BootStage } from './services/boot-stage.service';

/**
 * 启动壳组件 — Angular 引导后、工作区接管前的过渡 UI。
 *
 * 同源声明：index.html 中的 `#snapshot-shell` 是本组件的纯 HTML 镜像，
 * 用于 Angular 引导之前立即渲染 localStorage 快照（消除冷启动黑屏）。
 * 二者的视觉语言（CSS class 前缀 `lsh-` / `launch-shell__`）、布局结构
 * 和数据格式必须保持一致。若修改本组件，请同步更新 index.html #snapshot-shell。
 */
@Component({
  selector: 'app-launch-shell',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host {
      position: fixed;
      inset: 0;
      z-index: 99997;
      display: block;
      background:
        radial-gradient(circle at top left, rgba(79, 70, 229, 0.16), transparent 34%),
        radial-gradient(circle at bottom right, rgba(13, 148, 136, 0.14), transparent 30%),
        linear-gradient(180deg, #fafaf9 0%, #f5f5f4 100%);
      color: #1c1917;
      transition: opacity 200ms ease-out;
    }

    :host-context(.launch-shell--fading-out) {
      opacity: 0;
      pointer-events: none;
    }

    .launch-shell {
      display: flex;
      min-height: 100%;
      padding: 24px 18px;
      box-sizing: border-box;
      align-items: stretch;
      justify-content: center;
    }

    .launch-shell__panel {
      width: min(100%, 560px);
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 20px;
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.86);
      border: 1px solid rgba(231, 229, 228, 0.92);
      box-shadow: 0 20px 48px rgba(28, 25, 23, 0.08);
      backdrop-filter: blur(14px);
    }

    .launch-shell__eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #57534e;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .launch-shell__dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #4f46e5;
      box-shadow: 0 0 0 8px rgba(79, 70, 229, 0.08);
    }

    .launch-shell__title {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      font-weight: 700;
    }

    .launch-shell__subtitle {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      color: #57534e;
    }

    .launch-shell__status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(79, 70, 229, 0.08);
      color: #4338ca;
      font-size: 12px;
      font-weight: 600;
      width: fit-content;
    }

    .launch-shell__pulse {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
      animation: launch-shell-pulse 1.4s ease-in-out infinite;
    }

    .launch-shell__grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .launch-shell__project {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border-radius: 18px;
      background: rgba(250, 250, 249, 0.95);
      border: 1px solid rgba(231, 229, 228, 0.92);
    }

    .launch-shell__project--active {
      border-color: rgba(79, 70, 229, 0.28);
      background: rgba(238, 242, 255, 0.85);
    }

    .launch-shell__project-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .launch-shell__project-name {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
    }

    .launch-shell__project-meta {
      font-size: 12px;
      color: #78716c;
      white-space: nowrap;
    }

    .launch-shell__project-desc {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: #57534e;
    }

    .launch-shell__task-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .launch-shell__task {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: #292524;
    }

    .launch-shell__task-id {
      min-width: 28px;
      font-variant-numeric: tabular-nums;
      color: #78716c;
      font-size: 12px;
    }

    .launch-shell__task-status {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #0d9488;
      flex-shrink: 0;
    }

    .launch-shell__task-status--completed {
      background: #a8a29e;
    }

    .launch-shell__empty {
      display: grid;
      gap: 12px;
    }

    .launch-shell__placeholder {
      height: 18px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(231, 229, 228, 0.7), rgba(245, 245, 244, 1), rgba(231, 229, 228, 0.7));
      background-size: 240% 100%;
      animation: launch-shell-shimmer 1.6s linear infinite;
    }

    .launch-shell__placeholder--short {
      width: 42%;
    }

    .launch-shell__placeholder--medium {
      width: 64%;
    }

    .launch-shell__footer {
      font-size: 12px;
      color: #78716c;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-top: 4px;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        background:
          radial-gradient(circle at top left, rgba(129, 140, 248, 0.24), transparent 34%),
          radial-gradient(circle at bottom right, rgba(52, 211, 153, 0.14), transparent 30%),
          linear-gradient(180deg, #111827 0%, #0f172a 100%);
        color: #f5f5f4;
      }

      .launch-shell__panel {
        background: rgba(17, 24, 39, 0.88);
        border-color: rgba(55, 65, 81, 0.95);
        box-shadow: 0 24px 56px rgba(0, 0, 0, 0.3);
      }

      .launch-shell__eyebrow,
      .launch-shell__subtitle,
      .launch-shell__project-desc,
      .launch-shell__project-meta,
      .launch-shell__footer {
        color: #d6d3d1;
      }

      .launch-shell__status {
        background: rgba(129, 140, 248, 0.16);
        color: #c7d2fe;
      }

      .launch-shell__project {
        background: rgba(31, 41, 55, 0.9);
        border-color: rgba(75, 85, 99, 0.88);
      }

      .launch-shell__project--active {
        background: rgba(49, 46, 129, 0.32);
        border-color: rgba(129, 140, 248, 0.44);
      }

      .launch-shell__task {
        color: #f5f5f4;
      }

      .launch-shell__task-id {
        color: #a8a29e;
      }

      .launch-shell__placeholder {
        background: linear-gradient(90deg, rgba(55, 65, 81, 0.85), rgba(75, 85, 99, 1), rgba(55, 65, 81, 0.85));
        background-size: 240% 100%;
      }
    }

    @keyframes launch-shell-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.82); }
    }

    @keyframes launch-shell-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `],
  template: `
    <section class="launch-shell" data-testid="launch-shell" aria-live="polite">
      <div class="launch-shell__panel">
        <div class="launch-shell__eyebrow">
          <span class="launch-shell__dot"></span>
          <span>NanoFlow</span>
        </div>

        <div>
          <h1 class="launch-shell__title">正在恢复你的工作区</h1>
          <p class="launch-shell__subtitle">
            启动壳已先行显示，真实工作区会在后台完成接管。
          </p>
        </div>

        <div class="launch-shell__status">
          <span class="launch-shell__pulse"></span>
          <span>{{ stageLabel() }}</span>
        </div>

        @if (projects().length > 0) {
          <div class="launch-shell__grid">
            @for (project of projects(); track project.id) {
              <article
                class="launch-shell__project"
                [class.launch-shell__project--active]="project.id === activeProjectId()">
                <div class="launch-shell__project-head">
                  <h2 class="launch-shell__project-name">{{ project.name }}</h2>
                  <span class="launch-shell__project-meta">
                    {{ project.openTaskCount }}/{{ project.taskCount }} 待处理
                  </span>
                </div>
                <p class="launch-shell__project-desc">
                  {{ project.description || '正在恢复最近的项目状态…' }}
                </p>
                @if (project.recentTasks.length > 0) {
                  <div class="launch-shell__task-list">
                    @for (task of project.recentTasks; track task.id) {
                      <div class="launch-shell__task">
                        <span
                          class="launch-shell__task-status"
                          [class.launch-shell__task-status--completed]="task.status === 'completed'"></span>
                        <span class="launch-shell__task-id">{{ task.displayId }}</span>
                        <span>{{ task.title }}</span>
                      </div>
                    }
                  </div>
                }
              </article>
            }
          </div>
        } @else {
          <div class="launch-shell__empty">
            <div class="launch-shell__placeholder launch-shell__placeholder--short"></div>
            <div class="launch-shell__placeholder"></div>
            <div class="launch-shell__placeholder launch-shell__placeholder--medium"></div>
            <div class="launch-shell__placeholder"></div>
          </div>
        }

        <div class="launch-shell__footer">
          <span>视图：{{ lastActiveViewLabel() }}</span>
          <span>最近快照：{{ savedAtLabel() }}</span>
        </div>
      </div>
    </section>
  `,
})
export class LaunchShellComponent {
  readonly snapshot = input<LaunchSnapshot | null>(null);
  readonly stage = input<BootStage>('booting');

  readonly projects = computed(() => this.snapshot()?.projects ?? []);
  readonly activeProjectId = computed(() => this.snapshot()?.activeProjectId ?? null);

  readonly stageLabel = computed(() => {
    const s = this.stage();
    if (s === 'handoff') return '工作区准备接管';
    if (s === 'ready') return '工作区已就绪';
    return '启动壳已就绪';
  });

  readonly lastActiveViewLabel = computed(() => {
    const view = this.snapshot()?.lastActiveView;
    if (view === 'flow') return '流程图';
    if (view === 'text') return '文本';
    return '待恢复';
  });

  readonly savedAtLabel = computed(() => {
    const savedAt = this.snapshot()?.savedAt;
    if (!savedAt) return '首次启动';

    const date = new Date(savedAt);
    if (Number.isNaN(date.getTime())) {
      return '快照已损坏';
    }

    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  });
}
