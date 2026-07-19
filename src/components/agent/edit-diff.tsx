/** Compact, line-oriented rendering for an `edit_file` display diff. */
import classes from './chat.module.css';

function lineClass(line: string): string {
  if (line.startsWith('+')) return classes.editDiffAdded;
  if (line.startsWith('-')) return classes.editDiffRemoved;
  return classes.editDiffContext;
}

export function EditDiff({ diff }: { diff: string }) {
  return (
    <section className={classes.editDiff} aria-label="File changes">
      {diff.split('\n').map((line, index) => (
        <span key={index} className={lineClass(line)}>
          {line.replaceAll('\t', '   ')}
        </span>
      ))}
    </section>
  );
}
