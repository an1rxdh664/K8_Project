interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 16, color = 'var(--accent)' }: SpinnerProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `2px solid var(--border)`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }}
      aria-label="Loading"
    />
  );
}
