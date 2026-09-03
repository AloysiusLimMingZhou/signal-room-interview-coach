import { InterviewApp } from "@/components/interview-app";
import { connection } from "next/server";

export default async function HomePage() {
  // A per-request CSP nonce is attached by src/proxy.ts.
  await connection();
  return <InterviewApp />;
}
