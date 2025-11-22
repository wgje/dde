
import { Component, inject, signal, WritableSignal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from './services/store.service';
import { TextViewComponent } from './components/text-view.component';
import { FlowViewComponent } from './components/flow-view.component';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, FormsModule],
  templateUrl: './app.component.html',
})
export class AppComponent {
  store = inject(StoreService);
  
  isSidebarOpen = signal(true);
  showSettings = signal(false);
  showNewProjectModal = signal(false);
  showGenAIModal = signal(false);
  showImageEditModal = signal(false);

  genAiImage: WritableSignal<string | null> = signal(null);
  editingImage: WritableSignal<string | null> = signal(null);
  isGenerating = signal(false);

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  selectProject(id: string) {
    this.store.activeProjectId.set(id);
  }

  createNewProject() {
    this.showNewProjectModal.set(true);
  }
  
  confirmCreateProject(name: string, desc: string) {
      if (!name) return;
      this.store.addProject({
          id: crypto.randomUUID(),
          name,
          description: desc,
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: []
      });
      this.showNewProjectModal.set(false);
  }

  openSettings() {
    this.showSettings.set(true);
  }

  closeSettings() {
    this.showSettings.set(false);
  }

  updateLayoutDirection(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl';
    this.store.layoutDirection.set(val);
  }
  
  updateFloatPref(e: Event) {
      const val = (e.target as HTMLSelectElement).value as 'auto' | 'fixed';
      this.store.floatingWindowPref.set(val);
  }

  updateFilter(e: Event) {
      this.store.filterMode.set((e.target as HTMLSelectElement).value);
  }
  
  generateImage() {
      this.closeSettings();
      this.showGenAIModal.set(true);
  }
  
  openImageEditor() {
      this.closeSettings();
      this.showImageEditModal.set(true);
  }
  
  async runImageGen(prompt: string) {
      if (!prompt) return;
      this.isGenerating.set(true);
      const img = await this.store.generateImage(prompt);
      this.genAiImage.set(img);
      this.isGenerating.set(false);
  }

  async runImageEdit(prompt: string) {
      if (!prompt || !this.editingImage()) return;
      this.isGenerating.set(true);
      const result = await this.store.editImageWithPrompt(this.editingImage()!, prompt);
      if (result) {
          this.editingImage.set(result); // Update view with new image
      }
      this.isGenerating.set(false);
  }

  onFileSelected(event: Event) {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (e) => {
              this.editingImage.set(e.target?.result as string);
          };
          reader.readAsDataURL(file);
      }
  }
}
