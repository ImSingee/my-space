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
import { isFilePathDetails, isFilePathTool } from '~agent/file-path-details';
import { EditDiff } from './edit-diff';
import type { StreamTool } from './use-agent-stream';
import {
  listFilesPathArgument,
  type ToolDetail,
  type ToolInputDetail,
  toolArgumentsRecord,
  toolDetail,
  toolDisplayLabel,
  toolInputDetails,
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

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function legacyResultPath(name: string, details: unknown): string | undefined {
  const value = detailsRecord(details)?.path;
  if (typeof value !== 'string') return undefined;
  return value === '' && name === 'list_files' ? '.' : value || undefined;
}

function resolvedToolDetail(
  name: string,
  args: unknown,
  details: unknown,
  isError: boolean,
  fallback?: ToolDetail,
): ToolDetail | undefined {
  if (isFilePathTool(name) && isFilePathDetails(details)) {
    return { value: details.relativePath, ellipsis: 'start' };
  }
  if (!isError) {
    const legacyPath = legacyResultPath(name, details);
    if (legacyPath !== undefined) {
      return { value: legacyPath, ellipsis: 'start' };
    }
  }
  return fallback ?? toolDetail(name, args);
}

function resolvedToolInputs(
  name: string,
  args: unknown,
  result?: ToolResult,
): ToolInputDetail[] | undefined {
  const inputs = toolInputDetails(name, args) ?? [];
  if (!isFilePathTool(name)) {
    return inputs.length > 0 ? inputs : undefined;
  }
  const absolutePath = isFilePathDetails(result?.details)
    ? result.details.absolutePath
    : result?.isError === true
      ? undefined
      : legacyResultPath(name, result?.details);
  const argsRecord = toolArgumentsRecord(args);
  const attemptedPath =
    name === 'list_files'
      ? listFilesPathArgument(args)
      : typeof argsRecord?.path === 'string'
        ? argsRecord.path
        : undefined;
  const displayedPath = absolutePath ?? attemptedPath;
  if (displayedPath === undefined) {
    return inputs.length > 0 ? inputs : undefined;
  }

  const pathIndex = inputs.findIndex((input) => input.label === 'File path');
  if (pathIndex === -1) {
    return [{ label: 'File path', value: displayedPath }, ...inputs];
  }
  return inputs.map((input, index) =>
    index === pathIndex ? { ...input, value: displayedPath } : input,
  );
}

function outputPresentation(
  name: string,
  isError: boolean,
  args: unknown,
  result?: ToolResult,
): { label: string; emptyText: string } {
  if (isError) return { label: 'Error', emptyText: '(no error details)' };
  if (name === 'read_file') {
    const resultDetails = detailsRecord(result?.details);
    const offset = [
      resultDetails?.offset,
      toolArgumentsRecord(args)?.offset,
    ].find(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    );
    return {
      label: 'File contents',
      emptyText:
        offset && offset > 0
          ? `(no content at offset ${offset})`
          : '(empty file)',
    };
  }
  if (name === 'list_files') {
    return { label: 'Directory contents', emptyText: '(empty directory)' };
  }
  return { label: 'Output', emptyText: '(no output)' };
}

function hasCompleteWriteInput(name: string, args: unknown): boolean {
  const argsRecord = toolArgumentsRecord(args);
  return (
    name === 'write_file' &&
    typeof argsRecord?.path === 'string' &&
    typeof argsRecord.content === 'string'
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
  outputLabel,
  outputEmptyText,
}: {
  inputs?: ToolInputDetail[];
  output?: string;
  outputRef?: Ref<HTMLDivElement>;
  editDiff?: string;
  outputLabel: string;
  outputEmptyText: string;
}) {
  const hasInputs = (inputs?.length ?? 0) > 0;
  const hasOutput = output !== undefined || editDiff !== undefined;
  const showOutputSection = hasInputs || outputLabel !== 'Output';
  const outputNode = (
    <Box ref={outputRef} className={classes.stepBodyCode}>
      {output === '' ? outputEmptyText : output}
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
        showOutputSection ? (
          <ToolBodySection label={outputLabel}>{outputNode}</ToolBodySection>
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
  args?: unknown;
  detail?: ToolDetail;
  status: ToolStatus;
  result?: ToolResult;
}) {
  const isError = status === 'error' || result?.isError === true;
  const editDetails = successfulEditDetails(name, result);
  const inputs = resolvedToolInputs(name, args, result);
  const output = outputPresentation(name, isError, args, result);
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
      label={toolDisplayLabel(name, args)}
      detail={resolvedToolDetail(name, args, result?.details, isError, detail)}
      error={isError}
    >
      {inputs !== undefined || result ? (
        <ToolStepBody
          inputs={inputs}
          output={hideSuccessfulWriteOutput ? undefined : result?.text}
          editDiff={editDetails?.diff}
          outputLabel={output.label}
          outputEmptyText={output.emptyText}
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
  const outputPresentationDetails = outputPresentation(
    tool.name,
    isError,
    tool.args,
    result,
  );
  const hideSuccessfulWriteOutput =
    tool.done && !isError && hasCompleteWriteInput(tool.name, tool.args);
  const output = hideSuccessfulWriteOutput
    ? undefined
    : tool.output !== undefined
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
  const detail = resolvedToolDetail(
    tool.name,
    tool.args,
    tool.details,
    isError,
  );
  const label = toolDisplayLabel(tool.name, tool.args, tool.label);
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
            outputLabel={outputPresentationDetails.label}
            outputEmptyText={outputPresentationDetails.emptyText}
          />
        </Collapse>
      ) : null}
    </Box>
  );
}
