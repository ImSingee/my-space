import { type ReactNode, useEffect, useRef, useState } from 'react';

type WithId = { id: string };

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
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;
  const movedRef = useRef(false);

  // Keep local order in sync when items are added/removed (but never mid-drag).
  useEffect(() => {
    if (draggingId) return;
    const ids = items.map((i) => i.id);
    setOrder((prev) => {
      const sameSet =
        prev.length === ids.length && prev.every((id) => ids.includes(id));
      return sameSet ? prev : ids;
    });
  }, [items, draggingId]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((x): x is T => Boolean(x));

  const move = (from: string, to: string) =>
    setOrder((prev) => {
      const next = [...prev];
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, from);
      movedRef.current = true;
      return next;
    });

  return (
    <>
      {ordered.map((item) => (
        <div
          key={item.id}
          draggable
          style={{ opacity: draggingId === item.id ? 0.5 : 1 }}
          onDragStart={(e) => {
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
            setDraggingId(null);
            if (movedRef.current) onReorder(orderRef.current);
            movedRef.current = false;
          }}
        >
          {renderItem(item)}
        </div>
      ))}
    </>
  );
}
