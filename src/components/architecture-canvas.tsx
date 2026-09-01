"use client";

import { Database, Globe2, Plus, ServerCog, Waypoints } from "lucide-react";
import type { DesignNode } from "@/lib/interview";

const nodeTypes = [
  { kind: "client" as const, label: "Client", Icon: Globe2 },
  { kind: "service" as const, label: "Service", Icon: ServerCog },
  { kind: "data" as const, label: "Data store", Icon: Database },
  { kind: "queue" as const, label: "Queue", Icon: Waypoints },
];

interface ArchitectureCanvasProps {
  nodes: DesignNode[];
  onChange: (nodes: DesignNode[]) => void;
}

export function ArchitectureCanvas({ nodes, onChange }: ArchitectureCanvasProps) {
  const addNode = (kind: DesignNode["kind"], label: string) => {
    onChange([...nodes, { id: crypto.randomUUID(), kind, label: `${label} ${nodes.length + 1}` }]);
  };

  return (
    <div className="canvas-shell" data-testid="architecture-canvas">
      <div className="canvas-toolbar" aria-label="Architecture node toolbar">
        {nodeTypes.map(({ kind, label, Icon }) => (
          <button key={kind} type="button" onClick={() => addNode(kind, label)}>
            <Icon size={15} aria-hidden="true" />
            {label}
            <Plus size={13} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="canvas-grid">
        {nodes.length === 0 ? (
          <div className="canvas-empty">
            <Waypoints size={28} aria-hidden="true" />
            <p>Map your thinking</p>
            <span>Add components above. Every node becomes report evidence.</span>
          </div>
        ) : (
          nodes.map((node, index) => (
            <div className={`diagram-node node-${node.kind}`} key={node.id}>
              <span>{node.kind}</span>
              <input
                aria-label={`${node.kind} node ${index + 1}`}
                value={node.label}
                onChange={(event) =>
                  onChange(nodes.map((item) => (item.id === node.id ? { ...item, label: event.target.value } : item)))
                }
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
