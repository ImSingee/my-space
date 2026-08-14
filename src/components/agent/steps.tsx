/** Timeline step rows shared by the persisted transcript and the live stream. */
import { Box, Collapse, Loader, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconSparkles,
} from '@tabler/icons-react';
import { type ReactNode, type Ref, useEffect, useId, useRef } from 'react';
import { isEditFileDetails } from '~agent/edit-file-details';
import { isWriteFileDetails } from '~agent/write-file-details';
import { EditDiff } from './edit-diff';
import type { StreamTool } from './use-agent-stream';
import {
  type ToolDetail,
  type ToolInputDetail,
  toolDetail,
  toolInputDetails,
  toolLabel,
} from './types';
import classes from './chat.module.css';

export type ToolStatus = 'running' | 'done' | 'error';

type ToolResult = { text: string; details?: unknown; isError?: boolean };

function successfulEditDetails(name: string, result?: ToolResult) {
  return name === 'edit_file' &&
    result?.isError !== true &&
    isEditFileDetails(result?.details)
    ? result.details
    : undefined;
}

function successfulWriteDetails(name: string, result?: ToolResult) {
  return name === 'write_file' &&
    result?.isError !== true &&
    isWriteFileDetails(result?.details)
    ? result.details
    : undefined;
}

function resolvedToolInputs(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: ToolResult,
): ToolInputDetail[] | undefined {
  const inputs = toolInputDetails(name, args) ?? [];
  const canonicalPath =
    successfulEditDetails(name, result)?.path ??
    successfulWriteDetails(name, result)?.path;
  if (canonicalPath === undefined) {
    return inputs.length > 0 ? inputs : undefined;
  }

  const pathIndex = inputs.findIndex((input) => input.label === 'File path');
  if (pathIndex === -1) {
    return [{ label: 'File path', value: canonicalPath }, ...inputs];
  }
  return inputs.map((input, index) =>
    index === pathIndex ? { ...input, value: canonicalPath } : input,
  );
}

function hasCompleteWriteInput(
  name: string,
  args: Record<string, unknown> | undefined,
): boolean {
  return (
    name === 'write_file' &&
    typeof args?.path === 'string' &&
    typeof args.content === 'string'
  );
}

function StepDetailText({ detail }: { detail?: ToolDetail }) {
  if (!detail) return null;
  if (detail.ellipsis === 'start') {
    return (
      <span className={classes.stepDetailStart}>
        <bdi dir="ltr">{detail.value}</bdi>
      </span>
    );
  }
  return <span className={classes.stepDetail}>{detail.value}</span>;
}

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
  detail?: ToolDetail;
  error?: boolean;
  children?: ReactNode;
}) {
  const [open, handlers] = useDisclosure(false);
  const bodyId = useId();
  const expandable = Boolean(children);
  const inner = (
    <>
      <span className={error ? classes.stepIconError : classes.stepIcon}>
        {icon}
      </span>
      <span className={classes.stepLabel}>{label}</span>
      <StepDetailText detail={detail} />
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
          aria-controls={bodyId}
          aria-expanded={open}
          onClick={handlers.toggle}
        >
          {inner}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{inner}</Box>
      )}
      {expandable ? (
        <Collapse id={bodyId} expanded={open}>
          {children}
        </Collapse>
      ) : null}
    </Box>
  );
}

function ToolBodySection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      aria-label={label}
      className={classes.stepBodySection}
    >
      <Box className={classes.stepBodyLabel}>{label}</Box>
      {children}
    </Box>
  );
}

function ToolStepBody({
  inputs,
  output,
  outputRef,
  editDiff,
}: {
  inputs?: ToolInputDetail[];
  output?: string;
  outputRef?: Ref<HTMLDivElement>;
  editDiff?: string;
}) {
  const hasInputs = (inputs?.length ?? 0) > 0;
  const hasOutput = output !== undefined || editDiff !== undefined;
  const outputNode = (
    <Box ref={outputRef} className={classes.stepBodyCode}>
      {output || '(no output)'}
    </Box>
  );

  return (
    <Box className={classes.stepBody}>
      {inputs?.map((input) => (
        <ToolBodySection key={input.label} label={input.label}>
          <Box className={classes.stepInputCode}>
            {input.value === ''
              ? (input.emptyText ?? `(empty ${input.label.toLowerCase()})`)
              : input.value}
          </Box>
        </ToolBodySection>
      ))}
      {editDiff ? (
        hasInputs ? (
          <Box className={classes.stepBodySection}>
            <EditDiff diff={editDiff} />
          </Box>
        ) : (
          <EditDiff diff={editDiff} />
        )
      ) : hasOutput ? (
        hasInputs ? (
          <ToolBodySection label="Output">{outputNode}</ToolBodySection>
        ) : (
          outputNode
        )
      ) : null}
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
  args,
  detail,
  status,
  result,
}: {
  name: string;
  args?: Record<string, unknown>;
  detail?: ToolDetail;
  status: ToolStatus;
  result?: ToolResult;
}) {
  const isError = status === 'error' || result?.isError === true;
  const editDetails = successfulEditDetails(name, result);
  const inputs = resolvedToolInputs(name, args, result);
  const hideSuccessfulWriteOutput =
    status === 'done' &&
    result !== undefined &&
    !isError &&
    hasCompleteWriteInput(name, args);
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
      {inputs !== undefined || result ? (
        <ToolStepBody
          inputs={inputs}
          output={hideSuccessfulWriteOutput ? undefined : result?.text}
          editDiff={editDetails?.diff}
        />
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
  const bodyId = useId();

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
          aria-controls={bodyId}
          aria-expanded={open}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      <Collapse id={bodyId} expanded={showBody}>
        <Box className={classes.stepBody}>
          <Box ref={bodyRef} className={classes.stepBodyText}>
            {text.trimStart()}
          </Box>
        </Box>
      </Collapse>
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
  const bodyId = useId();
  const running = !tool.done;
  const isError = tool.isError === true;
  const result = {
    text: tool.output ?? '',
    details: tool.details,
    isError: tool.isError,
  };
  const editDetails = successfulEditDetails(tool.name, result);
  const inputs = resolvedToolInputs(tool.name, tool.args, result);
  const hideSuccessfulWriteOutput =
    tool.done && !isError && hasCompleteWriteInput(tool.name, tool.args);
  const output = hideSuccessfulWriteOutput
    ? undefined
    : tool.output
      ? tool.output
      : tool.done && tool.name === 'run_command' && inputs !== undefined
        ? ''
        : undefined;
  const hasBody =
    inputs !== undefined || output !== undefined || editDetails !== undefined;
  const showBody = running ? hasBody : open && hasBody;
  const expandable = !running && hasBody;

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
      <StepDetailText detail={detail} />
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
          aria-controls={bodyId}
          aria-expanded={open}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      {hasBody ? (
        <Collapse id={bodyId} expanded={showBody}>
          <ToolStepBody
            inputs={inputs}
            output={output}
            outputRef={bodyRef}
            editDiff={editDetails?.diff}
          />
        </Collapse>
      ) : null}
    </Box>
  );
}
