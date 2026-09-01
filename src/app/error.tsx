"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="centered-page">
      <span className="eyebrow">Connection interrupted</span>
      <h1>The room needs a reset.</h1>
      <p>Your provider session failed. Local interview work is preserved until this page reloads.</p>
      <button className="primary-button" type="button" onClick={reset}>Try again</button>
    </main>
  );
}
