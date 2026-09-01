import type { RealtimeAdapter, RealtimeEvent } from "./types";

export class MockRealtimeAdapter implements RealtimeAdapter {
  private listeners = new Set<(event: RealtimeEvent) => void>();

  async connect() {
    await Promise.resolve();
    this.emit({ type: "connected" });
  }

  sendText(text: string) {
    this.emit({ type: "input-transcript", text, final: true });
  }

  async startMicrophone() {
    throw new Error("Microphone is intentionally disabled in mock mode.");
  }

  async stopMicrophone() {
    await Promise.resolve();
  }

  interrupt() {
    this.emit({ type: "interrupted" });
  }

  async close() {
    this.listeners.clear();
    await Promise.resolve();
  }

  subscribe(listener: (event: RealtimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RealtimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
