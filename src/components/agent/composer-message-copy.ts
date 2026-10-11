import { useEffect, useRef } from 'react';

const referenceSelector = '[data-composer-reference]';
const registrations = new WeakMap<
  Document,
  { roots: Set<HTMLElement>; copy: (event: ClipboardEvent) => void }
>();

/** One listener per document also handles selections spanning message bubbles. */
export function useComposerMessageCopy(enabled: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const document = root.ownerDocument;
    let registration = registrations.get(document);
    if (!registration) {
      const roots = new Set<HTMLElement>();
      const copy = (event: ClipboardEvent) => {
        if (event.defaultPrevented || !event.clipboardData) return;
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
          return;
        const range = selection.getRangeAt(0);
        const copyRange = range.cloneRange();
        const references = new Map<string, string>();
        for (const root of roots) {
          if (!range.intersectsNode(root)) continue;
          for (const element of root.querySelectorAll<HTMLElement>(
            referenceSelector,
          )) {
            const contents = document.createRange();
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            const first = walker.nextNode();
            if (!first) continue;
            let last = first;
            while (walker.nextNode()) last = walker.currentNode;
            contents.setStart(first, 0);
            contents.setEnd(last, last.textContent!.length);
            if (
              range.compareBoundaryPoints(Range.START_TO_START, contents) <=
                0 &&
              range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
            ) {
              references.set(
                element.dataset.composerReferenceKey!,
                element.dataset.composerReference!,
              );
              // A browser drag can select the complete label while its range
              // endpoints are inside the text nodes. Include the enclosing
              // span in the clone so its reference metadata survives copying.
              if (element.contains(copyRange.startContainer))
                copyRange.setStartBefore(element);
              if (element.contains(copyRange.endContainer))
                copyRange.setEndAfter(element);
            }
          }
        }
        // A partial label selection must retain native plain-text copying.
        if (references.size === 0) return;
        const container = document.createElement('div');
        container.append(copyRange.cloneContents());
        const html = container.innerHTML;
        for (const element of container.querySelectorAll<HTMLElement>(
          referenceSelector,
        )) {
          const reference = references.get(
            element.dataset.composerReferenceKey!,
          );
          if (reference)
            element.replaceWith(document.createTextNode(reference));
        }
        // innerText preserves rendered block boundaries across messages. A
        // detached fragment's textContent would join separate bubbles together.
        container.style.cssText =
          'position:fixed;left:-100000px;white-space:pre-wrap;opacity:0;pointer-events:none';
        container.setAttribute('aria-hidden', 'true');
        document.body.append(container);
        try {
          event.clipboardData.setData('text/plain', container.innerText);
          event.clipboardData.setData('text/html', html);
          event.preventDefault();
        } finally {
          container.remove();
        }
      };
      registration = { roots, copy };
      registrations.set(document, registration);
      document.addEventListener('copy', copy);
    }
    registration.roots.add(root);
    return () => {
      registration.roots.delete(root);
      if (registration.roots.size === 0) {
        document.removeEventListener('copy', registration.copy);
        registrations.delete(document);
      }
    };
  }, [enabled]);
  return ref;
}
