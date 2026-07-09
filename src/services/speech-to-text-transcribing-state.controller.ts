export class SpeechToTextTranscribingStateController {
  private readonly activeOperations = new Set<symbol>();

  constructor(private readonly setTranscribing: (value: boolean) => void) {}

  begin(): () => void {
    const token = Symbol('speech-to-text-transcribing');
    this.activeOperations.add(token);
    this.setTranscribing(true);

    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.activeOperations.delete(token);
      if (this.activeOperations.size === 0) {
        this.setTranscribing(false);
      }
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.begin();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  reset(): void {
    this.activeOperations.clear();
    this.setTranscribing(false);
  }
}
