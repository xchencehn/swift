# Cascadia Mono

Source: Microsoft Cascadia Code release [v2407.24](https://github.com/microsoft/cascadia-code/releases/tag/v2407.24).
Font metadata: Version 2407.024. Family: Cascadia Mono. Variable weight axis: 200–700.

The complete regular and italic variable TTF fonts were converted to WOFF2 with FontTools; no glyphs were removed and the family name remains Cascadia Mono. The SIL Open Font License 1.1 and copyright notice are in LICENSE. The reserved name in that license is Cascadia Code; these fonts use Cascadia Mono.

Reproduce from the corresponding release TTF files with FontTools:

```python
from fontTools.ttLib import TTFont
for name in ["CascadiaMono", "CascadiaMonoItalic"]:
    font = TTFont(name + ".ttf")
    font.flavor = "woff2"
    font.save(name + ".woff2")
```

- `CascadiaMono.woff2`: SHA-256 `9ea76154a76efe0c9f2a5a21e7e94dd2d99b9cc42a50d563ab7d53753ab81b14`; source TTF SHA-256 `08026f617eea315caca59898784e999f6cdb2d0c34d2040deeb042bcdc359fa2`.
- `CascadiaMonoItalic.woff2`: SHA-256 `93966cae5a3b66dc7cb9da238e00ab6c5f3923c37356949c7a7d8914f64c187b`; source TTF SHA-256 `d9d23dfb03c6844448a24cf0337a657ac99965262874d2e6fb5b82ac0ac08c4d`.
