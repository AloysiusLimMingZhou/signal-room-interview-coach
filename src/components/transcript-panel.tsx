import { Bot, UserRound, Zap } from "lucide-react";
import type { TranscriptItem } from "@/lib/interview";

export function TranscriptPanel({ items }: { items: TranscriptItem[] }) {
  return (
    <div className="transcript-list" aria-live="polite" data-testid="transcript">
      {items.map((item) => {
        const Icon = item.speaker === "interviewer" ? Bot : item.speaker === "candidate" ? UserRound : Zap;
        return (
          <article className={`transcript-item ${item.speaker}`} key={item.id}>
            <div className="speaker-icon"><Icon size={15} aria-hidden="true" /></div>
            <div>
              <div className="speaker-line">
                <strong>{item.speaker === "interviewer" ? "Gemini interviewer" : item.speaker}</strong>
                <span>{item.evidenceId.replace("evidence:", "")}</span>
              </div>
              <p>{item.text}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
