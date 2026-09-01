export type RealtimeMode = "mock" | "gemini";

export type InterviewTrack = "system-design" | "ml-design" | "algorithms";
export type InterviewDifficulty = "mid" | "senior" | "staff";

export interface RealtimeSession {
  sessionId: string;
  mode: RealtimeMode;
  model: string;
  expiresAt: string;
  token?: string;
  wsUrl?: string;
}

export type RealtimeEvent =
  | { type: "connected" }
  | { type: "input-transcript"; text: string; final: boolean }
  | { type: "output-transcript"; text: string; final: boolean }
  | { type: "turn-complete" }
  | { type: "interrupted" }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string };

export interface RealtimeAdapter {
  connect(session: RealtimeSession): Promise<void>;
  sendText(text: string): void;
  startMicrophone(): Promise<void>;
  stopMicrophone(): Promise<void>;
  interrupt(): void;
  close(): Promise<void>;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

export interface SessionRequest {
  track: InterviewTrack;
  difficulty: InterviewDifficulty;
  providerPreference: "gemini";
}
