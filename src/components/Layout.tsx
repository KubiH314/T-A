import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { LayoutDashboard, LineChart, Activity, Settings, Menu, X } from 'lucide-react';
import { cn } from '../lib/utils';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function Layout({ children, activeTab, onTabChange }: LayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const navItems = [
    { id: 'dashboard', label: 'Live Dashboard', icon: LayoutDashboard },
    { id: 'benchmarks', label: 'Historical Benchmarks', icon: LineChart },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-indigo-500/30">
      {/* Mobile Header */}
      <div className="lg:hidden flex items-center justify-between p-4 border-b border-neutral-200 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <Activity className="w-6 h-6 text-indigo-600" />
          <span className="font-bold text-lg tracking-tight">MemePulse</span>
        </div>
        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2">
          {isSidebarOpen ? <X /> : <Menu />}
        </button>
      </div>

      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <motion.aside
          initial={false}
          animate={{ x: isSidebarOpen ? 0 : '-100%' }}
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-64 bg-white border-r border-neutral-200 transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0",
            !isSidebarOpen && "hidden lg:block"
          )}
        >
          <div className="p-6 flex items-center gap-3 border-b border-neutral-200">
            <Activity className="w-6 h-6 text-indigo-600" />
            <span className="font-bold text-xl tracking-tight">MemePulse</span>
          </div>

          <nav className="p-4 space-y-2">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onTabChange(item.id);
                  setIsSidebarOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
                  activeTab === item.id
                    ? "bg-indigo-50 text-indigo-600 font-medium"
                    : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                )}
              >
                <item.icon className="w-5 h-5" />
                {item.label}
              </button>
            ))}
          </nav>

          <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-neutral-200">
            <div className="text-xs text-neutral-400">
              <p>MemePulse MVP v0.1</p>
              <p className="mt-1">Powered by TrueHype™ Algorithm</p>
            </div>
          </div>
        </motion.aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto bg-neutral-50 relative">
          <div className="max-w-7xl mx-auto p-4 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
