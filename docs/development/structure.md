# 目录说明

```text
swift/
├── bin/                       Swift 命令行入口
├── server.js                  服务器装配与生命周期
├── lib/                       服务器业务、原生适配与存储
│   ├── http/                  认证、静态资源、路由与响应
│   ├── providers/             原生存档提供方
│   ├── questions/             原生问答适配与收据
│   ├── store/                 SQLite、迁移与投递记录
│   └── sync/                  快照、增量与订阅
├── public/                    网页与客户端共用的界面
│   ├── chat/                  聊天、终端、输入与会话状态
│   ├── core/                  连接、缓存与同步
│   ├── files/                 目录树、阅读与编辑
│   ├── nav/                   导航、菜单与手势
│   ├── renderers/             按提供方独立渲染
│   └── vendor/                固定第三方资源及许可证
├── desktop/                   Rust 核心、Tauri 外壳和连接界面
├── android/                   会话版、原生终端版与共享连接实现
├── shared/                    协议类型、能力定义与固定 schema
├── runtime/                   Herdr 与 Codex 的来源、构建和管理
├── deploy/                    安装器、服务模板与预览组件
├── scripts/
│   ├── build/                 资源与类型生成、桌面构建
│   ├── check/                 检查、隔离测试和验证调度
│   ├── lib/                   开发工具共用的源码指纹
│   ├── release/               打包与签名核验
│   └── testing/               浏览器、PTY、Windows 与诊断夹具
├── test/                      自动化测试与合成记录
├── third_party/               改编材料的原始来源和许可
└── docs/                      使用、开发与架构说明
```

`node_modules/`、`artifacts/`、`.local/`、`desktop/dist/`、`desktop/target/` 和 Android 构建目录均为本地生成或私有内容，不属于源码。

## 依赖方向

接口装配调用业务能力，业务通过提供方和运行时适配读取原生事实，存储保存派生投影与操作收据。客户端通过 HTTP/WebSocket 消费状态，不直接读写服务器私有配置或原生存档。

`public/` 是浏览器与原生客户端共享的业务界面；`desktop/ui/` 仅扩展本地连接和系统能力。Android `src/chat` 与 `src/terminal` 不互相引用，共享连接位于 `src/connection`。

## 生成文件

| 来源                       | 命令                           | 生成内容                   |
| -------------------------- | ------------------------------ | -------------------------- |
| `shared/*.ts`              | `npm run generate:shared`      | 浏览器可用的能力与同步实现 |
| `shared/herdr-schema.json` | `npm run generate:types`       | 提供方使用的协议类型       |
| 固定 npm 终端包与本地补丁  | `npm run generate:terminal`    | `public/vendor/xterm/`     |
| 文件模块源码               | `npm run check` 中的一致性检查 | 文件浏览的派生实现         |
| `public/` 和 `desktop/ui/` | `npm run desktop:prepare`      | 忽略的 `desktop/dist/`     |

第三方、生成文件和补丁使用各自的生成或更新流程。默认格式化只覆盖本项目维护的源文件。
