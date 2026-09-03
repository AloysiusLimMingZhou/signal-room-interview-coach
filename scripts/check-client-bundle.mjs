import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const bundleRoot = path.resolve(".next", "static");
const forbiddenPatterns = [
  { label: "public Gemini API-key environment variable", expression: /NEXT_PUBLIC_(?:GEMINI|GOOGLE)_API_KEY/ },
  { label: "Google API-key-shaped literal", expression: /AIza[0-9A-Za-z_-]{30,}/ },
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  }));
  return nested.flat();
}

const violations = [];
for (const file of await filesBelow(bundleRoot)) {
  const contents = await readFile(file, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.expression.test(contents)) {
      violations.push(`${pattern.label} in ${path.relative(bundleRoot, file)}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Client bundle security check failed. Matched values are intentionally not printed.");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Client bundle security check passed.");
}
