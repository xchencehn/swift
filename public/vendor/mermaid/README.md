# Mermaid

`mermaid.min.js` is the unmodified standalone browser build from the npm package
`mermaid@12.0.0` (`dist/mermaid.min.js`). Its license is included in `LICENSE`.

Source: https://github.com/mermaid-js/mermaid/tree/mermaid%4012.0.0
Package: https://registry.npmjs.org/mermaid/-/mermaid-12.0.0.tgz
API and security configuration: https://mermaid.js.org/config/usage.html

The chat loads this local bundle on demand. No diagram content is sent to a
remote renderer. `public/diagrams.js` keeps Mermaid in strict mode and displays
the resulting SVG as an image, while preserving the original code block.
