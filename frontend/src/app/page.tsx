'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { StatusSection } from '@/components/StatusSection';
import { ServicesSection } from '@/components/ServicesSection';
import { LogsSection } from '@/components/LogsSection';
import { MigrationsSection } from '@/components/MigrationsSection';
import { ResilienceSection } from '@/components/ResilienceSection';
import { SetupSection } from '@/components/SetupSection';
import { OnboardSection } from '@/components/OnboardSection';
import type { NavSection } from '@/types';

export default function Home() {
  const [section, setSection] = useState<NavSection>('status');

  function renderSection() {
    switch (section) {
      case 'status':     return <StatusSection />;
      case 'services':   return <ServicesSection />;
      case 'logs':       return <LogsSection />;
      case 'migrations': return <MigrationsSection />;
      case 'resilience': return <ResilienceSection />;
      case 'setup':      return <SetupSection />;
      case 'onboard':    return <OnboardSection />;
    }
  }

  return (
    <div className="layout">
      <Sidebar active={section} onChange={setSection} />
      <main className="content">
        {renderSection()}
      </main>
    </div>
  );
}
