import { Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { shift } from '@floating-ui/dom';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extension-placeholder';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  MAX_COMPOSER_APP_PARTS,
  type ComposerInputPart,
} from '~agent/composer-content';
import { AppGlyph } from '~components/apps/app-glyph';
import type { AppListItem } from '~server/apps';
import {
  plainTextComposerDocument,
  serializeComposerDocument,
} from './composer-editor-content';
import classes from './chat.module.css';

type MentionAttributes = { id: string; label: string; slug: string };

const appMentionSuggestionKey = new PluginKey('appMentionSuggestion');

const AppMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      slug: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-slug'),
        renderHTML: (attributes) =>
          attributes.slug ? { 'data-slug': attributes.slug } : {},
      },
    };
  },
});

type AppSourceState = {
  loading: boolean;
  error: boolean;
};

type AppMentionMenuProps = SuggestionProps<AppListItem, MentionAttributes> & {
  sourceState: AppSourceState;
  listboxId: string;
  onActiveOptionChange: (optionId: string | undefined) => void;
};

type AppMentionMenuHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

function appOptionId(listboxId: string, appId: string): string {
  return `${listboxId}-option-${appId}`;
}

/* eslint-disable jsx-a11y/prefer-tag-over-role -- ARIA listbox semantics are
   required for this custom cursor-anchored popup; native select/option cannot
   keep focus and selection inside the rich-text editor. */
