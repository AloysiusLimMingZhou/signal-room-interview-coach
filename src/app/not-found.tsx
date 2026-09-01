import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="centered-page">
      <span className="eyebrow">404 · Wrong room</span>
      <h1>This interview does not exist.</h1>
      <Link className="primary-button" href="/">Return to Signal Room</Link>
    </main>
  );
}
