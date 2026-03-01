import React, { useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { format } from 'date-fns';

interface HypeChartProps {
  data: { time: number; score: number; price: number }[];
}

export function HypeChart({ data }: HypeChartProps) {
  const candleData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    // If we have very few points, don't aggregate too much
    // Target around 30-50 candles
    const itemsPerCandle = Math.max(1, Math.floor(data.length / 40));
    
    const candles = [];
    for (let i = 0; i < data.length; i += itemsPerCandle) {
      const chunk = data.slice(i, i + itemsPerCandle);
      if (chunk.length === 0) continue;

      const prices = chunk.map(d => d.price);
      const scores = chunk.map(d => d.score);
      const open = prices[0];
      const close = prices[prices.length - 1];
      const high = Math.max(...prices);
      const low = Math.min(...prices);

      candles.push({
        time: chunk[chunk.length - 1].time,
        open,
        close,
        high,
        low,
        // Recharts Range Bar expects [min, max]
        body: [Math.min(open, close), Math.max(open, close)], 
        wick: [low, high],
        color: close >= open ? '#10b981' : '#ef4444',
        score: scores.reduce((a, b) => a + b, 0) / scores.length,
        price: close // For tooltip
      });
    }
    return candles;
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <div className="h-[300px] w-full flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200">
        <p className="text-neutral-500">Waiting for data stream...</p>
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={candleData}>
          <defs>
            <linearGradient id="colorScore" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" vertical={false} />
          <XAxis 
            dataKey="time" 
            tickFormatter={(time) => format(time, 'HH:mm:ss')} 
            stroke="#a3a3a3"
            fontSize={12}
            tickMargin={10}
            minTickGap={30}
          />
          <YAxis 
            yAxisId="left" 
            stroke="#6366f1" 
            fontSize={12}
            tickFormatter={(val) => val.toFixed(1)}
            label={{ value: 'TrueHype', angle: -90, position: 'insideLeft', fill: '#6366f1' }}
          />
          <YAxis 
            yAxisId="right" 
            orientation="right" 
            stroke="#10b981" 
            fontSize={12}
            domain={['auto', 'auto']}
            tickFormatter={(val) => `$${val.toFixed(6)}`}
          />
          <Tooltip 
            contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e5e5e5', borderRadius: '8px', color: '#171717' }}
            labelFormatter={(label) => format(label, 'HH:mm:ss')}
            formatter={(value: any, name: string, props: any) => {
              if (name === 'score') return [value.toFixed(2), 'TrueHype Score'];
              if (name === 'body' || name === 'wick') return [null, null]; // Hide internal ranges
              return [`$${props.payload.price.toFixed(8)}`, 'Price'];
            }}
            filterNull={true}
          />
          
          {/* Hype Score Line */}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="score"
            stroke="#6366f1"
            strokeWidth={2}
            dot={false}
          />

          {/* Candle Wicks (High-Low) */}
          <Bar
            yAxisId="right"
            dataKey="wick"
            barSize={1}
            isAnimationActive={false}
          >
            {candleData.map((entry, index) => (
              <Cell key={`wick-${index}`} fill={entry.color} />
            ))}
          </Bar>

          {/* Candle Bodies (Open-Close) */}
          <Bar
            yAxisId="right"
            dataKey="body"
            barSize={8}
            isAnimationActive={false}
          >
             {candleData.map((entry, index) => (
              <Cell key={`body-${index}`} fill={entry.color} />
            ))}
          </Bar>

        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