const AppMentionMenu = forwardRef<AppMentionMenuHandle, AppMentionMenuProps>(
  function AppMentionMenu(
    { items, command, sourceState, listboxId, onActiveOptionChange },
    reference,
  ) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const activeIndex =
      items.length > 0 ? Math.min(selectedIndex, items.length - 1) : -1;
    const activeApp = items[activeIndex];
    const activeOptionId = activeApp
      ? appOptionId(listboxId, activeApp.id)
      : undefined;

    useEffect(() => setSelectedIndex(0), [items]);
    useEffect(() => {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);
    useEffect(() => {
      onActiveOptionChange(activeOptionId);
    }, [activeOptionId, onActiveOptionChange]);

    const select = useCallback(
      (index: number) => {
        const app = items[index];
        if (app) command({ id: app.id, label: app.name, slug: app.slug });
      },
      [command, items],
    );

    useImperativeHandle(
      reference,
      () => ({
        onKeyDown(event) {
          if (event.isComposing || event.keyCode === 229) return false;
          if (items.length === 0) return false;
          if (event.key === 'ArrowUp') {
            setSelectedIndex(
              (index) => (index + items.length - 1) % items.length,
            );
            return true;
          }
          if (event.key === 'ArrowDown') {
            setSelectedIndex((index) => (index + 1) % items.length);
            return true;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            select(activeIndex);
            return true;
          }
          return false;
        },
      }),
      [activeIndex, items, select],
    );

    let emptyMessage = 'No matching apps';
    if (sourceState.loading) emptyMessage = 'Loading apps…';
    else if (sourceState.error) emptyMessage = 'Could not load apps';
    else if (items.length === 0) emptyMessage = 'No matching apps';

    return (
      <Paper
        id={listboxId}
        withBorder
        shadow="md"
        radius="md"
        p={4}
        className={classes.mentionMenu}
        role="listbox"
        aria-label="Apps"
      >
        {items.length > 0 ? (
          <Stack gap={2} className={classes.mentionMenuItems}>
            {items.map((app, index) => (
              <UnstyledButton
                key={app.id}
                id={appOptionId(listboxId, app.id)}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                className={classes.mentionMenuItem}
                data-selected={index === activeIndex || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => select(index)}
              >
                <Group gap="sm" wrap="nowrap">
                  <AppGlyph name={app.name} seed={app.id} size="sm" />
                  <div className={classes.mentionMenuIdentity}>
                    <Text size="sm" fw={500} truncate>
                      {app.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      /{app.slug}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        ) : (
          <Text component="output" size="sm" c="dimmed" px="sm" py="xs">
            {emptyMessage}
          </Text>
        )}
      </Paper>
    );
  },
);
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

function filterApps(apps: AppListItem[] | undefined, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return (apps ?? []).slice(0, 10);
  return (apps ?? [])
    .filter(
      (app) =>
        app.name.toLocaleLowerCase().includes(needle) ||
        app.slug.toLocaleLowerCase().includes(needle),
    )
    .slice(0, 10);
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    apps?: AppListItem[];
    appsLoading?: boolean;
    appsError?: boolean;
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
  const listboxId = `${editorId}-app-mentions`;
  const appsRef = useRef(apps);
  const sourceStateRef = useRef<AppSourceState>({
    loading: appsLoading,
    error: appsError,
  });
  const onChangeRef = useRef(onChange);
  const onMentionLookupPendingChangeRef = useRef(onMentionLookupPendingChange);
  const onSubmitRef = useRef(onSubmit);
  const onPasteFilesRef = useRef(onPasteFiles);
  const revisionRef = useRef(0);
  const menuOpenRef = useRef(false);
  const menuHasItemsRef = useRef(false);
  const menuRendererRef = useRef<ReactRenderer<
    AppMentionMenuHandle,
    AppMentionMenuProps
  > | null>(null);
  const suggestionPropsRef = useRef<SuggestionProps<
    AppListItem,
    MentionAttributes
  > | null>(null);

  appsRef.current = apps;
  sourceStateRef.current = { loading: appsLoading, error: appsError };
  onChangeRef.current = onChange;
  onMentionLookupPendingChangeRef.current = onMentionLookupPendingChange;
  onSubmitRef.current = onSubmit;
  onPasteFilesRef.current = onPasteFiles;

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
      AppMention.configure({
        HTMLAttributes: { class: classes.composerMention },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        renderHTML: ({ node, options }) => [
          'span',
          options.HTMLAttributes,
          `@${node.attrs.label ?? node.attrs.id}`,
        ],
        suggestion: {
          char: '@',
          pluginKey: appMentionSuggestionKey,
          allowSpaces: true,
          placement: 'top-start',
          offset: { mainAxis: 8 },
          floatingUi: { middleware: [shift({ padding: 12 })] },
          items: ({ query }) => filterApps(appsRef.current, query),
          allow: ({ state, range }) => {
            let mentions = 0;
            state.doc.descendants((node) => {
              if (node.type.name === 'mention') mentions += 1;
            });
            const mentionType = state.schema.nodes.mention;
            return (
              mentions < MAX_COMPOSER_APP_PARTS &&
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
            const menuProps = (
              props: SuggestionProps<AppListItem, MentionAttributes>,
            ): AppMentionMenuProps => ({
              ...props,
              sourceState: sourceStateRef.current,
              listboxId,
              onActiveOptionChange,
            });
            return {
              onStart(props) {
                menuOpenRef.current = true;
                menuHasItemsRef.current = props.items.length > 0;
                onMentionLookupPendingChangeRef.current(
                  sourceStateRef.current.loading,
                );
                editorElement = props.editor.view.dom;
                editorElement.setAttribute('aria-expanded', 'true');
                editorElement.setAttribute('aria-controls', listboxId);
                editorElement.removeAttribute('aria-activedescendant');
                suggestionPropsRef.current = props;
                const renderer = new ReactRenderer<
                  AppMentionMenuHandle,
                  AppMentionMenuProps
                >(AppMentionMenu, {
                  editor: props.editor,
                  props: menuProps(props),
                  className: classes.mentionMenuPortal,
                });
                menuRendererRef.current = renderer;
                unmount = props.mount(renderer.element);
              },
              onUpdate(props) {
                menuHasItemsRef.current = props.items.length > 0;
                onMentionLookupPendingChangeRef.current(
                  sourceStateRef.current.loading,
                );
                suggestionPropsRef.current = props;
                menuRendererRef.current?.updateProps(menuProps(props));
              },
              onKeyDown({ view, event }) {
                if (event.key === 'Tab') {
                  exitSuggestion(view, appMentionSuggestionKey);
                  return false;
                }
                return menuRendererRef.current?.ref?.onKeyDown(event) ?? false;
              },
              onExit() {
                menuOpenRef.current = false;
                menuHasItemsRef.current = false;
                onMentionLookupPendingChangeRef.current(false);
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
    [listboxId, placeholder],
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
          onSubmitRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        event.preventDefault();
        onPasteFilesRef.current(files);
        return true;
      },
    },
    onBlur: ({ editor: blurredEditor }) => {
      if (menuOpenRef.current) {
        exitSuggestion(blurredEditor.view, appMentionSuggestionKey);
      }
    },
    onUpdate: ({ editor: updatedEditor, transaction }) => {
      // Draft revisions track document edits. Tiptap also emits `update` when
      // editability changes, but that synthetic transaction has no doc change.
      if (!transaction.docChanged) return;
      revisionRef.current += 1;
      onChangeRef.current(serializeComposerDocument(updatedEditor.getJSON()));
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
    onMentionLookupPendingChangeRef.current(appsLoading);
    const items = filterApps(apps, props.query);
    menuHasItemsRef.current = items.length > 0;
    menuRendererRef.current.updateProps({
      ...props,
      items,
      sourceState: sourceStateRef.current,
    });
  }, [apps, appsError, appsLoading]);

  useImperativeHandle(
    reference,
    () => ({
      getSnapshot: () => ({
        content: editor ? serializeComposerDocument(editor.getJSON()) : [],
        revision: revisionRef.current,
        mentionLookupPending:
          menuOpenRef.current && sourceStateRef.current.loading,
      }),
      clearIfRevision: (revision) => {
        if (revisionRef.current === revision) editor?.commands.clearContent();
      },
    }),
    [editor],
  );

  return <EditorContent editor={editor} className={classes.composerEditor} />;
});
