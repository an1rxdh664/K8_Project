'use client';

import { NavSection } from '@/types';
import { ThemeToggle } from './ThemeToggle';
import { useSound } from '@/hooks/useSound';

interface NavItem {
  id: NavSection;
  label: string;
  icon: string;
  /** Optional visual divider above this item */
  divider?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'status',     label: 'Status',          icon: '◉' },
  { id: 'services',   label: 'Services',         icon: '⬡' },
  { id: 'logs',       label: 'Logs',             icon: '≡' },
  { id: 'migrations', label: 'Migrations',       icon: '⇄' },
  { id: 'resilience', label: 'Resilience Tests', icon: '◈' },
  { id: 'setup',      label: 'Setup',            icon: '⚙', divider: true },
  { id: 'onboard',    label: 'Onboard Service',  icon: '+' },
];

interface SidebarProps {
  active: NavSection;
  onChange: (section: NavSection) => void;
}

export function Sidebar({ active, onChange }: SidebarProps) {
  const { play } = useSound();

  function handleNav(id: NavSection) {
    if (id === active) return;
    play('section');
    onChange(id);
  }

  return (
    <nav className="sidebar">
      {/* Logo / wordmark */}
      <div style={{
        padding: '22px 18px 14px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 26, height: 26,
            background: 'var(--accent)',
            borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 13, fontWeight: 700, flexShrink: 0,
          }}>K</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>
              Platform
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.2 }}>
              Dashboard
            </div>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <div style={{ padding: '10px 10px', flex: 1 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.id === active;
          return (
            <div key={item.id}>
              {item.divider && (
                <div style={{
                  margin: '8px 10px 6px',
                  borderTop: '1px solid var(--border)',
                }} />
              )}
              <button
                onClick={() => handleNav(item.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text)',
                  transition: 'background 150ms ease, color 150ms ease',
                  textAlign: 'left',
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }
                }}
              >
                <span style={{
                  fontSize: item.id === 'onboard' ? 16 : 14,
                  lineHeight: 1,
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  width: 16,
                  textAlign: 'center',
                  flexShrink: 0,
                }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            </div>
          );
        })}
      </div>

      {/* Footer — theme toggle */}
      <div style={{
        padding: '14px 18px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Theme</span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
