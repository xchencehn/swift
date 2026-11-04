'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { sourceFingerprint } = require('../lib/source-fingerprint');
const root = path.resolve(__dirname, '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (name) => [npm, ['run', name]];
const lanes = {
  readability: [[process.execPath, ['scripts/testing/readability-harness.js']]],
  'terminal-sync-output': [[process.execPath, ['scripts/testing/terminal-sync-output-harness.js']]],
  'terminal-background': [
    [process.execPath, ['scripts/testing/terminal-background-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'chat-highlighting': [
    ...['chatHighlighting', 'tools', 'compactToolSpacing', 'scrolling'].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  direct: [
    [process.execPath, ['scripts/testing/direct-connection-harness.js']],
    run('smoke:token:java'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'desktop-start': [[process.execPath, ['scripts/testing/desktop-start-harness.js']]],
  'desktop-startup': [[process.execPath, ['scripts/testing/windows-startup-harness.js']]],
  'windows-install': [[process.execPath, ['scripts/testing/windows-install-harness.js']]],
  'connection-lifecycle': [
    [process.execPath, ['scripts/testing/connection-lifecycle-harness.js']],
    [process.execPath, ['scripts/testing/cache-startup-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'cache-startup': [
    [process.execPath, ['scripts/testing/cache-startup-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'goal-command': [
    ...[
      'goal-command-harness',
      'goal-command-native-harness',
      'goal-actions-harness',
      'goal-actions-native-harness',
      'command-input-harness',
      'command-success-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=goalStatus']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'native-draft-feedback': [
    [process.execPath, ['scripts/testing/native-draft-feedback-harness.js']],
    [process.execPath, ['scripts/testing/native-draft-harness.js']],
    [process.execPath, ['scripts/testing/codex-rate-limit-harness.js']],
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=unifiedNotices']],
  ],
  'design-system': [
    [process.execPath, ['scripts/testing/design-system-harness.js']],
    [process.execPath, ['scripts/testing/design-motion-harness.js']],
    [process.execPath, ['scripts/testing/session-statusbar-harness.js']],
    [process.execPath, ['scripts/testing/chat-fluidity-harness.js']],
    ...['tabDragFollowsFinger', 'pageDragFollowsFinger', 'pageSlide', 'inputHistoryPerSession'].map(
      (name) => [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=' + name]],
    ),
  ],
  'draft-persistence': [run('harness:recovery'), run('harness:providers')],
  'fork-isolation': [
    [process.execPath, ['scripts/testing/fork-isolation-native-harness.js']],
    [process.execPath, ['scripts/testing/fork-isolation-native-harness.js', '--shared-daemon']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'rate-limit-prompt': [
    [process.execPath, ['scripts/testing/native-draft-harness.js']],
    [process.execPath, ['scripts/testing/codex-rate-limit-native-harness.js']],
    [process.execPath, ['scripts/testing/codex-rate-limit-harness.js']],
    run('harness:questions'),
    run('smoke:questions:native'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'native-composer': [
    [process.execPath, ['scripts/testing/native-composer-harness.js']],
    [process.execPath, ['scripts/testing/owned-command-native-harness.js']],
    [process.execPath, ['scripts/testing/codex-interaction-harness.js']],
    [process.execPath, ['scripts/testing/session-shortcuts-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'chat-fluidity': [
    [process.execPath, ['scripts/testing/chat-fluidity-harness.js']],
    ...[
      'longMessageEntry',
      'restoreScrollBeforePaint',
      'restoreLongHistory',
      'restoreUnavailableScroll',
      'atomicSessionEntry',
      'scrolling',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
    [process.execPath, ['scripts/testing/direct-connection-harness.js']],
  ],
  'terminal-ime-rollback': [
    'terminal-ime-harness',
    'terminal-continuous-render-harness',
    'mobile-terminal-input-harness',
    'presentation-harness',
  ]
    .map((name) => [process.execPath, ['scripts/testing/' + name + '.js']])
    .concat([
      [process.execPath, ['scripts/testing/mobile-keyboard-harness.js', '--bottom-anchor-only']],
      run('harness:recovery'),
      run('harness:providers'),
    ]),
  'terminal-input-performance': [
    'terminal-input-latency-harness',
    'terminal-history-interaction-harness',
    'terminal-continuity-harness',
    'terminal-continuous-render-harness',
    'terminal-ime-harness',
    'mobile-terminal-input-harness',
    'terminal-footer-stability-harness',
  ]
    .map((name) => [process.execPath, ['scripts/testing/' + name + '.js']])
    .concat([run('harness:recovery'), run('harness:providers')]),
  'terminal-footer-stability': [
    'terminal-footer-stability-harness',
    'terminal-footer-native-harness',
    'terminal-continuous-render-harness',
  ]
    .map((name) => [process.execPath, ['scripts/testing/' + name + '.js']])
    .concat([
      [process.execPath, ['scripts/testing/mobile-keyboard-harness.js', '--bottom-anchor-only']],
      run('harness:recovery'),
      run('harness:providers'),
    ]),
  'persistent-terminals': [
    [process.execPath, ['scripts/testing/terminal-channel-harness.js', '--multiplex']],
    ...[
      'terminal-continuity-harness',
      'terminal-ownership-harness',
      'terminal-ownership-browser-harness',
      'terminal-continuous-render-harness',
      'terminal-network-harness',
      'terminal-ime-harness',
      'mobile-terminal-input-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'terminal-channel': [
    [process.execPath, ['scripts/testing/terminal-channel-harness.js']],
    ...[
      'terminal-continuity-harness',
      'terminal-ownership-harness',
      'terminal-ownership-browser-harness',
      'terminal-continuous-render-harness',
      'terminal-network-harness',
      'terminal-ime-harness',
      'mobile-terminal-input-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'terminal-switch-latency': [
    [process.execPath, ['scripts/testing/terminal-switch-latency-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuity-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ownership-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
    [process.execPath, ['scripts/testing/terminal-network-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ime-harness.js']],
    [process.execPath, ['scripts/testing/mobile-keyboard-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'pending-inputs': [
    [process.execPath, ['scripts/testing/codex-pending-inputs-harness.js']],
    [process.execPath, ['scripts/testing/codex-pending-inputs-native-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'session-identity': [
    [
      process.execPath,
      ['scripts/testing/codex-active-session-native-harness.js', '--session-hook'],
    ],
    [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=automaticSessionAssociation'],
    ],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'message-navigation': [
    [process.execPath, ['scripts/testing/message-navigation-harness.js']],
    [process.execPath, ['scripts/testing/message-navigation-harness.js', '--performance']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'long-session': [
    [process.execPath, ['scripts/testing/long-session-benchmark.js']],
    [process.execPath, ['scripts/testing/long-session-browser-harness.js']],
    ...['tools', 'compactToolSpacing', 'scrolling', 'restoreLongHistory', 'atomicSessionEntry'].map(
      (name) => [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=' + name]],
    ),
    run('harness:structured'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'terminal-continuity': [
    [process.execPath, ['scripts/testing/terminal-continuity-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuity-native-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ownership-browser-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ownership-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
    [process.execPath, ['scripts/testing/terminal-network-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ime-harness.js']],
    [process.execPath, ['scripts/testing/mobile-keyboard-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'presentation-mode': [
    [process.execPath, ['scripts/testing/presentation-harness.js']],
    run('harness:shell'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'workspace-files': [
    [process.execPath, ['scripts/testing/workspace-files-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'codex-interaction': [
    ...[
      'codex-interaction-harness',
      'codex-question-harness',
      'session-shortcuts-harness',
      'goal-actions-harness',
      'command-input-harness',
      'session-interrupt-harness',
      'message-rewind-harness',
      'message-rewind-recovery-harness',
      'codex-question-native-harness',
      'goal-actions-native-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'interrupt-current-turn': [
    [
      process.execPath,
      [
        'scripts/testing/session-interrupt-harness.js',
        '--output=artifacts/testing/server-popover-width/interrupt-browser',
      ],
    ],
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=interrupt']],
    [process.execPath, ['scripts/testing/session-shortcuts-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'content-width': [
    [process.execPath, ['scripts/testing/presentation-harness.js']],
    run('harness:settings'),
    run('harness:shell'),
    ...['projectPanelWidth', 'desktopFilesPanel'].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'update-settings': [[process.execPath, ['scripts/testing/update-settings-harness.js']]],
  'settings-layout': [
    run('harness:settings-layout'),
    run('harness:settings'),
    run('harness:settings-save'),
    ...['deviceColors', 'sessionFilesAndRoot'].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'tool-presentation': [
    [process.execPath, ['scripts/testing/tool-presentation-harness.js']],
    ...['tools', 'compactToolSpacing', 'latestTool'].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'session-welcome': ['welcomeBranding', 'claudeWelcomeBeforeArchive'].map((name) => [
    process.execPath,
    ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
  ]),
  fast: [run('check'), [npm, ['test']]],
  'native-control': [
    [process.execPath, ['scripts/testing/codex-native-panels-native-harness.js']],
    [process.execPath, ['scripts/testing/codex-native-panels-harness.js']],
  ],
  'codex-runtime': [
    [process.execPath, ['scripts/testing/codex-runtime-harness.js']],
    [process.execPath, ['scripts/testing/busy-session-fork-native-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'files-back': [
    ...[
      'sessionFilesAlignment',
      'desktopFilesPanel',
      'projectPanelWidth',
      'cachedNavigationAndBack',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'context-compacted': [
    [process.execPath, ['scripts/testing/codex-compaction-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'archive-directory': [
    [process.execPath, ['scripts/testing/codex-archive-directory-harness.js']],
    [process.execPath, ['scripts/testing/codex-active-session-native-harness.js']],
    [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=automaticSessionAssociation'],
    ],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'mobile-input-history': [
    [process.execPath, ['scripts/testing/mobile-input-history-harness.js']],
    [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=inputHistoryPerSession'],
    ],
    [process.execPath, ['scripts/testing/composer-height-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'sidebar-state': [
    [process.execPath, ['scripts/testing/sidebar-navigation-harness.js']],
    [process.execPath, ['scripts/testing/workspace-files-harness.js']],
    [process.execPath, ['scripts/testing/sidebar-state-harness.js']],
    ...[
      'sidebarSwipeHistory',
      'sidebarToggleLivesOnSidebar',
      'sidebarRecencyAndNames',
      'archiveListRecovery',
      'pageDragFollowsFinger',
      'tabDragFollowsFinger',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:settings'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'message-rewind': [
    [process.execPath, ['scripts/testing/message-rewind-harness.js']],
    [process.execPath, ['scripts/testing/message-rewind-recovery-harness.js']],
    [process.execPath, ['scripts/testing/message-rewind-native-harness.js']],
    [process.execPath, ['scripts/testing/message-rewind-http-native-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'composer-height': [
    [process.execPath, ['scripts/testing/composer-height-harness.js']],
    [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=inputHistoryPerSession'],
    ],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'terminal-ownership': [
    [process.execPath, ['scripts/testing/terminal-ownership-browser-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ownership-harness.js']],
  ],
  'terminal-size-stability': [
    [process.execPath, ['scripts/testing/terminal-ownership-browser-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ownership-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'transcript-terminal': [
    [process.execPath, ['scripts/testing/terminal-render-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
    [process.execPath, ['scripts/testing/transcript-terminal-harness.js']],
    [process.execPath, ['scripts/testing/codex-active-session-native-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'entry-latest': [
    ...[
      'longMessageEntry',
      'restoreScrollBeforePaint',
      'restoreLongHistory',
      'restoreUnavailableScroll',
      'atomicSessionEntry',
      'scrolling',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'agent-tab-order': [[process.execPath, ['scripts/testing/agent-tab-order-harness.js']]],
  'command-success': [
    [process.execPath, ['scripts/testing/command-input-harness.js']],
    [process.execPath, ['scripts/testing/command-success-harness.js']],
    [process.execPath, ['scripts/testing/command-success-native-harness.js']],
    ...[
      'compactComposerAndCommands',
      'settingsActionsAndSkills',
      'localCommandLatency',
      'nativeCommandRecovery',
      'commandReceipt',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
  ],
  'goal-actions': [
    [process.execPath, ['scripts/testing/goal-actions-harness.js']],
    [process.execPath, ['scripts/testing/goal-actions-native-harness.js']],
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=goalStatus']],
  ],
  'session-shortcuts': [
    [process.execPath, ['scripts/testing/session-shortcuts-harness.js']],
    [process.execPath, ['scripts/testing/session-shortcuts-native-harness.js']],
  ],
  'terminal-ime': [[process.execPath, ['scripts/testing/terminal-ime-harness.js']]],
  'terminal-ui-font': [
    [process.execPath, ['scripts/testing/terminal-ui-font-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ime-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
  ],
  'terminal-graphics': [
    [process.execPath, ['scripts/testing/terminal-graphics-harness.js']],
    [process.execPath, ['scripts/testing/terminal-ui-font-harness.js']],
    [process.execPath, ['scripts/testing/terminal-continuous-render-harness.js']],
    ...(process.env.SWIFT_WINDOWS_RUNTIME_BIN
      ? [
          [
            process.execPath,
            [
              'scripts/testing/herdr-runtime-state-probe.js',
              process.env.SWIFT_WINDOWS_RUNTIME_BIN,
              'artifacts/testing/terminal-home-rendering/native-state',
            ],
          ],
        ]
      : []),
  ],
  'mobile-terminal': [
    ...[
      'mobile-terminal-input-harness',
      'code-wrap-harness',
      'terminal-ui-font-harness',
      'terminal-ime-harness',
      'terminal-continuous-render-harness',
      'terminal-network-harness',
      'terminal-ownership-harness',
      'terminal-ownership-browser-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'mobile-keyboard': ['mobile-keyboard-harness', 'terminal-viewport-native-harness'].map((name) => [
    process.execPath,
    ['scripts/testing/' + name + '.js'],
  ]),
  'terminal-network': [
    ...[
      'terminal-network-harness',
      'terminal-ownership-harness',
      'terminal-ownership-browser-harness',
      'native-tabs-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=connectionStatus']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'context-menu': [
    [process.execPath, ['scripts/testing/context-creation-harness.js']],
    [process.execPath, ['scripts/testing/herdr-design-harness.js', '--native-only']],
  ],
  'session-fork': [
    [process.execPath, ['scripts/testing/session-fork-harness.js']],
    [process.execPath, ['scripts/testing/native-view-harness.js']],
    [process.execPath, ['scripts/testing/session-interrupt-harness.js']],
    [process.execPath, ['scripts/testing/native-command-harness.js', '--menu-fork']],
    [process.execPath, ['scripts/testing/tab-only-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'space-actions': [
    [process.execPath, ['scripts/testing/space-actions-harness.js']],
    [process.execPath, ['scripts/testing/agent-restart-harness.js']],
    [process.execPath, ['scripts/testing/space-actions-native-harness.js']],
  ],
  'html-preview': [[process.execPath, ['scripts/testing/html-preview-harness.js']]],
  'session-media': [
    [process.execPath, ['scripts/testing/session-media-harness.js']],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  questions: [run('harness:questions'), run('smoke:questions:native')],
  'side-unified': [
    [process.execPath, ['scripts/testing/side-session-unification-harness.js']],
    [process.execPath, ['scripts/testing/codex-side-native-harness.js', '--unified']],
    [process.execPath, ['scripts/testing/fork-isolation-native-harness.js', '--side']],
    [
      process.execPath,
      ['scripts/testing/fork-isolation-native-harness.js', '--side', '--shared-daemon'],
    ],
    run('harness:recovery'),
    run('harness:providers'),
  ],
  side: [
    [process.execPath, ['scripts/testing/codex-side-harness.js']],
    [process.execPath, ['scripts/testing/codex-side-native-harness.js']],
    [process.execPath, ['scripts/testing/codex-side-native-harness.js', '--effort=high']],
    run('smoke:questions:native'),
  ],
  'native-state-recovery': [
    [process.execPath, ['scripts/testing/native-state-recovery-native-harness.js']],
    ...[
      'httpFailure',
      'durableRetry',
      'directMessageHandoff',
      'draftsModelsMenus',
      'atomicSessionEntry',
      'unifiedNotices',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
  ],
  'native-status': [
    ...['nativeContextCompaction', 'nativeGoalStatus'].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
  ],
  'statusbar-layout': [
    ...[
      'session-statusbar-harness',
      'session-statusbar-native-harness',
      'native-tabs-harness',
      'codex-interaction-harness',
    ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=localCommandLatency']],
  ],
  'native-statusbar': [
    'session-statusbar-harness',
    'status-account-native-harness',
    'session-shortcuts-harness',
    'codex-interaction-harness',
    'mobile-keyboard-harness',
  ]
    .map((name) => [process.execPath, ['scripts/testing/' + name + '.js']])
    .concat([run('harness:recovery'), run('harness:providers')]),
  'compact-statusbar': ['session-statusbar-harness', 'mobile-keyboard-harness'].map((name) => [
    process.execPath,
    ['scripts/testing/' + name + '.js'],
  ]),
  'desktop-status-actions': [
    [process.execPath, ['scripts/testing/session-statusbar-harness.js']],
    [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=goalStatus']],
  ],
  'session-statusbar': [
    [process.execPath, ['scripts/testing/session-statusbar-harness.js']],
    [process.execPath, ['scripts/testing/session-statusbar-native-harness.js']],
    ...[
      'nativeScrollIntent',
      'nativeFocusSynchronization',
      'observeSelectedTerminal',
      'activityDoesNotExposeToolArguments',
      'fullStatus',
      'activityClockAfterNative',
      'commandActivity',
      'activitySecondsFormat',
      'stableActivity',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
  ],
  // Public CI uses self-contained fixtures. Native Herdr cases have separate lanes.
  browser: [
    ...[
      'frontend',
      'settings',
      'settings-save',
      'mermaid',
      'structured',
      'shell',
      'questions',
      'downloads',
      'renderers',
      'recovery',
      'providers',
      'token',
      'network',
    ].map((name) => run(`harness:${name}`)),
    ...[
      'tools',
      'scrolling',
      'nativeFocusSynchronization',
      'inputHistoryPerSession',
      'bootFromCache',
    ].map((name) => [
      process.execPath,
      ['scripts/testing/chat-harness.js', '--run', '--case=' + name],
    ]),
    [process.execPath, ['scripts/testing/native-tabs-harness.js']],
  ],
  'chat-full': [run('harness:chat')],
  'tab-only': [
    [process.execPath, ['scripts/testing/tab-only-harness.js']],
    [process.execPath, ['scripts/testing/context-creation-harness.js']],
    [process.execPath, ['scripts/testing/native-tabs-harness.js']],
    [process.execPath, ['scripts/testing/herdr-design-harness.js', '--native-only']],
    [process.execPath, ['scripts/testing/native-command-harness.js', '--hfork']],
    run('harness:shell'),
    run('harness:recovery'),
    run('harness:providers'),
  ],
  'tab-motion': [[process.execPath, ['scripts/testing/tab-motion-harness.js']]],
  'native-tabs': [
    [process.execPath, ['scripts/testing/native-tabs-harness.js']],
    [process.execPath, ['scripts/testing/herdr-ui-harness.js']],
    [process.execPath, ['scripts/testing/herdr-design-harness.js']],
  ],
  'terminal-preview': [
    [process.execPath, ['scripts/testing/presentation-harness.js']],
    run('harness:terminal-preview'),
    [process.execPath, ['scripts/testing/terminal-native-interaction-harness.js']],
  ],
  android: [
    [
      process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
      [
        'testChatDebugUnitTest',
        'testTerminalDebugUnitTest',
        'assembleChatRelease',
        'assembleTerminalRelease',
        'lintChatRelease',
        'lintTerminalRelease',
      ],
      'android',
    ],
    [process.execPath, ['scripts/release/verify-android-apks.js']],
  ],
  'android-debug': [
    [
      process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
      [
        'testChatDebugUnitTest',
        'testTerminalDebugUnitTest',
        'assembleChatDebug',
        'assembleTerminalDebug',
        'lintChatDebug',
        'lintTerminalDebug',
      ],
      'android',
    ],
  ],
  'desktop-ci': [run('desktop:test'), [npm, ['run', 'desktop:build', '--', '--no-bundle']]],
  desktop: [
    run('desktop:test'),
    run('harness:desktop'),
    [process.execPath, ['scripts/testing/desktop-close-harness.js']],
    [process.execPath, ['scripts/testing/desktop-multi-window-harness.js']],
    run('desktop:build'),
    [process.execPath, ['scripts/release/verify-desktop-package.js']],
  ],
  windows: [run('harness:desktop:windows')],
  install: [run('smoke:install')],
};
lanes['busy-session-fork'] = lanes['session-fork'];
lanes['statusbar-typography'] = [
  ...lanes['compact-statusbar'],
  ...['terminal-ui-font-harness', 'frontend-harness'].map((name) => [
    process.execPath,
    ['scripts/testing/' + name + '.js'],
  ]),
];
lanes['statusbar-recovery'] = [
  ...lanes['native-statusbar'],
  ...[
    'owned-command-native-harness',
    'terminal-tall-viewport-harness',
    'terminal-tall-viewport-native-harness',
    'frontend-harness',
    'mobile-input-history-harness',
    'mobile-terminal-input-harness',
  ].map((name) => [process.execPath, ['scripts/testing/' + name + '.js']]),
  [process.execPath, ['scripts/testing/chat-harness.js', '--run', '--case=interrupt']],
];
lanes['mobile-keyboard'].push(...lanes['mobile-terminal']);
// Recheck the remaining browser suites when the primary chat/renderer suites
// already have retained evidence for identical application sources.
lanes['browser-secondary'] = lanes.browser.slice(5);
const requested = process.argv.slice(2);
if (requested.includes('--help') || requested.includes('--list')) {
  console.log(
    'Usage: npm run validate -- <environment...>\n\n' + Object.keys(lanes).sort().join('\n'),
  );
  process.exit(0);
}
const selected = requested.length
  ? requested.includes('all')
    ? ['fast', 'browser', 'android', 'desktop', 'windows', 'install']
    : requested
  : ['fast'];
if (selected.some((name) => !lanes[name]))
  throw new Error(`Validation lanes: ${Object.keys(lanes).join(', ')}, all`);
const output = path.join(root, 'artifacts/validation');
fs.mkdirSync(output, { recursive: true });
const timeoutMs = Number(process.env.SWIFT_VALIDATION_TIMEOUT_MS || 1800000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid validation timeout.');
async function step(command, args, cwd, logFile) {
  const log = fs.createWriteStream(logFile);
  const started = Date.now();
  let timedOut = false,
    error = null,
    forceTimer;
  const child = spawn(command, args, {
    cwd: path.join(root, cwd || ''),
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/.test(command),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => log.write(data));
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32')
      require('node:child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      forceTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 2000);
    }
  }, timeoutMs);
  child.on('error', (value) => {
    error = value.message;
  });
  const [exitCode, signal] = await new Promise((resolve) =>
    child.on('close', (...values) => resolve(values)),
  );
  clearTimeout(timer);
  clearTimeout(forceTimer);
  await new Promise((resolve) => log.end(resolve));
  return {
    command: [command, ...args].join(' '),
    exitCode,
    signal,
    timedOut,
    error,
    durationMs: Date.now() - started,
    log: path.relative(root, logFile),
  };
}
(async () => {
  const reports = [];
  for (const lane of selected) {
    const before = sourceFingerprint(root),
      steps = [];
    for (const [index, [command, args, cwd]] of lanes[lane].entries()) {
      console.log(`[${lane}] ${index + 1}/${lanes[lane].length}: ${command} ${args.join(' ')}`);
      const result = await step(command, args, cwd, path.join(output, `${lane}-${index + 1}.log`));
      steps.push(result);
      console.log(
        `[${lane}] ${result.exitCode === 0 && !result.timedOut ? 'PASS' : 'FAIL'} (${Math.round(result.durationMs / 1000)}s), ${result.log}`,
      );
      if (result.error || result.timedOut || result.exitCode !== 0) break;
    }
    const after = sourceFingerprint(root);
    const report = {
      lane,
      at: new Date().toISOString(),
      before,
      after,
      ok:
        steps.length === lanes[lane].length &&
        steps.every((s) => s.exitCode === 0 && !s.error && !s.timedOut) &&
        before.treeSha256 === after.treeSha256,
      steps,
    };
    fs.writeFileSync(path.join(output, `${lane}.json`), JSON.stringify(report, null, 2) + '\n');
    reports.push(report);
  }
  const summary = {
    at: new Date().toISOString(),
    requested: selected,
    ok: reports.every((r) => r.ok),
    reports: reports.map(({ lane, ok, before, after }) => ({ lane, ok, before, after })),
  };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (!summary.ok) process.exitCode = 1;
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
