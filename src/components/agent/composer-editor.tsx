import { Group, Paper, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { shift } from '@floating-ui/dom';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extension-placeholder';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import {
  IconApps,
  IconChevronLeft,
  IconChevronRight,
  IconRepeat,
} from '@tabler/icons-react';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  MAX_COMPOSER_REFERENCE_PARTS,
  type ComposerInputPart,
} from '~agent/composer-content';
import { AppGlyph } from '~components/apps/app-glyph';
import { useEventCallback } from '~hooks/use-latest-committed';
import type { AppListItem } from '~server/apps';
import type { WorkflowListItem } from '~server/workflows';
import {
  plainTextComposerDocument,
  serializeComposerDocument,
} from './composer-editor-content';
import classes from './chat.module.css';

type ResourceType = 'app' | 'workflow';
type MentionAttributes = {
  id: string;
  label: string;
  resourceType: ResourceType;
  slug?: string | null;
};

const resourceMentionSuggestionKey = new PluginKey('resourceMentionSuggestion');

const ResourceMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      resourceType: {
        default: 'app',
        parseHTML: (element) =>
          element.getAttribute('data-resource-type') ?? 'app',
        renderHTML: (attributes) => ({
          'data-resource-type': attributes.resourceType ?? 'app',
        }),
      },
      slug: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-slug'),
        renderHTML: (attributes) =>
          attributes.slug ? { 'data-slug': attributes.slug } : {},
      },
    };
  },
});

type MentionSource<T> = {
  items: T[];
  loading: boolean;
  error: boolean;
};

type MentionSources = {
  apps: MentionSource<AppListItem>;
  workflows: MentionSource<WorkflowListItem>;
};

type CategoryMentionItem = {
  kind: 'category';
  resourceType: ResourceType;
  count: number;
};

type ResourceMentionItem =
  | { kind: 'resource'; resourceType: 'app'; resource: AppListItem }
  | {
      kind: 'resource';
      resourceType: 'workflow';
      resource: WorkflowListItem;
    };

type MentionItem = CategoryMentionItem | ResourceMentionItem;

type ResourceMentionMenuProps = SuggestionProps<
  MentionItem,
  MentionAttributes
> & {
  sources: MentionSources;
  listboxId: string;
  onActiveOptionChange: (optionId: string | undefined) => void;
  onNavigableItemsChange: (hasItems: boolean) => void;
};

type ResourceMentionMenuHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

function mentionItemKey(item: MentionItem): string {
  return item.kind === 'category'
    ? `category-${item.resourceType}`
    : `${item.resourceType}-${item.resource.id}`;
}

