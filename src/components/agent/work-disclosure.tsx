import { Box, Collapse, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronRight, IconSparkles } from '@tabler/icons-react';
import { type ReactNode, useId } from 'react';
import classes from './chat.module.css';

/** A quiet, default-closed container for one finished Agent turn's process. */
export function WorkDisclosure({ children }: { children: ReactNode }) {
  const [open, handlers] = useDisclosure(false);
  const contentId = useId();

  return (
    <Box className={classes.workDisclosure}>
      <UnstyledButton
        type="button"
        className={classes.workDisclosureHeader}
        onClick={handlers.toggle}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span className={classes.stepIcon}>
          <IconSparkles size={13} stroke={1.6} aria-hidden />
        </span>
        <span className={classes.stepLabel}>
          {open ? 'Hide work' : 'Show work'}
        </span>
        <IconChevronRight
          size={14}
          aria-hidden
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      </UnstyledButton>
      <Collapse expanded={open}>
        <Box id={contentId} className={classes.workDisclosureBody}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
