/**
 * Did the model call the range, and which way did it get it wrong?
 *
 * One card per episode, newest first: the band the model proposed, the price
 * that followed, and a verdict that names WHICH mistake was made. Too narrow
 * and too wide are opposite failures with opposite fixes -- a breached band
 * stops earning, a band nobody visits spreads the capital over ground the price
 * never covered -- so a single accuracy score would hide the only thing worth
 * knowing.
 *
 * The arithmetic is `src/predictions/`, shared with the root test suite. This
 * file renders it and adds nothing to it.
 */

import { memo } from 'react';
import { DateFilter, Pager, inRange, usePaging, type DateRange } from '@/components/Filters';
import { RangeChart } from '@/components/RangeChart';
import { Unknown } from '@/components/Money';
import { NothingHere } from '@/components/Feedback';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/Surface';
import { Fact, FactGrid } from '@/components/FactGrid';
import { Badge } from '@/components/ui/badge';
import type { Episode, PredictionsResponse } from '@/lib/types';
import { duration, price, shortDate, shortOperation, utcDate, utcTime } from '@/lib/format';

const KIND_LABEL: Record<Episode['kind'], string> = {
  position: 'From the bot',
  unpredicted: 'No recorded prediction',
};

const KIND_NOTE: Record<Episode['kind'], string> = {
  position: '',
  unpredicted:
    'This position predates predictions being recorded. There is no recorded range to score, so the range that was actually live is held against the price instead.',
};

const VERDICT_LABEL: Record<string, string> = {
  'too-narrow': 'Too narrow',
  'too-wide': 'Too wide',
  'well-sized': 'Well sized',
};

export function Predictions({
  data,
  range,
  onRangeChange,
  onOpenOperation,
}: {
  data: PredictionsResponse;
  range: DateRange;
  onRangeChange: (range: DateRange) => void;
  onOpenOperation: (operationId: string) => void;
}) {
  const shown = data.episodes.filter((e) => inRange(e.window.from, range));
  const paging = usePaging(shown.length);
  const page = paging.slice(shown);

  return (
    <Panel>
      <DateFilter range={range} onChange={onRangeChange} />

      {/*
        `divide-y` ON A WRAPPER THAT HOLDS ONLY EPISODES, which is the only
        construction here that is correct by construction.

        The rule it replaces was `border-bottom` on every episode plus an
        `.episode:last-of-type` reset -- and that reset has never once
        matched. `:last-of-type` means "last sibling of this TAG name", and
        inside the panel the episodes' siblings include the toolbar `<div>`
        and the pager `<div>`, with the pager last. So it selected
        `div.pager`, which carries no `episode` class, and every episode drew
        its rule including the last one, 20px above the pager's own
        `border-top`. That double line has been on screen the whole time.

        Tailwind's `last:` is `:last-child` and has the identical bug for the
        identical reason. `divide-y` is `& > :not(:last-child)` scoped to a
        parent that contains nothing else, so there is no sibling to be
        wrong about.
      */}
      <div className="divide-y divide-border">
        {page.map((episode) => (
          <EpisodeCard
            key={episode.id}
            episode={episode}
            onOpenOperation={onOpenOperation}
          />
        ))}
      </div>

      {page.length === 0 && (
        <NothingHere everHad={data.episodes.length > 0} subject="predictions" />
      )}

      <Pager total={shown.length} unit="episodes" paging={paging} />
    </Panel>
  );
}

/* Memoised: the filter and the pager re-render the list, and redrawing seven
   charts of a hundred points each to change a date is work nobody asked for. */
