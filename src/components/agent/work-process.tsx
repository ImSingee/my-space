/**
 * The collapsible "Working / Worked" frame around an Agent reply's process:
 * reasoning, tool calls and intermediate prose. Shared by the live stream and
 * the persisted transcript so a reply keeps one shape from start to history.
 */
import { Box, Collapse, Loader, UnstyledButton } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconChevronRight } from '@tabler/icons-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import type { StreamOutcome } from './use-agent-stream';
import classes from './chat.module.css';

export type WorkPhase = 'running' | StreamOutcome;

/** Run timestamps on the server clock (ms). */
export type WorkTiming = {
  startedAt: number;
  /** Absent while the run is going, or when its end is unknown. */
  endedAt?: number;
} | null;

export type WorkFrame = {
  phase: WorkPhase;
  /** Null when the reply has no reliable run binding (legacy history). */
  timing: WorkTiming;
  expanded: boolean;
  onToggle: () => void;
};

/**
 * A finished reply folds its process away; a running, failed or stopped one
 * stays open so its progress or failure context remains visible.
 */
export function defaultWorkExpanded(phase: WorkPhase): boolean {
  return phase !== 'completed';
}

/** Server clock minus browser clock, for timers counting a live run. */
export const WorkClockOffset = createContext(0);

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Current server-clock time, re-rendered on each whole second since `anchor`. */
function useServerNow(anchor: number | null): number {
  const offset = useContext(WorkClockOffset);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    if (anchor === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now() + offset;
      setNow(current);
      const intoSecond = (((current - anchor) % 1000) + 1000) % 1000;
      timer = setTimeout(tick, 1000 - intoSecond);
    };
    tick();
    return () => clearTimeout(timer);
  }, [anchor, offset]);
  return now;
}

function WorkDuration({
  timing,
  running,
}: {
  timing: WorkTiming;
  running: boolean;
}) {
  const ticking = running && timing !== null && timing.endedAt === undefined;
  const now = useServerNow(ticking ? timing.startedAt : null);
  if (!timing) return null;
  const end = timing.endedAt ?? (ticking ? now : undefined);
  if (end === undefined) return null;
  return (
    <span className={classes.workDuration}>
      {formatElapsed(end - timing.startedAt)}
    </span>
  );
}

const ENDED_NOTE: Partial<Record<WorkPhase, string>> = {
  failed: 'Failed',
  cancelled: 'Stopped',
};

export function WorkProcess({
  frame,
  hasProcess,
  children,
}: {
  frame: WorkFrame;
  /** False when nothing precedes the final answer; the header is then static. */
  hasProcess: boolean;
  children?: ReactNode;
}) {
  const bodyId = useId();
  const reduceMotion = useReducedMotion();
  const running = frame.phase === 'running';
  const note = ENDED_NOTE[frame.phase];
  // A finished reply with nothing before its answer and no known duration
  // (legacy history) has nothing to show here.
  if (!hasProcess && frame.timing === null && frame.phase === 'completed') {
    return null;
  }
  // Spaces between the parts keep the copied text and accessible name
  // readable; the flex layout ignores them visually.
  const header = (
    <>
      {running ? (
        <span className={classes.workIcon}>
          <Loader size={11} color="gray" />
        </span>
      ) : null}
      <span className={classes.workLabel}>
        {running ? 'Working' : 'Worked'}
      </span>{' '}
      <WorkDuration timing={frame.timing} running={running} />
      {note ? (
        <>
          {' '}
          <span className={classes.workNote}>· {note}</span>
        </>
      ) : null}
      {hasProcess ? (
        <IconChevronRight
          size={14}
          className={
            frame.expanded ? classes.workChevronOpen : classes.workChevron
          }
        />
      ) : null}
    </>
  );

  return (
    <Box className={classes.work}>
      {hasProcess ? (
        <UnstyledButton
          className={classes.workHeader}
          aria-expanded={frame.expanded}
          aria-controls={bodyId}
          onClick={frame.onToggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.workHeader}>{header}</Box>
      )}
      {hasProcess ? (
        <Collapse
          id={bodyId}
          expanded={frame.expanded}
          transitionDuration={reduceMotion ? 0 : 200}
        >
          <Box className={classes.workBody}>{children}</Box>
        </Collapse>
      ) : null}
    </Box>
  );
}
