import { ChangeDetectionStrategy, Component, Input, OnChanges, AfterViewInit, ViewChild, inject } from '@angular/core';
import { DockConsoleStackComponent } from '../features/parking/components/dock-console-stack.component';
import { DockRadarZoneComponent } from '../features/parking/components/dock-radar-zone.component';
import { DockPlannerQuickEditPanelComponent } from '../features/parking/components/dock-planner-quick-edit-panel.component';
import { DockPlannerQuickEditService } from '../features/parking/services/dock-planner-quick-edit.service';
import { DEMO_DESKTOP_DOCK_PROVIDERS, DemoDesktopDockMemory } from './demo-desktop-dock-preview.providers';
@Component({selector:'app-demo-desktop-dock-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
  imports:[DockConsoleStackComponent,DockRadarZoneComponent,DockPlannerQuickEditPanelComponent],
  providers:[...DEMO_DESKTOP_DOCK_PROVIDERS,DockPlannerQuickEditService],
  template:`<section class="desktop-preview" aria-label="桌面停泊坞演示">
    <div class="console"><app-dock-console-stack /></div>
    <div class="radar"><app-dock-radar-zone [isMobile]="false" [canMutate]="true" [interactive]="true" /></div>
    @if ((state === 'planner' || state === 'planner-complete') && planner.activeEntry()) {<div class="planner"><app-dock-planner-quick-edit-panel (closeRequested)="planner.closePlannerQuickEdit()" /></div>}
  </section>`,
  styles:[`:host{display:block}.desktop-preview{position:relative;min-height:1000px;background:#0f172a;border-radius:20px;overflow:hidden;padding:20px;color:#e2e8f0}.console{position:relative;min-height:480px;transform:translateZ(0)}.radar{position:relative;min-height:440px;transform:translateZ(0)}.planner{position:relative;max-width:600px;margin:auto}`],
})
export class DemoDesktopDockPreviewComponent implements OnChanges, AfterViewInit {
  @Input() state='console';
  @ViewChild(DockConsoleStackComponent) private console?: DockConsoleStackComponent;
  @ViewChild(DockRadarZoneComponent) private radar?: DockRadarZoneComponent;
  readonly memory=inject(DemoDesktopDockMemory);
  readonly planner=inject(DockPlannerQuickEditService);
  constructor(){this.memory.reset('console');}
  ngAfterViewInit():void {
    queueMicrotask(() => {
      if (this.state === "wait-presets" && this.console) this.console.toggleWaitPresets(this.memory.entries()[0].taskId);
      if (this.state === "radar-preview" && this.radar) this.radar.openTaskPreview(this.memory.backupEntries()[0].taskId);
      if (this.state === "radar-panorama" && this.radar) this.radar.setViewMode("panorama");
      if (this.state === "radar-overflow" && this.radar) this.radar.showBackupOverflowPanel.set(true);
    });
  }
  ngOnChanges():void {this.memory.reset(this.state);this.planner.plannerQuickEditTaskId.set((this.state === 'planner' || this.state === 'planner-complete') ? this.memory.entries()[0].taskId:null);}
}
