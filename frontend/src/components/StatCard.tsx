interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  subColor?: string;
}

export function StatCard({ label, value, sub, subColor }: StatCardProps) {
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--text-muted)',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 20,
        fontWeight: 600,
        color: 'var(--text)',
        lineHeight: 1.2,
        marginBottom: sub ? 4 : 0,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{
          fontSize: 12,
          color: subColor || 'var(--text-muted)',
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}
