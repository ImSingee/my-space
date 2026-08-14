import { ActionIcon, Menu } from '@mantine/core';
import {
  IconDots,
  IconFileText,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';

export function DashboardOptionsMenu({
  onEdit,
  onRename,
  onEditDescription,
  onDelete,
  deleteDisabled,
}: {
  onEdit: () => void;
  onRename: () => void;
  onEditDescription: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
}) {
  return (
    <Menu position="bottom-end" withArrow shadow="md" width={200}>
      <Menu.Target>
        <ActionIcon
          variant="default"
          size="input-sm"
          aria-label="Dashboard options"
        >
          <IconDots size={18} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.7} />}
          onClick={onEdit}
        >
          Edit dashboard
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPencil size={15} stroke={1.7} />}
          onClick={onRename}
        >
          Rename
        </Menu.Item>
        <Menu.Item
          leftSection={<IconFileText size={15} stroke={1.7} />}
          onClick={onEditDescription}
        >
          Edit description
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={15} stroke={1.7} />}
          disabled={deleteDisabled}
          onClick={onDelete}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
