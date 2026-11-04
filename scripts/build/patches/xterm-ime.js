'use strict';
const crypto = require('node:crypto');
const ts = require('typescript');

// Local, build-time patch for @xterm/xterm 6.0.0. Keep the readable replacement
// methods here; never edit node_modules or patch private objects at runtime.
// Reconcile https://github.com/xtermjs/xterm.js/pull/6009 and /issues/6045 when
// upgrading. The hash deliberately rejects a different upstream implementation.
const upstreamSha256 = '14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972';

class BrowserInput {
  _inputEvent(ev) {
    const composition = this._compositionHelper;
    // The existing composition finalizer owns the committed text and any text
    // arriving before its timer runs. Do not emit that text through input too.
    if (ev.isComposing || composition.isComposing || composition.isSendingComposition) return false;
    if ((ev.composed && this._keyDownSeen) || this.optionsService.rawOptions.screenReaderMode || this._keyPressHandled) return false;
    let text;
    if (ev.inputType === 'insertText' && ev.data) text = ev.data;
    else if (ev.inputType === 'deleteContentBackward') text = '\x7f';
    else if (ev.inputType === 'deleteContentForward') text = '\x1b[3~';
    else if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') text = '\r';
    else return false;
    // input is authoritative when available. Cancel the legacy 229 textarea
    // fallback before it observes the same change and sends it a second time.
    composition.cancelTextareaChanges();
    this._unprocessedDeadKey = false;
    this.coreService.triggerDataEvent(text, true);
    this.cancel(ev);
    return true;
  }
}

class CompositionInput {
  get isSendingComposition() { return this._isSendingComposition; }

  cancelTextareaChanges() {
    clearTimeout(this._textareaChangeTimer);
    this._textareaChangeTimer = undefined;
    this._textareaBeforeChange = undefined;
  }

  _handleAnyTextareaChanges() {
    // Older IMEs may mutate textarea without an input event. Coalesce pending
    // checks around one baseline instead of scheduling overlapping differences.
    if (this._textareaChangeTimer !== undefined) return;
    this._textareaBeforeChange = this._textarea.value;
    this._textareaChangeTimer = setTimeout(() => this._flushTextareaChanges(), 0);
  }

  _flushTextareaChanges() {
    const oldValue = this._textareaBeforeChange;
    this.cancelTextareaChanges();
    if (oldValue === undefined || this._isComposing || this._isSendingComposition) return;
    const newValue = this._textarea.value;
    const diff = newValue.replace(oldValue, '');
    this._dataAlreadySent = diff;
    if (newValue.length > oldValue.length) this._coreService.triggerDataEvent(diff, true);
    else if (newValue.length < oldValue.length) {
      const count = Math.max(1, Array.from(oldValue).length - Array.from(newValue).length);
      this._coreService.triggerDataEvent('\x7f'.repeat(count), true);
    } else if (newValue !== oldValue) this._coreService.triggerDataEvent(newValue, true);
  }
}

function patchXterm(bytes) {
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== upstreamSha256)
    throw new Error('xterm upstream changed: reconcile scripts/patches/xterm-ime.js before generating terminal assets.');
  const source = bytes.toString();
  const tree = ts.createSourceFile('xterm.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const compositionMethods = Object.getOwnPropertyNames(CompositionInput.prototype).filter(name => name !== 'constructor')
    .map(name => { const d = Object.getOwnPropertyDescriptor(CompositionInput.prototype, name); return (d.value || d.get).toString(); }).join('\n');
  const replacements = new Map([
    ['createRow', require('./xterm-braille').patchBrailleRow],
    ['_inputEvent', () => BrowserInput.prototype._inputEvent.toString()],
    ['_handleAnyTextareaChanges', () => compositionMethods],
    ['_keyDown', original => {
      const from = 'if(!t&&!this._compositionHelper.keydown(e))return this.options.scrollOnUserInput';
      if (!original.includes(from)) throw new Error('xterm keydown implementation changed.');
      return original.replace(from, 'if(!t&&!this._compositionHelper.keydown(e))return this._keyDownSeen=!1,this.options.scrollOnUserInput');
    }],
    // Flush legacy text before starting a new composition or a regular key
    // (especially Enter, which clears textarea). input already cancels it.
    ['compositionstart', original => original.replace('{', '{this._flushTextareaChanges();')],
    ['keydown', original => original.replace('{', '{if(e.keyCode!==229)this._flushTextareaChanges();')],
  ]);
  const edits = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && replacements.has(node.name.getText(tree))) {
      const name = node.name.getText(tree), start = node.getStart(tree);
      edits.push({ name, start, end: node.end, text: replacements.get(name)(source.slice(start, node.end)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const name of replacements.keys()) if (edits.filter(edit => edit.name === name).length !== 1)
    throw new Error(`xterm patch requires exactly one ${name} method.`);
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return Buffer.from(output);
}
module.exports = { patchXterm, upstreamSha256 };
