'use client';

import { useEffect, useState } from 'react';
import { useSound } from '@/hooks/useSound';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const { play } = useSound();

  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored ? stored === 'dark' : prefersDark;
    setDark(isDark);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, []);

  function toggle() {
    play('click');
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  return (
    <div className="flex items-center gap-2">
      <span style={{ fontSize: 11, color: 'var(--text-muted)', userSelect: 'none' }}>
        {dark ? '🌙' : '☀️'}
      </span>
      <button
        className="theme-toggle"
        data-active={dark ? 'true' : 'false'}
        onClick={toggle}
        aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        title={dark ? 'Light mode' : 'Dark mode'}
      >
        <span className="theme-toggle-knob" />
      </button>
    </div>
  );
}
