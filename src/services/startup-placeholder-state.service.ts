import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class StartupPlaceholderStateService {
  private readonly hintOnlyOwnerUserIdState = signal<string | null>(null);

  readonly hintOnlyOwnerUserId = this.hintOnlyOwnerUserIdState.asReadonly();

  isHintOnlyActive(): boolean {
    return this.hintOnlyOwnerUserIdState() !== null;
  }

  activate(ownerUserId: string): void {
    this.hintOnlyOwnerUserIdState.set(ownerUserId);
  }

  clear(): void {
    this.hintOnlyOwnerUserIdState.set(null);
  }
}