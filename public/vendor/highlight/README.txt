highlight.js 11.11.1
Source: https://www.npmjs.com/package/@highlightjs/cdn-assets/v/11.11.1
Upstream: https://github.com/highlightjs/highlight.js
License: BSD-3-Clause (see LICENSE)
highlight.min.js = 包里的 highlight.min.js（常用语言集）后面依次接上 languages/ 下的
dos（.bat/.cmd）、powershell、dockerfile、cmake、protobuf 五个 .min.js，内容未改动。
只在会话文件面板打开代码文件时按需加载（public/files/code-view.js），不进首屏。
配色不用它自带的样式表，由 public/device-theme.js 的 syn-* 颜色随主题给出。
