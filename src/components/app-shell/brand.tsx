import { Text } from '@mantine/core';
import classes from './brand.module.css';

type BrandProps = {
  size?: 'sm' | 'md' | 'lg';
  withWordmark?: boolean;
};

const MARK_SIZE = { sm: 28, md: 32, lg: 44 } as const;
const BRAND_ICON_SRC = '/logo192.png?v=20260827';

export function Brand({ size = 'md', withWordmark = true }: BrandProps) {
  return (
    <div className={classes.root}>
      <div
        className={classes.mark}
        style={{ width: MARK_SIZE[size], height: MARK_SIZE[size] }}
      >
        <img
          className={classes.image}
          src={BRAND_ICON_SRC}
          alt=""
          draggable={false}
        />
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
