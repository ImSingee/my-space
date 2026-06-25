import { Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import classes from './brand.module.css';

type BrandProps = {
  size?: 'sm' | 'md' | 'lg';
  withWordmark?: boolean;
};

const MARK_SIZE = { sm: 28, md: 32, lg: 44 } as const;
const ICON_SIZE = { sm: 16, md: 19, lg: 26 } as const;

export function Brand({ size = 'md', withWordmark = true }: BrandProps) {
  return (
    <div className={classes.root}>
      <div
        className={classes.mark}
        style={{ width: MARK_SIZE[size], height: MARK_SIZE[size] }}
      >
        <IconSparkles size={ICON_SIZE[size]} stroke={1.9} />
      </div>
      {withWordmark ? (
        <Text
          component="span"
          className={classes.word}
          fz={size === 'lg' ? 24 : 18}
        >
          Hatch
        </Text>
      ) : null}
    </div>
  );
}
