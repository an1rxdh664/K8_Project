'use client';

import type { StepState } from '@/types';

function StepIcon({ status }: { status: StepState['status'] }) {
  if (status === 'done') {
    return (
      <span className="step-icon done" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="step-icon failed" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M3 3l4 4M7 3l-4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </span>
    );
  }
  return <span className={`step-icon ${status}`} />;
}

interface StepListProps {
  steps: StepState[];
}

export function StepList({ steps }: StepListProps) {
  return (
    <div>
      {steps.map((step, i) => {
        const isMuted = step.status === 'pending';
        return (
          <div
            key={step.id}
            className={`step-item step-appear`}
            style={{ animationDelay: `${i * 40}ms`, opacity: isMuted ? 0.5 : 1 }}
          >
            <StepIcon status={step.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: step.status === 'active' ? 500 : 400 }}>
                {step.label}
              </div>
              {step.detail && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  {step.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
