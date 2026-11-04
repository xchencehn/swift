'use strict';
const fs = require('node:fs');
const { writePrivateJson } = require('../private-json');
class QuestionReceipts {
  constructor(file) {
    this.file = file;
    this.items = new Map();
    try {
      if (file && fs.existsSync(file))
        for (const item of JSON.parse(fs.readFileSync(file, 'utf8')).items || [])
          this.items.set(item.key, item);
    } catch {
      this.error = new Error('问题操作回执暂时无法读取，已停止重复投递。');
    }
  }
  get(key) {
    if (this.error) throw this.error;
    return key && this.items.get(key);
  }
  forQuestion(questionKey) {
    return [...this.items.values()].findLast(
      (item) => item.questionKey === questionKey && ['answer', 'skip'].includes(item.action),
    );
  }
  put(key, value) {
    if (!key) return;
    if (this.error) throw this.error;
    this.items.set(key, { key, ...value });
    while (this.items.size > 512) this.items.delete(this.items.keys().next().value);
    if (this.file) writePrivateJson(this.file, { version: 1, items: [...this.items.values()] });
  }
}
module.exports = { QuestionReceipts };
