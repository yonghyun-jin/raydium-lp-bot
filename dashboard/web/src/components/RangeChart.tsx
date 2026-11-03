/**
 * One prediction against what the price did.
 *
 * The band is the claim; the line is the answer. Everything else on the chart
 * is there to let the two be compared without arithmetic:
 *
 *  - the shaded band is the range that was predicted (or, for a position with
 *    no recorded prediction, the range that was actually live);
 *  - the faint envelope behind the line is each hour's HIGH and LOW, because a
 *    range is broken by a touch, not by a close, and a line of closes hides
 *    exactly the moment that matters;
 *  - the dashed line is the anchor the band was built around;
 *  - the marker is the first hour the price traded outside the band.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { NoData } from '@/components/Feedback';
import { CHART } from '@/lib/theme';
import type { Episode } from '@/lib/types';
import { price } from '@/lib/format';

function axisTime(t: number): string {
  return new Date(t).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ChartTooltip({
  active,
  payload,
  label,
  band,
}: {
  active?: boolean;
  payload?: Array<{ payload?: { high: number; low: number; close: number } }>;
  label?: number;
  band: { lower: number; upper: number };
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const outside = row.high > band.upper || row.low < band.lower;

  return (
    <div className="rounded-md border border-border-strong bg-surface-1 px-3 py-2.5 text-md shadow-float [&_strong]:ml-auto [&_strong]:pl-4.5 [&_strong]:text-primary-text [&_strong]:tabular-nums">
      <p className="m-0 mb-1.5 font-semibold text-primary-text">{label ? axisTime(label) : ''}</p>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        Close <strong>{price(row.close)}</strong>
      </div>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        Hour high <strong>{price(row.high)}</strong>
      </div>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        Hour low <strong>{price(row.low)}</strong>
      </div>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">{outside ? 'Outside the range' : 'Inside the range'}</div>
    </div>
  );
}

export function RangeChart({ episode }: { episode: Episode }) {
  const { band, candles, review } = episode;

  if (candles.length === 0) {
    return (
      <NoData>No price history for this window — nothing to compare the range against.</NoData>
    );
  }

  const data = candles.map((c) => ({ ...c, envelope: [c.low, c.high] as [number, number] }));

  /* The axis has to hold BOTH the band and the price, or a breach renders as
     the line stopping at the edge of the plot instead of leaving the band. */
  const low = Math.min(band.lower, review.realisedLow ?? band.lower);
  const high = Math.max(band.upper, review.realisedHigh ?? band.upper);
  const pad = (high - low) * 0.08;

  return (
    /*
     * `h-65` IS THE CHART'S ONLY HEIGHT, and dropping it renders nothing.
     * `ResponsiveContainer` measures this parent, so with no height here the
     * chart is 260px of nothing: no error, no warning, an episode card with a
     * gap where its picture was. 260 is 65 spacing steps exactly, so it needs
     * no token of its own. `.chart-wrap`'s 340px on the Dashboard is the same
     * trap one page over.
     */
    <div className="mt-3 h-65 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={axisTime}
            stroke={CHART.grid}
            tick={{ fill: CHART.axis, fontSize: 11.5 }}
            tickLine={false}
            axisLine={{ stroke: CHART.grid }}
            minTickGap={70}
          />
          <YAxis
            domain={[low - pad, high + pad]}
            tickFormatter={(v: number) => price(v)}
            stroke={CHART.grid}
            tick={{ fill: CHART.axis, fontSize: 11.5 }}
            tickLine={false}
            axisLine={false}
            width={72}
          />

          {/* The predicted range. Drawn first so the price sits on top of it. */}
          <ReferenceArea
            y1={band.lower}
            y2={band.upper}
            fill={CHART.lp}
            fillOpacity={0.14}
            stroke={CHART.lp}
            strokeOpacity={0.5}
            strokeWidth={1}
          />
          <ReferenceLine
            y={band.anchor}
            stroke={CHART.axis}
            strokeDasharray="4 4"
            strokeWidth={1}
          />

          <Tooltip
            content={<ChartTooltip band={band} />}
            cursor={{ stroke: CHART.zero, strokeWidth: 1 }}
          />

          <Area
            dataKey="envelope"
            stroke="none"
            fill={CHART.hodl}
            fillOpacity={0.18}
            isAnimationActive={false}
            activeDot={false}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke={CHART.hodl}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 0, fill: CHART.hodl }}
            isAnimationActive={false}
          />

          {review.firstBreachAt !== null && (
            <ReferenceLine
              x={review.firstBreachAt}
              stroke={CHART.hodl}
              strokeWidth={1.5}
              strokeDasharray="3 3"
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
