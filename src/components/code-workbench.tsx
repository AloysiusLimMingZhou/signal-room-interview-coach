"use client";

import dynamic from "next/dynamic";

const Editor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="editor-loading">Preparing code editor…</div>,
});

interface CodeWorkbenchProps {
  value: string;
  onChange: (value: string) => void;
}

export function CodeWorkbench({ value, onChange }: CodeWorkbenchProps) {
  return (
    <div className="code-editor" data-testid="code-workbench">
      <Editor
        height="100%"
        defaultLanguage="typescript"
        theme="vs-dark"
        value={value}
        onChange={(next) => onChange(next ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 22,
          padding: { top: 16 },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
        }}
      />
    </div>
  );
}
