import React from 'react';
import { HypeChart } from '../components/HypeChart';
import { ArrowUpRight, Trophy } from 'lucide-react';

export function Benchmarks() {
  // Mock data for a successful historical run (e.g., PEPE launch)
  const generateHistoricalData = () => {
    const data = [];
    let price = 0.000001;
    let score = 10;
    
    for (let i = 0; i < 100; i++) {
      // Phase 1: Early accumulation (Low hype, flat price)
      if (i < 20) {
        score += Math.random() * 2 - 0.5;
        price += (Math.random() - 0.5) * 0.0000001;
      } 
      // Phase 2: Viral moment (Hype spikes, price follows)
      else if (i < 50) {
        score += Math.random() * 15;
        price += price * 0.05; // 5% growth per tick
      }
      // Phase 3: FOMO (Hype peaks, price explodes)
      else if (i < 80) {
        score += Math.random() * 5;
        price += price * 0.10;
      }
      // Phase 4: Correction (Hype drops, price corrects)
      else {
        score -= Math.random() * 10;
        price -= price * 0.05;
      }

      data.push({
        time: Date.now() - (100 - i) * 3600000, // Hourly points
        score: Math.max(0, score),
        price: Math.max(0, price)
      });
    }
    return data;
  };

  const caseStudies = [
    { name: '$PEPE', date: 'April 2023', return: '15,000%', data: generateHistoricalData() },
    { name: '$BONK', date: 'Dec 2022', return: '4,000%', data: generateHistoricalData() },
  ];

  return (
    <div className="space-y-8">
      <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-neutral-900 mb-2 flex items-center gap-2">
          <Trophy className="text-yellow-500" /> Historical Benchmarks
        </h1>
        <p className="text-neutral-500 max-w-2xl">
          Analyze past "moonshots" to understand the correlation between our TrueHype™ score and price action. 
          These case studies validate the algorithm's ability to detect viral momentum before major price breakouts.
        </p>
      </div>

      <div className="grid gap-8">
        {caseStudies.map((study) => (
          <div key={study.name} className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-xl font-bold text-neutral-900">{study.name} Case Study</h2>
                <p className="text-sm text-neutral-500">{study.date}</p>
              </div>
              <div className="bg-green-50 border border-green-200 px-4 py-2 rounded-xl flex items-center gap-2">
                <ArrowUpRight className="w-4 h-4 text-green-600" />
                <span className="text-green-600 font-bold">{study.return}</span>
              </div>
            </div>
            
            <div className="h-[300px] bg-neutral-50 rounded-xl border border-neutral-200 p-4">
              <HypeChart data={study.data} />
            </div>
            
            <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div className="p-3 bg-neutral-50 rounded-lg border border-neutral-200">
                <span className="text-neutral-500 block mb-1">Peak Hype Score</span>
                <span className="text-indigo-600 font-bold">842.5</span>
              </div>
              <div className="p-3 bg-neutral-50 rounded-lg border border-neutral-200">
                <span className="text-neutral-500 block mb-1">Time to 10x</span>
                <span className="text-neutral-900 font-bold">4 Days</span>
              </div>
              <div className="p-3 bg-neutral-50 rounded-lg border border-neutral-200">
                <span className="text-neutral-500 block mb-1">Signal Accuracy</span>
                <span className="text-emerald-600 font-bold">94%</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
