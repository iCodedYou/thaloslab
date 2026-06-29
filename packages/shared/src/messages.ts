// Orchestrator conversation message stream (SPEC §8). Rendered differently per type in the UI.
import type { ArtifactRef } from './core.js';

export type OrchestratorMessage =
  | { type: 'text'; from: 'user' | 'orchestrator'; content: string }
  | { type: 'plan-of-attack'; workflow: string; roster: string[]; rationale: string }
  | {
      type: 'approval-gate';
      gateId: string;
      title: string;
      artifactRef: ArtifactRef;
      options: string[];
    }
  | { type: 'decision-request'; question: string; options: string[] }
  | { type: 'stage-update'; stageId: string; status: string; artifactRefs: ArtifactRef[] }
  | {
      type: 'escalation';
      reason: string;
      lastError?: string;
      diffRef?: ArtifactRef;
      options: string[];
    }
  | { type: 'done'; ticketId: string; summary: string; artifactRefs: ArtifactRef[] };

export type OrchestratorMessageType = OrchestratorMessage['type'];
