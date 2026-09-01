import { ArrowRight, CheckCircle2 } from "lucide-react";
import type { EvidenceScore } from "@/lib/interview";

export function Scorecard({ scores }: { scores: EvidenceScore[] }) {
  return (
    <section className="report" data-testid="scorecard">
      <div className="report-hero">
        <span className="eyebrow">Evidence report</span>
        <h2>Your interview snapshot</h2>
        <p>Each score points back to something you said or made. No hidden hire/no-hire judgment.</p>
      </div>
      <div className="score-grid">
        {scores.map((score) => (
          <article className="score-card" key={score.competency}>
            <div className="score-heading">
              <div>
                <span>{score.competency}</span>
                <small>{Math.round(score.confidence * 100)}% evidence confidence</small>
              </div>
              <strong>{score.score}<em>/5</em></strong>
            </div>
            <div className="score-bar"><span style={{ width: `${score.score * 20}%` }} /></div>
            <p>{score.feedback}</p>
            <div className="evidence-chips">
              {score.evidenceReferences.length ? score.evidenceReferences.map((reference) => (
                <span key={reference}><CheckCircle2 size={12} />{reference.replace("evidence:", "")}</span>
              )) : <span>No evidence captured</span>}
            </div>
            <button type="button" className="retry-link">Retry this skill <ArrowRight size={14} /></button>
          </article>
        ))}
      </div>
    </section>
  );
}
