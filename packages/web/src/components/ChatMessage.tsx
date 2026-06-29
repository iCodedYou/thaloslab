import type { ReactNode } from 'react';
import type { OrchestratorMessage } from '@thaloslab/shared';

// Renders one typed OrchestratorMessage (SPEC §8) as a chat row. Approval gates are rendered as
// interactive cards by the page (which has the live Gate row); here we show their announcement.
export function ChatMessage({ message }: { message: OrchestratorMessage }) {
  switch (message.type) {
    case 'text':
      return (
        <Row from={message.from}>
          <p className="text-sm text-fg">{message.content}</p>
        </Row>
      );
    case 'plan-of-attack':
      return (
        <Row from="orchestrator">
          <div className="text-sm text-fg">
            <span className="font-medium">Plan of attack — {message.workflow}</span>
            <p className="mt-1 text-dim">{message.rationale}</p>
            <p className="mt-1 font-mono text-xs text-faint">
              roster: {message.roster.join(' · ')}
            </p>
          </div>
        </Row>
      );
    case 'approval-gate':
      return (
        <Row from="orchestrator">
          <p className="text-sm text-warn">⏸ Awaiting approval: {message.title}</p>
        </Row>
      );
    case 'stage-update':
      return (
        <Row from="orchestrator">
          <p className="font-mono text-xs text-dim">
            stage {message.stageId} → {message.status}
          </p>
        </Row>
      );
    case 'escalation':
      return (
        <Row from="orchestrator">
          <p className="text-sm text-danger">⚠ Escalation: {message.reason}</p>
          {message.lastError && (
            <p className="mt-1 font-mono text-xs text-faint">{message.lastError}</p>
          )}
        </Row>
      );
    case 'done':
      return (
        <Row from="orchestrator">
          <p className="text-sm text-ok">✓ {message.summary}</p>
        </Row>
      );
    default:
      return null;
  }
}

function Row({ from, children }: { from: 'user' | 'orchestrator'; children: ReactNode }) {
  const isUser = from === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? 'bg-accent-soft' : 'border border-line bg-surface'
        }`}
      >
        {children}
      </div>
    </div>
  );
}
