/**
 * The control that opens a row, and the reason this file exists.
 *
 * THE WORST DEFECT IN THE APP WAS HERE. Three `<tr onClick>` handlers with no
 * `role`, no `tabIndex`, no `onKeyDown` and no `aria-expanded`, which meant
 * every detail panel in the ledger was reachable only with a mouse --
 * including the Summary panel that answers whether a position made money. A
 * screen reader was told nothing at all: the only signal that a row was open
 * or shut was a `▸`, which is announced, if at all, as a geometric shape.
 *
 * The fix is a real `<button>`, not `role="button"` on the `<tr>`. A row
 * wearing a button role destroys the table semantics every other cell
 * depends on, and hand-rolling Space and Enter is the thing a real button
 * gives away for free.
 *
 * The row keeps its own `onClick`. It is a pointer convenience that costs
 * nothing, and the whole-row target is why the old "View detail" button could
 * be deleted. The button therefore stops the event -- the same pattern
 * `TxLink`, the operation link and `Help` all already use -- or the two
 * handlers fire in turn and cancel each other out.
 */

export function RowToggle({
  open,
  controls,
  label,
  onToggle,
}: {
  open: boolean;
  /** The `id` of the row this opens, so `aria-controls` resolves. */
  controls: string;
  /** Names the row, because "expand" four times over says nothing. */
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      /*
       * `[font:inherit]` and not a flex box, because the caret used to be a
       * bare text node in a centred 22px cell: it overflowed its 2px content
       * box symmetrically, which is what centred it. A `<button>` with no
       * preflight inherits nothing -- the UA hands it 13.3px Arial -- and a
       * flex container would size to its content and widen the column.
       */
      className="block w-full cursor-pointer border-0 bg-transparent p-0 text-muted-text [font:inherit] select-none focus-visible:rounded-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
  );
}
