/** Timeline step rows shared by the persisted transcript and the live stream. */
import { Box, Collapse, Loader, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconSparkles,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { StreamTool } from './use-agent-stream';
import { toolDetail, toolLabel } from './types';
import classes from './chat.module.css';

export type ToolStatus = 'running' | 'done' | 'error';

/**
 * One quiet line in the agent's activity timeline. Used for thinking and tool
 * calls/results alike so the whole "process" reads with a single visual
 * language instead of mixed chips and boxes. Expands in place when it has a
 * body (result or thinking text).
 */
function StepRow({
  icon,
  label,
  detail,
  error,
  children,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  error?: boolean;
  children?: ReactNode;
}) {
  const [open, handlers] = useDisclosure(false);
  const expandable = Boolean(children);
  const inner = (
    <>
      <span className={error ? classes.stepIconError : classes.stepIcon}>
        {icon}
      </span>
      <span className={classes.stepLabel}>{label}</span>
      {detail ? <span className={classes.stepDetail}>{detail}</span> : null}
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );
  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {inner}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{inner}</Box>
      )}
      {expandable ? <Collapse expanded={open}>{children}</Collapse> : null}
    </Box>
  );
}

export function ThinkingStep({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <StepRow icon={<IconSparkles size={13} stroke={1.6} />} label="Thinking">
      <Box className={classes.stepBody}>
        <Box className={classes.stepBodyText}>{text}</Box>
      </Box>
    </StepRow>
  );
}

export function ToolStep({
  name,
  detail,
  status,
  result,
}: {
  name: string;
  detail?: string;
  status: ToolStatus;
  result?: { text: string; isError?: boolean };
}) {
  const isError = status === 'error' || result?.isError === true;
  const icon =
    status === 'running' ? (
      <Loader size={11} color="gray" />
    ) : isError ? (
      <IconAlertTriangle size={14} stroke={1.7} />
    ) : (
      <IconCheck size={14} stroke={2} />
    );
  return (
    <StepRow
      icon={icon}
      label={toolLabel(name)}
      detail={detail}
      error={isError}
    >
      {result ? (
        <Box className={classes.stepBody}>
          <Box className={classes.stepBodyCode}>
            {result.text || '(no output)'}
          </Box>
        </Box>
      ) : null}
    </StepRow>
  );
}

/**
 * Thinking in the live stream. While the model is reasoning it shows the
 * thinking text in real time (auto-scrolled); once it moves on to answering or
 * tools, it collapses to a quiet, re-expandable "Thinking" row.
 */
export function StreamingThinkingStep({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, active]);

  if (!text.trim()) return null;
  const showBody = active || open;
  const expandable = !active;
  const header = (
    <>
      <span className={classes.stepIcon}>
        {active ? (
          <Loader size={11} color="gray" />
        ) : (
          <IconSparkles size={13} stroke={1.6} />
        )}
      </span>
      <span className={classes.stepLabel}>
        {active ? 'Thinking…' : 'Thinking'}
      </span>
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );

  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      {showBody ? (
        <Box className={classes.stepBody}>
          <Box ref={bodyRef} className={classes.stepBodyText}>
            {text.trimStart()}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * A tool step in the live stream. While running it follows the tool's output
 * in real time (auto-scrolled); once finished it collapses to a quiet,
 * re-expandable row, matching the persisted timeline.
 */
export function StreamingToolStep({ tool }: { tool: StreamTool }) {
  const [open, handlers] = useDisclosure(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = !tool.done;
  const isError = tool.isError === true;
  const hasOutput = Boolean(tool.output);
  const showBody = running ? hasOutput : open && hasOutput;
  const expandable = !running && hasOutput;

  useEffect(() => {
    if (running && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [tool.output, running]);

  const icon = running ? (
    <Loader size={11} color="gray" />
  ) : isError ? (
    <IconAlertTriangle size={14} stroke={1.7} />
  ) : (
    <IconCheck size={14} stroke={2} />
  );
  const detail = toolDetail(tool.name, tool.args);
  const label = toolLabel(tool.name, tool.label);
  const header = (
    <>
      <span className={isError ? classes.stepIconError : classes.stepIcon}>
        {icon}
      </span>
      <span className={classes.stepLabel}>{label}</span>
      {detail ? <span className={classes.stepDetail}>{detail}</span> : null}
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );

  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      {showBody ? (
        <Box className={classes.stepBody}>
          <Box ref={bodyRef} className={classes.stepBodyCode}>
            {tool.output}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