const EpisodeCard = memo(function EpisodeCard({
  episode,
  onOpenOperation,
}: {
  episode: Episode;
  onOpenOperation: (operationId: string) => void;
}) {
  const { band, review, window } = episode;
  const hours =
    (new Date(window.to).getTime() - new Date(window.from).getTime()) / 3_600_000;

  return (
    <div className="pt-5 pb-2">
      {/* The `.episode-head` wrapper is gone and its inner `<div>` is what
          survives, because only one of its five declarations ever did
          anything. `display: flex` + `justify-content: space-between` +
          `gap: 12px` were a row built for two children and given one; what
          was live is `padding: 0 4px`, which is this `px-1`. Collapsing the
          flex row was not asserted to be inert -- a lone block child of a
          row flex container is sized to its content rather than to the line,
          so it could have changed where the two lines wrap. It was checked
          against the four `predictions` captures and moved nothing. */}
      <div className="px-1">
        <p className="m-0 flex flex-wrap items-center gap-2.5 text-2xl font-semibold">
          {shortDate(window.from)} – {shortDate(window.to)}
          <Badge variant={episode.kind}>{KIND_LABEL[episode.kind]}</Badge>
          {episode.live && <Badge variant="open">Still open</Badge>}
          {review.verdict && (
            <Badge variant={review.verdict}>{VERDICT_LABEL[review.verdict]}</Badge>
          )}
        </p>
        {/* `mt-1.25` is 5px, not a rounding of it. Tailwind v4's spacing
            scale is a multiplier, so every off-grid value in this sheet is
            expressible exactly and none of them needs a token of its own --
            which is `_decisions.md`'s answer to the eleven docs that each
            asked once. Doc 13 proposed `mt-1.5` and accepting a pixel of
            drift; it was written before that answer existed. */}
        <p className="mt-1.25 mb-0 text-base tabular-nums text-secondary-text">
          {price(band.lower)} – {price(band.upper)} · anchored on {price(band.anchor)}
          {episode.anchorFrom === 'first candle' && ' (the window’s opening price)'} ·{' '}
          {duration(hours)}
          {episode.source && ` · ${episode.source}`}
          {episode.operationId && (
            <>
              {' · '}
              <Button variant="anchor" size="inline" asChild className="inline-block font-mono">
                <a
                  href={`#/operations/${episode.operationId}`}
                  aria-label={episode.operationId}
                  title={episode.operationId}
                >
                  {shortOperation(episode.operationId)}
                </a>
              </Button>
            </>
          )}
        </p>
      </div>

      <RangeChart episode={episode} />

      {/* No `episode-facts`: that rule only ever set padding, and `.facts`
          was declared 250 lines LATER in the same unlayered sheet, so it won
          on source order and the override has never applied. Keeping the
          class here would have been the first time it did -- 16px shorter
          per episode card, which is how it was found. Doc 13 deletes it. */}
      <FactGrid>
        <Fact
          label="Predicted width"
          help="predictedWidth"
          value={`${review.predictedWidthPct.toFixed(2)}%`}
        />
        <Fact
          label="The price actually moved"
          help="realisedWidth"
          value={
            review.realisedWidthPct === null ? (
              <Unknown />
            ) : (
              `${review.realisedWidthPct.toFixed(2)}%`
            )
          }
        />
        <Fact
          label="Band used"
          help="coverage"
          value={
            review.coverageRatio === null ? (
              <Unknown />
            ) : (
              `${(review.coverageRatio * 100).toFixed(0)}%`
            )
          }
        />
        <Fact
          label="Hours closing in range"
          help="closesInRange"
          value={
            review.closesInRangePct === null ? (
              <Unknown />
            ) : (
              `${review.closesInRangePct.toFixed(0)}% of ${review.candleCount}`
            )
          }
        />
        <Fact
          label="Left the range"
          help="breach"
          value={
            review.firstBreachAt === null ? (
              <Unknown>never</Unknown>
            ) : (
              <span className="text-bad">
                {review.breachedUpper ? 'at the top' : 'at the bottom'},{' '}
                {utcDate(new Date(review.firstBreachAt))} {utcTime(new Date(review.firstBreachAt))}
              </span>
            )
          }
        />
        <Fact
          label="Highest and lowest"
          help="extremes"
          value={
            review.realisedLow === null || review.realisedHigh === null ? (
              <Unknown />
            ) : (
              `${price(review.realisedLow)} – ${price(review.realisedHigh)}`
            )
          }
        />
      </FactGrid>

      {/* 76ch, which is `01-tokens`' one measure in place of four hand-tuned
          ones. This note is one of the two wrap points that decision said
          would move. */}
      {KIND_NOTE[episode.kind] && (
        <p className="mx-1 mt-2.5 mb-0 max-w-note text-base text-muted-text">
          {KIND_NOTE[episode.kind]}
        </p>
      )}
    </div>
  );
});

