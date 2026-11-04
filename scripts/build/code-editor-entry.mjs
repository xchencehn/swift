import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  highlightActiveLine,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
  redo,
} from '@codemirror/commands';
import {
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  HighlightStyle,
  LanguageDescription,
  indentUnit,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, closeSearchPanel } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

const colors = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.comment], color: 'var(--syn-comment)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--syn-function)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-type)' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: 'var(--syn-variable)' },
  { tag: [tags.meta, tags.processingInstruction, tags.link, tags.url], color: 'var(--syn-meta)' },
  { tag: tags.heading, color: 'var(--text)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]);
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--syn-text)',
    backgroundColor: 'var(--bg)',
    fontSize: 'calc(13px * var(--device-font-scale, 1))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    lineHeight: '1.7',
    overflow: 'auto',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '18px 0 40px', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 24px 0 12px' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--muted)',
    border: 'none',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', padding: '0 6px 0 14px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--panel)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--control)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--control)', outline: '1px solid var(--line)' },
  '.cm-panels': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    borderColor: 'var(--line)',
  },
  '.cm-search': { padding: '8px 12px', fontFamily: 'inherit' },
  '.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginInlineEnd: '8px',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    padding: '4px 6px',
  },
  '.cm-button': {
    background: 'var(--control)',
    color: 'var(--text)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
  },
});
const phrases = {
  Find: '查找',
  Replace: '替换',
  next: '下一处',
  previous: '上一处',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则表达式',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'No matches found': '没有匹配项',
  'Go to line': '转到行',
};

export function create({
  parent,
  text,
  file,
  size = text.length,
  readOnly = true,
  onChange,
  onSave,
}) {
  const editable = new Compartment(),
    language = new Compartment();
  let baseline = null,
    destroyed = false,
    generation = 0;
  const editing = (value) => [EditorState.readOnly.of(value), EditorView.editable.of(!value)];
  const line = text.split('\n').find((value) => /^\s+\S/.test(value));
  const indentation = line?.match(/^\s+/)?.[0];
  const unit = indentation?.includes('\t')
    ? '\t'
    : ' '.repeat(Math.min(8, indentation?.length || 2));
  function report(view) {
    const position = view.state.selection.main.head,
      current = view.state.doc.lineAt(position);
    onChange?.({
      dirty: !view.state.doc.eq(baseline),
      generation,
      line: current.number,
      column: position - current.from + 1,
      length: view.state.doc.length,
    });
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        highlightActiveLine(),
        syntaxHighlighting(colors),
        theme,
        EditorState.tabSize.of(unit === '\t' ? 4 : unit.length),
        indentUnit.of(unit),
        EditorState.phrases.of(phrases),
        EditorView.contentAttributes.of({
          'aria-label': `编辑 ${file.split('/').pop()}`,
          tabindex: '0',
          spellcheck: 'false',
          autocapitalize: 'off',
        }),
        editable.of(editing(readOnly)),
        language.of([]),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSave?.();
              return true;
            },
          },
          { key: 'Mod-Shift-z', run: redo, preventDefault: true },
          {
            key: 'Escape',
            run: closeSearchPanel,
            scope: 'editor search-panel',
            stopPropagation: true,
          },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) generation++;
          if (baseline && (update.docChanged || update.selectionSet)) report(update.view);
        }),
      ],
    }),
  });
  baseline = view.state.doc;
  const description = LanguageDescription.matchFilename(languages, file);
  if (description && size <= 1024 * 1024)
    description
      .load()
      .then((support) => {
        if (!destroyed) {
          view.dispatch({ effects: language.reconfigure(support) });
          view.dom.dataset.language = description.name;
        }
      })
      .catch(() => {
        /* Plain text remains editable when a language bundle cannot be loaded. */
      });
  const editor = {
    element: view.dom,
    content: view.contentDOM,
    getText: () => view.state.doc.toString(),
    isDirty: () => !view.state.doc.eq(baseline),
    get generation() {
      return generation;
    },
    setReadOnly(value) {
      view.dispatch({ effects: editable.reconfigure(editing(value)) });
    },
    snapshot() {
      view.dispatch({ annotations: isolateHistory.of('full') });
      return view.state.doc;
    },
    markSaved(saved = view.state.doc) {
      baseline = saved;
      report(view);
    },
    reset() {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: baseline },
        selection: { anchor: 0 },
      });
    },
    focus() {
      view.focus();
    },
    measure() {
      view.requestMeasure();
    },
    scrollToLine(number) {
      view.dispatch({
        effects: EditorView.scrollIntoView(
          view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, number))).from,
          { y: 'start' },
        ),
      });
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
  // The handle is attached to this file's DOM, so isolated UI tests can inspect the actual editor state.
  view.dom.studioEditor = editor;
  report(view);
  return editor;
}
