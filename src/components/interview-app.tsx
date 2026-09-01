"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMachine } from "@xstate/react";
import {
  Activity,
  AudioLines,
  Bot,
  Braces,
  CircleDollarSign,
  Clock3,
  Command,
  LogOut,
  Mic,
  MicOff,
  Network,
  Pause,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ArchitectureCanvas } from "./architecture-canvas";
import { CodeWorkbench } from "./code-workbench";
import { Scorecard } from "./scorecard";
import { TranscriptPanel } from "./transcript-panel";
import { estimateGeminiLiveCost, formatUsd } from "@/lib/cost";
import {
  buildEvidenceScorecard,
  followUpPrompt,
  initialPrompt,
  makeTranscript,
  scenarioByTrack,
  type DesignNode,
  type EvidenceScore,
  type TranscriptItem,
} from "@/lib/interview";
import { interviewMachine } from "@/lib/interview-machine";
import { MockRealtimeAdapter } from "@/lib/realtime/mock-adapter";
import type {
  InterviewDifficulty,
  InterviewTrack,
  RealtimeAdapter,
  RealtimeSession,
} from "@/lib/realtime/types";

const starterCode = `type Region = "us" | "eu" | "apac";

interface EditEvent {
  documentId: string;
  sequence: number;
  region: Region;
  payload: string;
}

export function routeEdit(event: EditEvent) {
  // Explain the consistency and failover trade-offs here.
  return { accepted: true, shard: event.documentId.slice(0, 2) };
}`;

