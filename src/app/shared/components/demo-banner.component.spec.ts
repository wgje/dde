import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { DemoBannerComponent } from './demo-banner.component';
import { AuthService } from '../../../services/auth.service';
import { AUTH_CONFIG } from '../../../config';
import { LOCAL_MODE_CHANGED_EVENT } from '../../../services/guards/auth.guard';

describe('DemoBannerComponent', () => {
  let fixture: ComponentFixture<DemoBannerComponent>;
  let component: DemoBannerComponent;

  beforeEach(() => {
    localStorage.clear();

    TestBed.configureTestingModule({
      imports: [DemoBannerComponent],
      providers: [
        {
          provide: AuthService,
          useValue: {
            currentUserId: signal<string | null>(null),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(DemoBannerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('收到本地模式变更事件后应实时刷新显示状态', () => {
    expect(component.showBanner()).toBe(false);

    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
    window.dispatchEvent(new Event(LOCAL_MODE_CHANGED_EVENT));
    fixture.detectChanges();

    expect(component.showBanner()).toBe(true);
  });
});