function mentionOptionId(listboxId: string, item: MentionItem): string {
  return `${listboxId}-option-${mentionItemKey(item).replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function resourceItems(
  sources: MentionSources,
  resourceType: ResourceType,
): ResourceMentionItem[] {
  return resourceType === 'app'
    ? sources.apps.items.map((resource) => ({
        kind: 'resource' as const,
        resourceType: 'app' as const,
        resource,
      }))
    : sources.workflows.items.map((resource) => ({
        kind: 'resource' as const,
        resourceType: 'workflow' as const,
        resource,
      }));
}

function mentionItems(sources: MentionSources, query: string): MentionItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    const categories: CategoryMentionItem[] = [];
    if (sources.apps.items.length > 0) {
      categories.push({
        kind: 'category',
        resourceType: 'app',
        count: sources.apps.items.length,
      });
    }
    if (sources.workflows.items.length > 0) {
      categories.push({
        kind: 'category',
        resourceType: 'workflow',
        count: sources.workflows.items.length,
      });
    }
    return categories;
  }

  const apps = sources.apps.items
    .filter((resource) =>
      [resource.name, resource.slug].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    )
    .map((resource) => ({
      kind: 'resource' as const,
      resourceType: 'app' as const,
      resource,
    }));
  const workflows = sources.workflows.items
    .filter((resource) =>
      [resource.name, resource.slug].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    )
    .map((resource) => ({
      kind: 'resource' as const,
      resourceType: 'workflow' as const,
      resource,
    }));
  return [...apps, ...workflows];
}

function sourceStatus(
  sources: MentionSources,
  resourceType: ResourceType,
): string | null {
  const source = resourceType === 'app' ? sources.apps : sources.workflows;
  const label = resourceType === 'app' ? 'Apps' : 'Workflows';
  if (source.loading) return `Loading ${label}…`;
  if (source.error) return `Could not load ${label}`;
  return null;
}

function mentionSourcesLoading(sources: MentionSources): boolean {
  return sources.apps.loading || sources.workflows.loading;
}

function resourceLabel(resourceType: ResourceType): string {
  return resourceType === 'app' ? 'Apps' : 'Workflows';
}

/* eslint-disable jsx-a11y/prefer-tag-over-role -- ARIA listbox semantics are
   required for this custom cursor-anchored popup; native select/option cannot
   keep focus and selection inside the rich-text editor. */
const ResourceMentionMenu = forwardRef<
  ResourceMentionMenuHandle,
  ResourceMentionMenuProps
>(function ResourceMentionMenu(
  {
    items,
    command,
    query,
    sources,
    listboxId,
    onActiveOptionChange,
    onNavigableItemsChange,
  },
  reference,
) {
  const [scope, setScope] = useState<ResourceType | null>(null);
  const hasQuery = query.trim().length > 0;
  const activeScope = hasQuery ? null : scope;
  const visibleItems = activeScope
    ? resourceItems(sources, activeScope)
    : items;
  const backOptionOffset = activeScope ? 1 : 0;
  const navigationLength = visibleItems.length + backOptionOffset;
  const backOptionId = `${listboxId}-option-back`;
  const selectionKey = JSON.stringify([
    activeScope,
    query,
    visibleItems.map(mentionItemKey),
  ]);
  const [selection, setSelection] = useState({
    key: selectionKey,
    index: 0,
  });
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  let currentSelection = selection;
  if (selection.key !== selectionKey) {
    currentSelection = {
      key: selectionKey,
      index: activeScope && visibleItems.length > 0 ? 1 : 0,
    };
    setSelection(currentSelection);
  }
  const selectedIndex = currentSelection.index;
  const activeIndex =
    navigationLength > 0 ? Math.min(selectedIndex, navigationLength - 1) : -1;
  const activeItemIndex = activeIndex - backOptionOffset;
  const activeItem =
    activeItemIndex >= 0 ? visibleItems[activeItemIndex] : undefined;
  const activeOptionId =
    activeScope && activeIndex === 0
      ? backOptionId
      : activeItem
        ? mentionOptionId(listboxId, activeItem)
        : undefined;

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  useEffect(() => {
    onActiveOptionChange(activeOptionId);
  }, [activeOptionId, onActiveOptionChange]);
  useEffect(() => {
    onNavigableItemsChange(navigationLength > 0);
  }, [navigationLength, onNavigableItemsChange]);

  const select = (index: number) => {
    if (activeScope && index === 0) {
      setScope(null);
      return;
    }
    const item = visibleItems[index - backOptionOffset];
    if (!item) return;
    if (item.kind === 'category') {
      setScope(item.resourceType);
      return;
    }
    if (item.resourceType === 'app') {
      command({
        id: item.resource.id,
        label: item.resource.name,
        resourceType: 'app',
        slug: item.resource.slug,
      });
      return;
    }
    command({
      id: item.resource.id,
      label: item.resource.name,
      resourceType: 'workflow',
    });
  };

  useImperativeHandle(reference, () => ({
    onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229) return false;
      if (navigationLength === 0) return false;
      if (event.key === 'ArrowUp') {
        setSelection({
          key: selectionKey,
          index: (activeIndex + navigationLength - 1) % navigationLength,
        });
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelection({
          key: selectionKey,
          index: (activeIndex + 1) % navigationLength,
        });
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        select(activeIndex);
        return true;
      }
      return false;
    },
  }));

  const visibleSourceTypes: ResourceType[] = activeScope
    ? [activeScope]
    : ['app', 'workflow'];
  const statuses = visibleSourceTypes.flatMap((resourceType) => {
    const status = sourceStatus(sources, resourceType);
    return status ? [{ resourceType, status }] : [];
  });
  let emptyMessage: string | null = null;
  if (visibleItems.length === 0 && statuses.length === 0) {
    if (activeScope) {
      emptyMessage = `No ${resourceLabel(activeScope)} yet`;
    } else if (hasQuery) {
      emptyMessage = 'No matching Apps or Workflows';
    } else {
      emptyMessage = 'No Apps or Workflows yet';
    }
  }
  const groupedSearch = hasQuery && !activeScope;

  return (
    <Paper
      id={listboxId}
      withBorder
      radius="md"
      p={4}
      className={classes.mentionMenu}
      role="listbox"
      aria-label="Apps and Workflows"
    >
      {activeScope ? (
        <div className={classes.mentionMenuHeader}>
          <UnstyledButton
            id={backOptionId}
            ref={(element) => {
              optionRefs.current[0] = element;
            }}
            type="button"
            role="option"
            aria-label="Back to Apps and Workflows"
            aria-selected={activeIndex === 0}
            tabIndex={-1}
            className={classes.mentionMenuBack}
            data-selected={activeIndex === 0 || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (activeIndex !== 0) {
                setSelection({ key: selectionKey, index: 0 });
              }
            }}
            onClick={() => select(0)}
          >
            <IconChevronLeft size={16} stroke={1.8} />
            <Text size="sm" fw={600}>
              {resourceLabel(activeScope)}
            </Text>
          </UnstyledButton>
        </div>
      ) : null}
      {visibleItems.length > 0 ? (
        <div className={classes.mentionMenuItems}>
          {visibleItems.map((item, index) => {
            const navigationIndex = index + backOptionOffset;
            const previous = visibleItems[index - 1];
            const showGroup =
              groupedSearch &&
              item.kind === 'resource' &&
              (previous?.kind !== 'resource' ||
                previous.resourceType !== item.resourceType);
            return (
              <div key={mentionItemKey(item)}>
                {showGroup && item.kind === 'resource' ? (
                  <Text
                    size="xs"
                    c="dimmed"
                    fw={600}
                    className={classes.mentionMenuSection}
                  >
                    {resourceLabel(item.resourceType)}
                  </Text>
                ) : null}
                <UnstyledButton
                  id={mentionOptionId(listboxId, item)}
                  ref={(element) => {
                    optionRefs.current[navigationIndex] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={navigationIndex === activeIndex}
                  tabIndex={-1}
                  className={classes.mentionMenuItem}
                  data-selected={navigationIndex === activeIndex || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (activeIndex !== navigationIndex) {
                      setSelection({
                        key: selectionKey,
                        index: navigationIndex,
                      });
                    }
                  }}
                  onClick={() => select(navigationIndex)}
                >
                  <Group gap="sm" wrap="nowrap">
                    {item.kind === 'category' ? (
                      <ThemeIcon
                        size={30}
                        radius="sm"
                        variant="light"
                        color={item.resourceType === 'app' ? 'ember' : 'blue'}
                      >
                        {item.resourceType === 'app' ? (
                          <IconApps size={17} stroke={1.7} />
                        ) : (
                          <IconRepeat size={17} stroke={1.7} />
                        )}
                      </ThemeIcon>
                    ) : (
                      <AppGlyph
                        name={item.resource.name}
                        seed={item.resource.id}
                        size="sm"
                      />
                    )}
                    <div className={classes.mentionMenuIdentity}>
                      <Text size="sm" fw={500} truncate>
                        {item.kind === 'category'
                          ? resourceLabel(item.resourceType)
                          : item.resource.name}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {item.kind === 'category'
                          ? item.resourceType === 'app'
                            ? 'Browse every app'
                            : 'Browse every workflow'
                          : item.resourceType === 'app'
                            ? `/${item.resource.slug}`
                            : (item.resource.description ?? item.resource.id)}
                      </Text>
                    </div>
                    {item.kind === 'category' ? (
                      <>
                        <Text
                          size="xs"
                          c="dimmed"
                          className={classes.mentionMenuCategoryCount}
                        >
                          {item.count}
                        </Text>
                        <IconChevronRight
                          size={16}
                          stroke={1.8}
                          className={classes.mentionMenuChevron}
                        />
                      </>
                    ) : null}
                  </Group>
                </UnstyledButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {statuses.length > 0 ? (
        <div className={classes.mentionMenuStatuses} aria-live="polite">
          {statuses.map(({ resourceType, status }) => (
            <Text key={resourceType} size="sm" c="dimmed" px="sm" py={6}>
              {status}
            </Text>
          ))}
        </div>
      ) : null}
      {emptyMessage ? (
        <Text component="output" size="sm" c="dimmed" px="sm" py="xs">
          {emptyMessage}
        </Text>
      ) : null}
    </Paper>
  );
});
/* eslint-enable jsx-a11y/prefer-tag-over-role */

export type ComposerEditorSnapshot = {
  content: ComposerInputPart[];
  revision: number;
  mentionLookupPending: boolean;
};

export type ComposerEditorHandle = {
  getSnapshot: () => ComposerEditorSnapshot;
  clearIfRevision: (revision: number) => void;
};

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    apps?: AppListItem[];
    appsLoading?: boolean;
    appsError?: boolean;
    workflows?: WorkflowListItem[];
    workflowsLoading?: boolean;
    workflowsError?: boolean;
    disabled: boolean;
    focusOnMount: boolean;
    placeholder: string;
    seedText?: string;
    seedNonce?: number;
    onChange: (content: ComposerInputPart[]) => void;
    onMentionLookupPendingChange: (pending: boolean) => void;
    onSubmit: () => void;
    onPasteFiles: (files: File[]) => void;
  }
>(function ComposerEditor(
  {
    apps,
    appsLoading = false,
    appsError = false,
    workflows,
    workflowsLoading = false,
    workflowsError = false,
    disabled,
    focusOnMount,
    placeholder,
    seedText,
    seedNonce,
    onChange,
    onMentionLookupPendingChange,
    onSubmit,
    onPasteFiles,
  },
  reference,
) {
  const editorId = useId();
  const listboxId = `${editorId}-resource-mentions`;
  const getSources = useEventCallback((): MentionSources => ({
    apps: {
      items: apps ?? [],
      loading: appsLoading,
      error: appsError,
    },
    workflows: {
      items: workflows ?? [],
      loading: workflowsLoading,
      error: workflowsError,
    },
  }));
  const emitChange = useEventCallback(onChange);
  const emitMentionLookupPendingChange = useEventCallback(
    onMentionLookupPendingChange,
  );
  const emitSubmit = useEventCallback(onSubmit);
  const emitPasteFiles = useEventCallback(onPasteFiles);
  const revisionRef = useRef(0);
  const menuOpenRef = useRef(false);
  const menuHasItemsRef = useRef(false);
  const menuRendererRef = useRef<ReactRenderer<
    ResourceMentionMenuHandle,
    ResourceMentionMenuProps
  > | null>(null);
  const suggestionPropsRef = useRef<SuggestionProps<
    MentionItem,
    MentionAttributes
  > | null>(null);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      Placeholder.configure({ placeholder }),
      ResourceMention.configure({
        HTMLAttributes: { class: classes.composerMention },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        renderHTML: ({ node, options }) => [
          'span',
          options.HTMLAttributes,
          `@${node.attrs.label ?? node.attrs.id}`,
        ],
        suggestion: {
          char: '@',
          pluginKey: resourceMentionSuggestionKey,
          allowSpaces: true,
          placement: 'top-start',
          offset: { mainAxis: 8 },
          floatingUi: { middleware: [shift({ padding: 12 })] },
          items: ({ query }) => mentionItems(getSources(), query),
          allow: ({ state, range }) => {
            let mentions = 0;
            state.doc.descendants((node) => {
              if (node.type.name === 'mention') mentions += 1;
            });
            const mentionType = state.schema.nodes.mention;
            return (
              mentions < MAX_COMPOSER_REFERENCE_PARTS &&
              Boolean(
                mentionType &&
                state.doc
                  .resolve(range.from)
                  .parent.type.contentMatch.matchType(mentionType),
              )
            );
          },
          render: () => {
            let unmount: (() => void) | undefined;
            let editorElement: HTMLElement | undefined;
            const onActiveOptionChange = (optionId: string | undefined) => {
              if (!editorElement) return;
              if (optionId) {
                editorElement.setAttribute('aria-activedescendant', optionId);
              } else {
                editorElement.removeAttribute('aria-activedescendant');
              }
            };
            const onNavigableItemsChange = (hasItems: boolean) => {
              menuHasItemsRef.current = hasItems;
            };
            const menuProps = (
              props: SuggestionProps<MentionItem, MentionAttributes>,
            ): ResourceMentionMenuProps => ({
              ...props,
              sources: getSources(),
              listboxId,
              onActiveOptionChange,
              onNavigableItemsChange,
            });
            return {
              onStart(props) {
                menuOpenRef.current = true;
                menuHasItemsRef.current = props.items.length > 0;
                emitMentionLookupPendingChange(
                  mentionSourcesLoading(getSources()),
                );
                editorElement = props.editor.view.dom;
                editorElement.setAttribute('aria-expanded', 'true');
                editorElement.setAttribute('aria-controls', listboxId);
                editorElement.removeAttribute('aria-activedescendant');
                suggestionPropsRef.current = props;
                const renderer = new ReactRenderer<
                  ResourceMentionMenuHandle,
                  ResourceMentionMenuProps
                >(ResourceMentionMenu, {
                  editor: props.editor,
                  props: menuProps(props),
                  className: classes.mentionMenuPortal,
                });
                menuRendererRef.current = renderer;
                unmount = props.mount(renderer.element);
              },
              onUpdate(props) {
                menuHasItemsRef.current = props.items.length > 0;
                emitMentionLookupPendingChange(
                  mentionSourcesLoading(getSources()),
                );
                suggestionPropsRef.current = props;
                menuRendererRef.current?.updateProps(menuProps(props));
              },
              onKeyDown({ view, event }) {
                if (event.key === 'Tab') {
                  exitSuggestion(view, resourceMentionSuggestionKey);
                  return false;
                }
                return menuRendererRef.current?.ref?.onKeyDown(event) ?? false;
              },
              onExit() {
                menuOpenRef.current = false;
                menuHasItemsRef.current = false;
                emitMentionLookupPendingChange(false);
                editorElement?.setAttribute('aria-expanded', 'false');
                editorElement?.removeAttribute('aria-controls');
                editorElement?.removeAttribute('aria-activedescendant');
                editorElement = undefined;
                suggestionPropsRef.current = null;
                unmount?.();
                menuRendererRef.current?.destroy();
                menuRendererRef.current = null;
                unmount = undefined;
              },
            };
          },
        },
      }),
    ],
    [emitMentionLookupPendingChange, getSources, listboxId, placeholder],
  );

  const editor = useEditor({
    extensions,
    content: plainTextComposerDocument(seedText ?? ''),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: classes.composerEditorContent,
        role: 'textbox',
        'aria-label': placeholder,
        'aria-multiline': 'true',
        'aria-autocomplete': 'list',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        placeholder,
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.isComposing &&
          event.keyCode !== 229
        ) {
          if (menuOpenRef.current && menuHasItemsRef.current) return false;
          event.preventDefault();
          emitSubmit();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        emitPasteFiles(files);
        return true;
      },
    },
    onBlur: ({ editor: blurredEditor }) => {
      if (menuOpenRef.current) {
        exitSuggestion(blurredEditor.view, resourceMentionSuggestionKey);
      }
    },
    onUpdate: ({ editor: updatedEditor, transaction }) => {
      // Draft revisions track document edits. Tiptap also emits `update` when
      // editability changes, but that synthetic transaction has no doc change.
      if (!transaction.docChanged) return;
      revisionRef.current += 1;
      emitChange(serializeComposerDocument(updatedEditor.getJSON()));
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || seedNonce === undefined) return;
    editor.commands.setContent(plainTextComposerDocument(seedText ?? ''));
    editor.commands.focus('end');
  }, [editor, seedNonce, seedText]);

  useEffect(() => {
    if (focusOnMount) editor?.commands.focus('end');
  }, [editor, focusOnMount]);

  useEffect(() => {
    const props = suggestionPropsRef.current;
    if (!props || !menuRendererRef.current) return;
    const sources = getSources();
    emitMentionLookupPendingChange(mentionSourcesLoading(sources));
    const items = mentionItems(sources, props.query);
    menuHasItemsRef.current = items.length > 0;
    const nextProps = {
      ...props,
      items,
    };
    suggestionPropsRef.current = nextProps;
    menuRendererRef.current.updateProps({
      ...nextProps,
      sources,
      listboxId,
      onActiveOptionChange: (optionId: string | undefined) => {
        const editorElement = props.editor.view.dom;
        if (optionId) {
          editorElement.setAttribute('aria-activedescendant', optionId);
        } else {
          editorElement.removeAttribute('aria-activedescendant');
        }
      },
      onNavigableItemsChange: (hasItems: boolean) => {
        menuHasItemsRef.current = hasItems;
      },
    });
  }, [
    apps,
    appsError,
    appsLoading,
    emitMentionLookupPendingChange,
    getSources,
    listboxId,
    workflows,
    workflowsError,
    workflowsLoading,
  ]);

  useImperativeHandle(
    reference,
    () => ({
      getSnapshot: () => ({
        content: editor ? serializeComposerDocument(editor.getJSON()) : [],
        revision: revisionRef.current,
        mentionLookupPending:
          menuOpenRef.current && mentionSourcesLoading(getSources()),
      }),
      clearIfRevision: (revision) => {
        if (revisionRef.current === revision) editor?.commands.clearContent();
      },
    }),
    [editor, getSources],
  );

  return <EditorContent editor={editor} className={classes.composerEditor} />;
});
