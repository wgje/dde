export interface SpeechToTextDurationTickerControllerOptions {
  getRecordingStartTime: () => number;
  setDuration: (durationSeconds: number) => void;
}

export class SpeechToTextDurationTickerController {
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SpeechToTextDurationTickerControllerOptions) {}

  start(): void {
    this.clearTicker();
    this.options.setDuration(0);
    this.ticker = setInterval(() => {
      const start = this.options.getRecordingStartTime();
      if (!start) return;
      const elapsed = Math.round((Date.now() - start) / 1000);
      this.options.setDuration(elapsed);
    }, 500);
  }

  stop(): void {
    this.clearTicker();
    this.options.setDuration(0);
  }

  private clearTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