const trackLabels: Record<InterviewTrack, string> = {
  "system-design": "System design",
  "ml-design": "ML system design",
  algorithms: "Algorithms",
};

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function InterviewApp() {
  const [machine, send] = useMachine(interviewMachine);
  const [track, setTrack] = useState<InterviewTrack>("system-design");
  const [difficulty, setDifficulty] = useState<InterviewDifficulty>("senior");
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [answer, setAnswer] = useState("");
  const [code, setCode] = useState(starterCode);
  const [nodes, setNodes] = useState<DesignNode[]>([]);
  const [activeTab, setActiveTab] = useState<"code" | "canvas">("code");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPaused, setPaused] = useState(false);
  const [scores, setScores] = useState<EvidenceScore[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const adapterRef = useRef<RealtimeAdapter | null>(null);

  const isActive = machine.matches("active");
  const isCompleted = machine.matches("completed");
  const estimate = useMemo(
    () => estimateGeminiLiveCost({
      candidateAudioMinutes: elapsedSeconds / 60 * 0.67,
      interviewerAudioMinutes: elapsedSeconds / 60 * 0.22,
      contextMultiplier: 2.1,
    }),
    [elapsedSeconds],
  );

  useEffect(() => {
    if (!isActive || isPaused) return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [isActive, isPaused]);

  useEffect(() => () => { void adapterRef.current?.close(); }, []);

  async function startInterview() {
    setConnectionError(null);
    send({ type: "START", track, difficulty });
    try {
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track, difficulty, providerPreference: "gemini" }),
      });
      if (!response.ok) throw new Error("Could not create the interview room.");
      const provisioned = (await response.json()) as RealtimeSession;
      const adapter: RealtimeAdapter = provisioned.mode === "gemini"
        ? new (await import("@/lib/realtime/gemini-adapter")).GeminiRealtimeAdapter()
        : new MockRealtimeAdapter();
      adapterRef.current = adapter;
      if (provisioned.mode === "gemini") {
        let pendingCandidate = "";
        let pendingInterviewer = "";
        adapter.subscribe((event) => {
          if (event.type === "input-transcript") pendingCandidate += event.text;
          if (event.type === "output-transcript") pendingInterviewer += event.text;
          if (event.type === "error") setConnectionError(event.message);
          if (event.type === "turn-complete") {
            setTranscript((items) => {
              const next = [...items];
              if (pendingCandidate.trim()) next.push(makeTranscript("candidate", pendingCandidate.trim(), next.length + 1));
              if (pendingInterviewer.trim()) next.push(makeTranscript("interviewer", pendingInterviewer.trim(), next.length + 1));
              pendingCandidate = "";
              pendingInterviewer = "";
              return next;
            });
          }
        });
      }
      await adapter.connect(provisioned);
      setSession(provisioned);
      setTranscript([makeTranscript("interviewer", initialPrompt(track, difficulty), 1)]);
      send({ type: "CONNECTED" });
      if (provisioned.mode === "gemini") {
        adapter.sendText("Begin the interview now. Ask the opening question and wait for my response.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the interview.";
      setConnectionError(message);
      send({ type: "FAIL", message });
    }
  }

  function submitAnswer() {
    const text = answer.trim();
    if (!text || !isActive) return;
    const candidateItem = makeTranscript("candidate", text, transcript.length + 1);
    const nextQuestion = makeTranscript(
      "interviewer",
      followUpPrompt(track, machine.context.answerCount + 1),
      transcript.length + 2,
    );
    setTranscript((items) => [...items, candidateItem, nextQuestion]);
    adapterRef.current?.sendText(text);
    setAnswer("");
    send({ type: "ANSWER_SUBMITTED" });
    window.setTimeout(() => send({ type: "INTERVIEWER_FINISHED" }), 250);
  }

  function injectScenario() {
    const scenario = scenarioByTrack[track];
    setTranscript((items) => [...items, makeTranscript("system", scenario, items.length + 1)]);
  }

  function finishInterview() {
    send({ type: "FINISH" });
    const report = buildEvidenceScorecard(transcript, code, nodes);
    setScores(report);
    void adapterRef.current?.close();
    window.setTimeout(() => send({ type: "GRADED" }), 120);
  }

  async function toggleMicrophone() {
    if (session?.mode !== "gemini" || !adapterRef.current) return;
    setConnectionError(null);
    try {
      if (microphoneActive) {
        await adapterRef.current.stopMicrophone();
        setMicrophoneActive(false);
      } else {
        await adapterRef.current.startMicrophone();
        setMicrophoneActive(true);
      }
    } catch {
      setConnectionError("Microphone access was denied or the selected device is unavailable.");
      setMicrophoneActive(false);
    }
  }

  if (machine.matches("setup") || machine.matches("connecting") || machine.matches("failed")) {
    const connecting = machine.matches("connecting");
    return (
      <main className="landing-shell">
        <nav className="top-nav">
          <div className="brand"><span className="brand-mark"><AudioLines size={19} /></span>Signal Room</div>
          <div className="nav-meta"><span className="status-dot" />Gemini-first prototype</div>
        </nav>
        <section className="landing-grid">
          <div className="hero-copy">
            <span className="eyebrow"><Sparkles size={14} /> Practice that leaves a signal</span>
            <h1>Think out loud.<br /><em>Get evidence back.</em></h1>
            <p>Rehearse the interviews where the answer is not in a textbook. Your voice, code, and architecture become a precise coaching report.</p>
            <div className="proof-row">
              <div><strong>&lt;1.5s</strong><span>target response</span></div>
              <div><strong>3 modes</strong><span>one workbench</span></div>
              <div><strong>$1.50–1.80</strong><span>planned session</span></div>
            </div>
          </div>
          <div className="setup-card">
            <div className="setup-heading">
              <span>Configure your room</span>
              <div className="mock-pill" data-testid="mode-badge"><ShieldCheck size={13} /> Mock-ready</div>
            </div>
            <label>Interview track</label>
            <div className="choice-grid">
              {(Object.keys(trackLabels) as InterviewTrack[]).map((value) => (
                <button
                  className={track === value ? "selected" : ""}
                  key={value}
                  type="button"
                  onClick={() => setTrack(value)}
                >
                  {value === "system-design" ? <Network /> : value === "ml-design" ? <Activity /> : <Braces />}
                  <span>{trackLabels[value]}</span>
                </button>
              ))}
            </div>
            <label htmlFor="difficulty">Calibration</label>
            <select id="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value as InterviewDifficulty)}>
              <option value="mid">Mid-level · guided</option>
              <option value="senior">Senior · probing</option>
              <option value="staff">Staff · ambiguous</option>
            </select>
            <div className="privacy-note"><ShieldCheck size={17} /><p><strong>Private by default.</strong> P0 keeps interview content in this browser. Audio is never recorded.</p></div>
            {connectionError && <p className="error-message" role="alert">{connectionError}</p>}
            <button className="primary-button start-button" type="button" onClick={startInterview} disabled={connecting}>
              {connecting ? "Opening room…" : "Enter interview room"}<ArrowGlyph />
            </button>
            <small className="setup-footnote">Runs without an API key. Add Gemini later for live voice.</small>
          </div>
        </section>
        <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      </main>
    );
  }

  if (isCompleted) {
    return (
      <main className="report-page">
        <nav className="top-nav dark-nav">
          <div className="brand"><span className="brand-mark"><AudioLines size={19} /></span>Signal Room</div>
          <div className="nav-meta">{trackLabels[track]} · {formatTime(elapsedSeconds)}</div>
        </nav>
        <Scorecard scores={scores} />
        <div className="report-actions">
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>Start another interview</button>
        </div>
      </main>
    );
  }

  return (
    <main className="room-shell">
      <header className="room-header">
        <div className="brand"><span className="brand-mark"><AudioLines size={18} /></span>Signal Room</div>
        <div className="session-title">
          <strong>{trackLabels[track]}</strong>
          <span>{difficulty} calibration</span>
        </div>
        <div className="room-controls">
          <span className={`live-badge ${session?.mode === "gemini" ? "provider-live" : ""}`}><span />{session?.mode === "gemini" ? "Gemini Live" : "Mock session"}</span>
          <button type="button" className="icon-button" aria-label={isPaused ? "Resume timer" : "Pause timer"} onClick={() => setPaused((value) => !value)}>{isPaused ? <Play /> : <Pause />}</button>
          <time><Clock3 size={15} />{formatTime(elapsedSeconds)}</time>
          <button type="button" className="end-button" onClick={finishInterview}><LogOut size={15} /> End & review</button>
        </div>
      </header>
      <div className="room-layout">
        <section className="conversation-pane">
          <div className="pane-heading">
            <div><span className="eyebrow">Live transcript</span><h2>Interview conversation</h2></div>
            <button type="button" className="scenario-button" onClick={injectScenario}><Sparkles size={14} /> Inject scenario</button>
          </div>
          <TranscriptPanel items={transcript} />
          <div className="answer-composer">
            {connectionError && <p className="room-error" role="alert">{connectionError}</p>}
            <textarea
              aria-label="Your interview answer"
              placeholder="Structure your answer here, or connect Gemini Live for voice…"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAnswer();
              }}
            />
            <div className="composer-footer">
              <span><Command size={13} /> Enter to send</span>
              <button
                className={`mic-button ${microphoneActive ? "recording" : ""}`}
                type="button"
                disabled={session?.mode !== "gemini"}
                title={session?.mode === "gemini" ? (microphoneActive ? "Stop microphone" : "Start microphone") : "Microphone requires Gemini Live"}
                aria-label={microphoneActive ? "Stop microphone" : "Start microphone"}
                onClick={() => void toggleMicrophone()}
              >{microphoneActive ? <MicOff size={17} /> : <Mic size={17} />}</button>
              <button className="send-button" type="button" onClick={submitAnswer} disabled={!answer.trim()}><Send size={16} /> Send answer</button>
            </div>
          </div>
        </section>
        <section className="workbench-pane">
          <div className="workbench-tabs" role="tablist" aria-label="Interview artifacts">
            <button type="button" role="tab" aria-selected={activeTab === "code"} onClick={() => setActiveTab("code")}><Braces size={15} /> Code</button>
            <button type="button" role="tab" aria-selected={activeTab === "canvas"} onClick={() => setActiveTab("canvas")}><Network size={15} /> Architecture</button>
            <span className="autosave">Local session</span>
          </div>
          <div className="workbench-body">
            {activeTab === "code" ? <CodeWorkbench value={code} onChange={setCode} /> : <ArchitectureCanvas nodes={nodes} onChange={setNodes} />}
          </div>
          <footer className="signal-footer">
            <div><CircleDollarSign size={16} /><span>Estimated so far</span><strong>{formatUsd(estimate.estimatedTotal)}</strong></div>
            <div><Bot size={16} /><span>Artifacts captured</span><strong>{nodes.length + (code !== starterCode ? 1 : 0)}</strong></div>
          </footer>
        </section>
      </div>
    </main>
  );
}

function ArrowGlyph() {
  return <span aria-hidden="true">↗</span>;
}
