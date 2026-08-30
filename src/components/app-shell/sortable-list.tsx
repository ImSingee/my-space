import { type ReactNode, useRef, useState } from 'react';

type WithId = { id: string };

/**
 * Returns a new array ordered to match `orderedIds`. Useful for optimistically
 * updating a cached list to a freshly-dragged order. Items whose id is missing
 * from `orderedIds` are kept, ordered after the known ones.
 */
export function sortByIds<T extends WithId>(
  items: T[] | undefined,
  orderedIds: string[],
): T[] | undefined {
  if (!items) return items;
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Minimal dependency-free vertical sortable list using native HTML5 drag and
 * drop. Reorders optimistically while dragging and persists the final order via
 * `onReorder` once the drag ends.
 */
export function SortableList<T extends WithId>({
  items,
  onReorder,
  renderItem,
}: {
  items: T[];
  onReorder: (orderedIds: string[]) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const movedRef = useRef(false);
  const itemOrder = items.map((item) => item.id);
  const order = dragOrder ?? itemOrder;

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((x): x is T => Boolean(x));

  const move = (from: string, to: string) => {
    const current = dragOrderRef.current;
    if (!current) return;
    const next = [...current];
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, from);
    dragOrderRef.current = next;
    movedRef.current = true;
    setDragOrder(next);
  };

  return (
    <>
      {ordered.map((item) => (
        <div
          key={item.id}
          draggable
          style={{ opacity: draggingId === item.id ? 0.5 : 1 }}
          onDragStart={(e) => {
            dragOrderRef.current = itemOrder;
            setDragOrder(itemOrder);
            setDraggingId(item.id);
            movedRef.current = false;
            e.dataTransfer.effectAllowed = 'move';
            // Firefox requires data to be set for dragging to start.
            e.dataTransfer.setData('text/plain', item.id);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            if (draggingId && draggingId !== item.id) move(draggingId, item.id);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragEnd={() => {
            const finalOrder = dragOrderRef.current;
            dragOrderRef.current = null;
            setDragOrder(null);
            setDraggingId(null);
            if (movedRef.current && finalOrder) onReorder(finalOrder);
            movedRef.current = false;
          }}
        >
          {renderItem(item)}
        </div>
      ))}
    </>
  );
}
