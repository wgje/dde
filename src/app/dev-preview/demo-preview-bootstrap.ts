import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { AppComponent } from '../../app.component';
import { developmentPreviewRoutes } from '../../app.routes';

/** Dev-only entry: no workspace initializer, telemetry, auth or durable stores. */
export async function bootstrapDemoPreview(): Promise<void> {
  await bootstrapApplication(AppComponent, {
    providers: [provideRouter(developmentPreviewRoutes(false), withHashLocation(), withComponentInputBinding())],
  });
}