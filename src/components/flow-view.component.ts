
import { Component, inject, signal, computed, ElementRef, ViewChild, AfterViewInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService, Task } from '../services/store.service';

declare var go: any;

@Component({
  selector: 'app-flow-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="relative w-full h-full overflow-hidden bg-slate-50 flow-bg">
       <!-- GoJS Diagram Div -->
       <div #diagramDiv class="absolute inset-0 w-full h-full z-0"></div>

       <!-- Unassigned / Unfinished Panels -->
       <div class="absolute bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 p-2 flex gap-4 h-36 z-20 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
           <div class="w-1/2 border-r border-slate-200 pr-2 overflow-y-auto">
               <h5 class="text-xs font-bold text-slate-500 mb-2 uppercase flex justify-between">
                   未分配任务
                   <button (click)="createUnassigned()" class="text-blue-500 hover:bg-blue-50 rounded px-1">+</button>
               </h5>
               <div class="flex flex-wrap gap-2" id="unassignedPalette">
                   <!-- We can use GoJS Palette here or simple HTML dragging -->
                   @for (task of store.unassignedTasks(); track task.id) {
                       <div 
                           draggable="true" 
                           (dragstart)="onDragStart($event, task)"
                           class="px-3 py-2 bg-white border border-slate-300 rounded text-xs font-medium hover:border-blue-400 cursor-grab shadow-sm transition-transform active:scale-95">
                           {{task.title}}
                       </div>
                   }
               </div>
           </div>
           <div class="w-1/2 pl-2 overflow-y-auto">
               <h5 class="text-xs font-bold text-red-400 mb-2 uppercase">未完成项</h5>
               <ul class="space-y-1">
                   @for (item of store.unfinishedItems(); track item.taskId + item.text) {
                       <li class="text-xs text-slate-600 flex items-center gap-2 bg-red-50/50 p-1 rounded hover:bg-red-50 cursor-pointer" (click)="centerOnNode(item.taskId)">
                           <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                           <span class="font-mono text-slate-400 text-[10px]">{{item.taskDisplayId}}</span>
                           <span class="truncate">{{item.text}}</span>
                       </li>
                   }
               </ul>
           </div>
       </div>
    </div>
  `
})
export class FlowViewComponent implements AfterViewInit {
  @ViewChild('diagramDiv') diagramDiv!: ElementRef;
  store = inject(StoreService);
  
  private diagram: any;

  constructor() {
      effect(() => {
          const tasks = this.store.tasks();
          if (this.diagram) {
              this.updateDiagram(tasks);
          }
      });
  }

  ngAfterViewInit() {
      this.initDiagram();
  }

  initDiagram() {
      if (typeof go === 'undefined') {
          console.warn('GoJS not loaded');
          return;
      }
      const $ = go.GraphObject.make;

      this.diagram = $(go.Diagram, this.diagramDiv.nativeElement, {
          "undoManager.isEnabled": true,
          "animationManager.isEnabled": true,
          "allowDrop": true, // accept drops from HTML
          layout: $(go.LayeredDigraphLayout, { 
              direction: 0, 
              layerSpacing: 100, 
              columnSpacing: 40,
              setsPortSpots: false 
          })
      });

      // Node Template
      this.diagram.nodeTemplate =
          $(go.Node, "Auto",
            { 
                locationSpot: go.Spot.Center,
                selectionAdorned: true,
                doubleClick: (e: any, node: any) => {
                    // Open details logic if needed
                }
            },
            new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
            $(go.Shape, "RoundedRectangle", 
              { fill: "white", stroke: "#cbd5e1", strokeWidth: 1, portId: "", fromLinkable: true, toLinkable: true, cursor: "pointer" },
              new go.Binding("fill", "color"),
              new go.Binding("stroke", "isSelected", (s: boolean) => s ? "#3b82f6" : "#cbd5e1").ofObject()
            ),
            $(go.Panel, "Vertical", { margin: 8 },
                $(go.TextBlock, { font: "bold 10px monospace", stroke: "#94a3b8", alignment: go.Spot.Left },
                    new go.Binding("text", "displayId")),
                $(go.TextBlock, { margin: new go.Margin(2, 0, 0, 0), font: "bold 12px sans-serif", stroke: "#1e293b", maxSize: new go.Size(140, NaN) },
                    new go.Binding("text", "title"))
            )
          );

      // Link Template
      this.diagram.linkTemplate =
          $(go.Link, 
            { routing: go.Link.Orthogonal, corner: 5 },
            $(go.Shape, { strokeWidth: 2, stroke: "#cbd5e1" }),
            $(go.Shape, { toArrow: "Standard", stroke: null, fill: "#cbd5e1" })
          );

      // Handle External Drops
      this.diagram.div.addEventListener("dragover", (e: DragEvent) => {
          e.preventDefault();
          // Highlight logic could go here
      });

      this.diagram.div.addEventListener("drop", (e: DragEvent) => {
          e.preventDefault();
          const data = e.dataTransfer?.getData("text");
          if (data) {
             const task = JSON.parse(data);
             // Logic to add task to stage?
             // Prompt says: "Dragging to a node (stage) renders them in flow".
             // Here we drop onto canvas.
             // Let's assign it a stage based on drop, or just make it active (Stage 1 default if dropped on blank?)
             // We'll verify if dropped on existing node?
             
             const pt = this.diagram.lastInput.viewPoint;
             const loc = this.diagram.transformViewToDoc(pt);
             
             // Update task in store
             // We assume dropping on canvas assigns it to stage 1 or keeps it unassigned but gives it coords?
             // Prompt: "Once moved to a node... renders in flow".
             // Let's assume drop on canvas = Stage 1 for now to show it.
             // Better: If dropped on a Node, link it?
             
             this.store.moveTaskToStage(task.id, 1);
             this.store.updateTaskPosition(task.id, loc.x, loc.y);
          }
      });

      // Model Change Listener
      this.diagram.addDiagramListener("SelectionMoved", (e: any) => {
           e.subject.each((part: any) => {
               if (part instanceof go.Node) {
                   const { x, y } = part.location;
                   this.store.updateTaskPosition(part.data.key, x, y);
               }
           });
      });
      
      // Initial Load
      this.updateDiagram(this.store.tasks());
  }

  updateDiagram(tasks: Task[]) {
      if (!this.diagram) return;
      
      const assigned = tasks.filter(t => t.stage !== null);
      const modelNodes = assigned.map(t => ({
          key: t.id,
          title: t.title,
          displayId: t.displayId,
          loc: `${t.x} ${t.y}`,
          color: t.status === 'completed' ? '#f0fdf4' : 'white' // Completed tasks visual style
      }));

      const modelLinks = [];
      const activeP = this.store.activeProject();
      if (activeP) {
          // Use explicit connections or parentId
          tasks.forEach(t => {
              if (t.parentId && tasks.find(p => p.id === t.parentId)?.stage !== null) {
                  modelLinks.push({ from: t.parentId, to: t.id });
              }
          });
          // Also add explicit connections
          activeP.connections.forEach(c => modelLinks.push({ from: c.source, to: c.target }));
      }

      const model = new go.GraphLinksModel(modelNodes, modelLinks);
      // Check for diffs to avoid reload flicker
      // For demo simplicity, we reload model if node count changes significantly or first load
      this.diagram.model = model;
  }

  onDragStart(e: DragEvent, task: Task) {
      if (e.dataTransfer) {
          e.dataTransfer.setData("text", JSON.stringify(task));
          e.dataTransfer.effectAllowed = "move";
      }
  }
  
  createUnassigned() {
      this.store.addTask("新未分配任务", "...", null, null, false);
  }

  centerOnNode(key: string) {
      const node = this.diagram.findNodeForKey(key);
      if (node) {
          this.diagram.select(node);
          this.diagram.commandHandler.scrollToPart(node);
      }
  }
}
