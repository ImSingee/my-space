import { Box, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronDown, IconSparkles } from '@tabler/icons-react';
import { Fragment, useMemo } from 'react';
import classes from './chat.module.css';

export type ModelGroup = {
  group: string;
  items: { value: string; label: string }[];
};

/**
 * Compact model switcher styled as a pill, opening a grouped menu. Lives inside
 * the composer action bar (LobeHub "modelLabel" pattern) so model selection sits
 * next to the send button instead of floating elsewhere.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  disabled = false,
}: {
  groups: ModelGroup[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selectedLabel = useMemo(() => {
    for (const g of groups) {
      for (const it of g.items) if (it.value === value) return it.label;
    }
    return null;
  }, [groups, value]);

  const empty = groups.length === 0;
  const blocked = disabled || empty;

  return (
    <Menu
      position="top-end"
      shadow="md"
      width={240}
      withArrow
      disabled={blocked}
    >
      <Menu.Target>
        <UnstyledButton
          type="button"
          className={classes.modelPill}
          disabled={blocked}
          data-disabled={blocked || undefined}
        >
          <IconSparkles
            size={14}
            stroke={1.6}
            className={classes.modelPillIcon}
          />
          <Text component="span" className={classes.modelPillLabel}>
            {selectedLabel ?? (empty ? 'No models' : 'Select model')}
          </Text>
          <IconChevronDown
            size={14}
            stroke={1.8}
            className={classes.modelPillIcon}
          />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Box className={classes.modelMenuScroll}>
          {groups.map((g) => (
            <Fragment key={g.group}>
              <Menu.Label>{g.group}</Menu.Label>
              {g.items.map((it) => (
                <Menu.Item
                  key={it.value}
                  onClick={() => onChange(it.value)}
                  rightSection={
                    it.value === value ? (
                      <IconCheck size={15} stroke={2} />
                    ) : null
                  }
                >
                  {it.label}
                </Menu.Item>
              ))}
            </Fragment>
          ))}
        </Box>
      </Menu.Dropdown>
    </Menu>
  );
}
