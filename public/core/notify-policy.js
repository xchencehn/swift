// Adapted from devswha/herdr-web-ui 685293e0. Copyright (c) 2026 devswha.
// MIT; see public/vendor/herdr-web-ui/LICENSE.
(function (root) {
  'use strict';
  function shouldNotifyStatus(previous, next) {
    return previous !== undefined && previous !== next && ['blocked', 'done'].includes(next);
  }
  function alertStatus(status, waiting) {
    return waiting && !['working', 'blocked'].includes(status) ? 'working' : status;
  }
  function parseAlerts(value = {}) {
    return {
      input: typeof value.input === 'boolean' ? value.input : true,
      done: ['off', 'long', 'always'].includes(value.done) ? value.done : 'long',
    };
  }
  const api = { shouldNotifyStatus, alertStatus, parseAlerts };
  if (typeof module === 'object') module.exports = api;
  else root.StudioNotifyPolicy = api;
})(globalThis);
