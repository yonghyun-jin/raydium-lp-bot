/**
 * The chart this whole scope exists for: each strategy's cumulative RETURN,
 * compounded cycle by cycle from the first open.
 *
 * NOT cumulative dollars, and the switch was not cosmetic. Dollars weight each
 * cycle by its own size, and this bot's size jumped ~4x mid-record -- so the
 * dollar chart's slope changed meaning partway along and read as performance
 * when part of it was just more capital. A return cannot be moved by deposit
 * size at all. Percent rather than a $100 index, because an index invites the
 * reader to look for a $100 deposit that never happened.
 *
 * MATCHED WINDOWS: every line moves only while a position was live, and the
 * gaps between cycles move nothing. The gaps are the operator not having
 * pressed confirm, not a decision the strategy made. See types.ts SeriesPoint.
 *
 * Three lines, and the third is load-bearing. Blue is the bot. Orange is all
 * SOL -- the comparison the operator actually asks for. The grey dotted line
 * is the basket the bot itself deposited, and WITHOUT IT "beat SOL" reads as
 * skill when it is mostly just holding half stablecoin into a falling market.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Pct } from '@/components/Money';
import { CHART } from '@/lib/theme';
import type { WirePoint } from '@/lib/types';
import { dateTime } from '@/lib/format';

/** "21 Sep 14:03" — short enough for an axis, unambiguous within a day. */
function axisTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface Props {
  series: WirePoint[];
}

/**
 * A direct label at the end of each line, so identity is never colour-alone.
 * The text is ink; a small filled dot beside it carries the series colour.
 */
function endLabel(lastIndex: number, color: string, text: string, inkColor: string) {
  // Recharts types this renderer as returning an element, never null, so a
  // point that gets no label renders an empty group rather than nothing.
  return function EndLabel(props: { x?: number; y?: number; index?: number }) {
    const { x, y, index } = props;
    if (index !== lastIndex || x === undefined || y === undefined) return <g />;
    return (
      <g>
        <circle cx={x + 12} cy={y} r={3.5} fill={color} />
        <text x={x + 20} y={y + 4} fill={inkColor} fontSize={12} fontWeight={600}>
          {text}
        </text>
      </g>
    );
  };
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  const at = (key: string) => payload.find((p) => p.dataKey === key)?.value ?? null;
  const lp = at('lpReturnPct');
  const sol = at('allSolReturnPct');
  const mix = at('mixReturnPct');

  // "pp" -- the gap between two percentages is percentage POINTS, not a
  // percentage of anything, and writing % there invites dividing by something.
  const gap = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);

  return (
    <div className="rounded-md border border-border-strong bg-surface-1 px-3 py-2.5 text-md shadow-float [&_strong]:ml-auto [&_strong]:pl-4.5 [&_strong]:text-primary-text [&_strong]:tabular-nums">
      <p className="m-0 mb-1.5 font-semibold text-primary-text">{label ? dateTime(label) : ''}</p>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        <span className="size-2.5 shrink-0 rounded-xs bg-series-lp" />
        My LP strategy{' '}
        <strong>
          <Pct value={lp} unit="percent" />
        </strong>
      </div>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        <span className="size-2.5 shrink-0 rounded-xs bg-series-hodl" />
        Holding all SOL{' '}
        <strong>
          <Pct value={sol} unit="percent" />
        </strong>{' '}
        <Pct value={gap(lp, sol)} unit="points" tone="muted" />
      </div>
      <div className="mt-0.75 flex items-center gap-2 text-secondary-text">
        <span className="size-2.5 shrink-0 rounded-xs bg-series-mix" />
        Holding what I deposited{' '}
        <strong>
          <Pct value={mix} unit="percent" />
        </strong>{' '}
        <Pct value={gap(lp, mix)} unit="points" tone="muted" />
      </div>
    </div>
  );
}

export function PnlChart({ series }: Props) {
  const last = series.length - 1;

  return (
    /*
     * `h-85` IS THE CHART'S ONLY HEIGHT, and dropping it renders nothing.
     * `ResponsiveContainer` measures this parent, so with no height here the
     * chart is 340px of blank with no error and no warning. `RangeChart`'s
     * `h-65` is the same trap one page over.
     */
    <div className="h-85 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 12, right: 118, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="t"
            /* Date alone is ambiguous here: cycles can open and close hours
               apart, which renders two different points as the same "21 Sep". */
            tickFormatter={axisTime}
            stroke={CHART.grid}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: CHART.grid }}
            minTickGap={60}
          />
          <YAxis
            /* No explicit +: a sign on every gridline is noise. The zero line
               says which half of the axis you are in. */
            tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`}
            domain={['auto', 'auto']}
            stroke={CHART.grid}
            tick={{ fill: CHART.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={78}
          />
          {/* Break-even. On a return axis the zero line is the whole reference. */}
          <ReferenceLine y={0} stroke={CHART.zero} strokeWidth={1} />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: CHART.zero, strokeWidth: 1 }}
          />
          {/* Dotted and grey on purpose: it is the control, not a rival
              strategy, and it must not compete with the two the operator
              asked for. It is still the line that says whether the POOL did
              anything. */}
          <Line
            type="linear"
            dataKey="mixReturnPct"
            name="Holding what I deposited"
            stroke={CHART.mix}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={{ r: 3, fill: CHART.mix, strokeWidth: 0 }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: CHART.grid }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="allSolReturnPct"
            name="Holding all SOL"
            stroke={CHART.hodl}
            strokeWidth={2}
            dot={{ r: 4, fill: CHART.hodl, strokeWidth: 0 }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: CHART.grid }}
            /* An unknown benchmark leaves a GAP. Joining across it would draw a
               number nobody measured. */
            connectNulls={false}
            isAnimationActive={false}
            label={endLabel(last, CHART.hodl, 'All SOL', CHART.text)}
          />
          <Line
            type="linear"
            dataKey="lpReturnPct"
            name="My LP strategy"
            stroke={CHART.lp}
            strokeWidth={2}
            dot={{ r: 4, fill: CHART.lp, strokeWidth: 0 }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: CHART.grid }}
            isAnimationActive={false}
            label={endLabel(last, CHART.lp, 'My LP', CHART.text)}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
